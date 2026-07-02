import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PtyService } from './ptyService';
import { ToolManager } from './toolManager';
import { parseToolMeta } from '../shared/toolConfig';
import { serializeTools, parseToolsBundle } from '../shared/bundle';
import { mergeToolJson } from '../shared/toolJson';
import { fetchRemoteMarkdown } from './toolsScanner';
import { liveCwd } from './cwd';
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
    await fs.writeFile(
      path.join(dir, 'help.md'),
      `# ${meta.name}\n\n点击按钮运行：\n\n\`\`\`buttons\nls\n\`\`\`\n`
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
}
