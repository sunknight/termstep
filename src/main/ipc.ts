import { ipcMain, shell, dialog, BrowserWindow, clipboard } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PtyService } from './ptyService';
import { ToolManager } from './toolManager';
import { parseToolMeta } from '../shared/toolConfig';
import { serializeTools, parseToolsBundle } from '../shared/bundle';
import { mergeToolJson } from '../shared/toolJson';
import { buildButtonsAppend } from '../shared/buttonBlock';
import { fetchRemoteMarkdown } from './toolsScanner';
import { liveCwd } from './cwd';
import * as updater from './updater';
import { IPC, type ToolMeta, type PtySpawnOpts } from '../shared/types';

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'tool';
}

// Default markdown for the quick-commands file on first run / when missing.
const DEFAULT_QUICK_MD = [
  '# 快捷命令',
  '',
  '这些按钮出现在终端标题栏的全局下拉中，可在任意工具的终端执行。点「编辑」修改：',
  '',
  '```buttons',
  'pwd # 当前目录',
  'ls -la # 列出文件',
  'clear # 清屏',
  '```',
  '',
].join('\n');

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

// Pick a window to parent dialogs on: the focused one, else the first that exists.
function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

// Branch on whether we have a parent window so TS picks the right dialog overload.
async function saveDialog(opts: Electron.SaveDialogOptions) {
  const win = parentWindow();
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts);
}
async function openDialog(opts: Electron.OpenDialogOptions) {
  const win = parentWindow();
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}

// First free directory id under toolsDir for the given base name (suffix -2, -3…).
// Import never overwrites an existing tool — lossless by design.
async function uniqueId(toolsDir: string, baseRaw: string): Promise<string> {
  const base = slugify(baseRaw) || 'tool';
  let id = base;
  let n = 2;
  while (true) {
    try {
      await fs.access(path.join(toolsDir, id));
      id = `${base}-${n++}`;
    } catch {
      break;
    }
  }
  return id;
}

