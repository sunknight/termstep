import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PtyService } from './ptyService';
import { ToolManager } from './toolManager';
import { parseToolMeta } from '../shared/toolConfig';
import { IPC, type ToolMeta, type PtySpawnOpts } from '../shared/types';

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'tool';
}

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
  ipcMain.handle(IPC.PTY_KILL, (_e, toolId: string) => {
    ptyService.kill(toolId);
  });

  ipcMain.handle(
    IPC.TOOL_SAVE,
    async (_e, toolId: string, markdown: string, metaPatch: Partial<ToolMeta>) => {
      const dir = path.join(toolsDir, toolId);
      const existing = await readJson(path.join(dir, 'tool.json'));
      const merged = stripUndefined({ ...existing, ...metaPatch });
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
}
