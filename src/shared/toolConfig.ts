import type { ToolMeta } from './types';

const DEFAULT_ICON = '▣';

// Accepts an array or comma/newline-separated string of commands (the latter is
// how it reads naturally when hand-editing tool.json). Blank entries dropped.
function parseInitCommands(raw: unknown): string[] | undefined {
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    list = raw.split(/\r?\n|,/).map((s) => s.trim());
  } else {
    return undefined;
  }
  const cmds = list
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((s) => s.length > 0);
  return cmds.length > 0 ? cmds : undefined;
}

export function parseToolMeta(raw: unknown, id: string): ToolMeta {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;
  const icon = typeof o.icon === 'string' && o.icon ? o.icon : DEFAULT_ICON;
  const orderNum = Number(o.order);
  const order = Number.isFinite(orderNum) ? orderNum : 0;
  const meta: ToolMeta = { id, name, icon, order };
  if (typeof o.cwd === 'string' && o.cwd.trim()) meta.cwd = o.cwd.trim();
  if (typeof o.rootDir === 'string' && o.rootDir.trim()) meta.rootDir = o.rootDir.trim();
  if (typeof o.shell === 'string' && o.shell.trim()) meta.shell = o.shell.trim();
  if (o.env && typeof o.env === 'object') meta.env = o.env as Record<string, string>;
  if (typeof o.tmux === 'string' && o.tmux.trim()) meta.tmux = o.tmux.trim();
  const init = parseInitCommands(o.initCommands);
  if (init) meta.initCommands = init;
  if (typeof o.mdUrl === 'string' && o.mdUrl.trim()) meta.mdUrl = o.mdUrl.trim();
  if (typeof o.autoUpdateMinutes === 'number' && Number.isFinite(o.autoUpdateMinutes)) {
    meta.autoUpdateMinutes = o.autoUpdateMinutes;
  }
  if (o.useRemote === true) meta.useRemote = true;
  if (typeof o.sourceId === 'string' && o.sourceId.trim()) meta.sourceId = o.sourceId.trim();
  if (typeof o.group === 'string' && o.group.trim()) meta.group = o.group.trim();
  if (o.layout === 'LR' || o.layout === 'TB') {
    meta.layout = o.layout;
  }
  if (typeof o.terminalHidden === 'boolean') {
    meta.terminalHidden = o.terminalHidden;
  }
  return meta;
}