export function registerIpc(deps: {
  toolsDir: string;
  toolManager: ToolManager;
  ptyService: PtyService;
}) {
  const { toolsDir, toolManager, ptyService } = deps;

  ipcMain.handle(IPC.TOOLS_LIST, () => toolManager.scan());

  ipcMain.handle(IPC.PTY_WRITE, (_e, toolId: string, data: string, opts?: PtySpawnOpts) => {
    ptyService.write(toolId, data, opts ?? {});
  });
  ipcMain.handle(IPC.PTY_OPEN, (_e, toolId: string, opts?: PtySpawnOpts) => {
    ptyService.open(toolId, opts ?? {});
  });
  ipcMain.handle(IPC.PTY_RESTART, (_e, toolId: string, opts?: PtySpawnOpts) => {
    ptyService.restart(toolId, opts ?? {});
  });
  ipcMain.handle(IPC.PTY_RESIZE, (_e, toolId: string, cols: number, rows: number) => {
    ptyService.resize(toolId, cols, rows);
  });
  // Live cwd of a tool's shell, resolved from the OS (follows the user's cd).
  // Falls back to the initial cwd (or ~) when the pid can't be read.
  ipcMain.handle(IPC.PTY_CWD, async (_e, toolId: string) => {
    const cwd = await liveCwd(ptyService.pidOf(toolId));
    if (cwd) return cwd;
    const t = (await toolManager.scan()).tools.find((x) => x.meta.id === toolId);
    return t?.meta.cwd ?? os.homedir();
  });
  ipcMain.handle(IPC.PTY_KILL, (_e, toolId: string) => {
    ptyService.kill(toolId);
  });

  ipcMain.handle(
    IPC.TOOL_SAVE,
    async (_e, toolId: string, markdown: string, metaPatch: Partial<ToolMeta>) => {
      const dir = path.join(toolsDir, toolId);
      const existing = await readJson(path.join(dir, 'tool.json'));
      const merged = mergeToolJson(existing, metaPatch as Record<string, unknown>);
      await fs.writeFile(path.join(dir, 'tool.json'), JSON.stringify(merged, null, 2) + '\n');
      await fs.writeFile(path.join(dir, 'help.md'), markdown);
      // chokidar picks up the change -> tools:changed
    }
  );

  // Quick-add "+" (local mode): append `body` as a new ```buttons fence to the
  // end of help.md. Reads help.md fresh (no stale renderer copy), normalizes via
  // buildButtonsAppend, writes back only when something actually changed. Never
  // touches tool.json — meta stays intact.
  ipcMain.handle(IPC.TOOL_APPEND_BUTTONS, async (_e, toolId: string, body: string) => {
    const file = path.join(toolsDir, toolId, 'help.md');
    let cur = '';
    try {
      cur = await fs.readFile(file, 'utf8');
    } catch {
      // missing help.md -> treat as empty (equivalent to a first write)
    }
    const next = buildButtonsAppend(cur, typeof body === 'string' ? body : '');
    if (next === cur) return; // empty body -> no-op, skip the write + rescan
    await fs.writeFile(file, next);
    // chokidar picks up the change -> tools:changed
  });

  ipcMain.handle(IPC.TOOL_CREATE, async (_e, name: string): Promise<string> => {
    const base = slugify(name);
    let id = base;
    let n = 2;
    while (true) {
      try {
        await fs.access(path.join(toolsDir, id));
        id = `${base}-${n++}`;
      } catch {
        break;
      }
    }
    const dir = path.join(toolsDir, id);
    await fs.mkdir(dir, { recursive: true });
    const meta = parseToolMeta({ name, icon: '★' }, id);
    await fs.writeFile(
      path.join(dir, 'tool.json'),
      JSON.stringify({ name: meta.name, icon: meta.icon, order: 999 }, null, 2) + '\n'
    );
    // Starter help.md: a single working `ls` button plus a full buttons /
    // buttons-json syntax reference written as `#` line comments inside the
    // fence. Comments don't render, so the help page stays clean — the user
    // discovers the reference by clicking 编辑. (No literal ``` inside comment
    // lines, to keep the fence parser unambiguous.)
    await fs.writeFile(
      path.join(dir, 'help.md'),
      [
        `# ${meta.name}`,
        '',
        '点击按钮运行命令。buttons / buttons-json 的完整语法写在下面这个 buttons 块的注释里（点「编辑」即可看到）。',
        '',
        '```buttons',
        '# ── buttons 语法（每行一条命令）──',
        '# 命令                 → 生成一个按钮，按钮文字 = 命令本身',
        'ls',
        '# 命令 # 标签          → 按钮显示「标签」，运行时执行「命令」',
        '# 命令 // edit         → 只粘贴到终端、不自动回车（编辑模式）',
        '# 命令 # 标签 // edit  → 带标签的编辑模式',
        '# // 文字              → 行首以 // 开头：渲染为一段可见纯文本',
        '# # 文字               → 行首以 # 开头：注释，只留在源码、不渲染（这些行就是）',
        '# 空行                 → 跳过',
        '',
        '# ── buttons-json 语法（带参数的按钮）──',
        '# 把围栏名 buttons 改成 buttons-json，内容是 JSON 对象或数组，每项可用字段：',
        '#   command（必填）   label   edit   params',
        '# params 每项：name（必填）   required   default   hint   options',
        '# command 里写 {{参数名}} 占位；点按钮时弹表单收集，值做 POSIX shell 转义后代入',
        '# 示例（去掉下面这行开头的 #，放进 buttons-json 围栏即可用）：',
        '# {"command":"git commit -m {{msg}}","label":"提交","params":[{"name":"msg","required":true}]}',
        '```',
        '',
      ].join('\n')
    );
    return id;
  });

  ipcMain.handle(IPC.TOOL_DELETE, async (_e, toolId: string) => {
    ptyService.kill(toolId);
    await fs.rm(path.join(toolsDir, toolId), { recursive: true, force: true });
  });

  ipcMain.handle(IPC.TOOL_REORDER, async (_e, orderedIds: string[]) => {
    for (let i = 0; i < orderedIds.length; i++) {
      const file = path.join(toolsDir, orderedIds[i], 'tool.json');
      const o = await readJson(file);
      o.order = i;
      await fs.writeFile(file, JSON.stringify(o, null, 2) + '\n');
    }
  });

  // Open an http(s)/mailto link in the user's default browser. Markdown help
  // links route through here so they don't try to navigate the renderer itself.
  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_e, url: string) => {
    if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) {
      await shell.openExternal(url);
    }
  });

  // Clipboard lives in the MAIN process: the renderer's preload is sandboxed
  // (Electron 20+ default), where require('electron') omits `clipboard`. So the
  // renderer asks the main process to read/write the system clipboard over IPC.
  // Used by terminal copy/paste, copy-on-select, OSC 52, and quick-add prefill.
  ipcMain.handle(IPC.CLIPBOARD_READ, () => clipboard.readText());
  ipcMain.handle(IPC.CLIPBOARD_WRITE, (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : '');
  });

  // Force a fresh scan (re-fetches all mdUrl tools). Backs the per-tool "重新读取"
  // button on the help view.
  ipcMain.handle(IPC.TOOL_REFRESH_MD, async () => {
    await toolManager.refresh();
  });

  // Preview-fetch a single URL and return its markdown, WITHOUT writing anything.
  // Used by the editor's "重新读取" so a draft URL can be previewed before saving;
  // after save the normal scan re-fetches the persisted URL.
  ipcMain.handle(IPC.MD_FETCH_PREVIEW, async (_e, url: string) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { markdown: '', error: 'URL 为空' };
    }
    const r = await fetchRemoteMarkdown(url.trim());
    return { markdown: r.markdown, error: r.error ?? null };
  });

  ipcMain.handle(IPC.TOOLS_EXPORT, async () => {
    const scan = await toolManager.scan();
    const bundle = serializeTools(scan.tools, new Date().toISOString());
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await saveDialog({
      title: '导出工具',
      defaultPath: `termstep-tools-${stamp}.json`,
      filters: [{ name: 'TermStep 工具包', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true as const };
    await fs.writeFile(res.filePath, JSON.stringify(bundle, null, 2) + '\n');
    return { canceled: false as const, path: res.filePath, count: scan.tools.length };
  });

  ipcMain.handle(IPC.TOOL_EXPORT_ONE, async (_e, toolId: string) => {
    const scan = await toolManager.scan();
    const tool = scan.tools.find((t) => t.meta.id === toolId);
    if (!tool) return { canceled: false as const, count: 0, error: '未找到该工具' };
    const bundle = serializeTools([tool], new Date().toISOString());
    const name = slugify(tool.meta.name) || tool.meta.id;
    const res = await saveDialog({
      title: '导出工具',
      defaultPath: `termstep-${name}.json`,
      filters: [{ name: 'TermStep 工具包', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true as const };
    await fs.writeFile(res.filePath, JSON.stringify(bundle, null, 2) + '\n');
    return { canceled: false as const, path: res.filePath, count: 1 };
  });

  ipcMain.handle(IPC.TOOLS_IMPORT, async () => {
    const res = await openDialog({
      title: '导入工具',
      filters: [{ name: 'TermStep 工具包', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return { canceled: true as const };
    let raw: string;
    try {
      raw = await fs.readFile(res.filePaths[0], 'utf8');
    } catch (e) {
      return { canceled: false as const, count: 0, error: `读取文件失败: ${(e as Error).message}` };
    }
    const parsed = parseToolsBundle(raw);
    if (parsed.error) return { canceled: false as const, count: 0, error: parsed.error };
    let count = 0;
    for (const t of parsed.tools) {
      const id = await uniqueId(toolsDir, t.meta.id);
      const dir = path.join(toolsDir, id);
      await fs.mkdir(dir, { recursive: true });
      const meta = stripUndefined({ ...t.meta, id }) as Record<string, unknown>;
      // The id lives in the directory name; drop it from the persisted json so
      // there's no risk of it drifting from the dir.
      delete meta.id;
      await fs.writeFile(path.join(dir, 'tool.json'), JSON.stringify(meta, null, 2) + '\n');
      await fs.writeFile(path.join(dir, 'help.md'), t.helpMarkdown);
      count++;
    }
    return { canceled: false as const, count };
  });

  // Quick commands are stored as a single markdown file (<userData>/quick-commands.md)
  // whose `buttons` blocks back the global dropdown — NOT as a tool.
  const quickFile = path.resolve(toolsDir, '..', 'quick-commands.md');
  ipcMain.handle(IPC.QUICK_GET, async () => {
    try {
      return await fs.readFile(quickFile, 'utf8');
    } catch {
      return DEFAULT_QUICK_MD;
    }
  });
  ipcMain.handle(IPC.QUICK_SAVE, async (_e, md: string) => {
    await fs.writeFile(quickFile, typeof md === 'string' ? md : '');
  });

  // Manual update check (from the sidebar badge "再检查一次" button). Returns the
  // resulting UpdateState; the renderer's hook picks it up via the UPDATE_STATE
  // broadcast wired in index.ts.
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    return updater.checkForUpdates({ manual: true });
  });
}
