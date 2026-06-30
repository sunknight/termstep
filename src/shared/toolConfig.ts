import type { ToolMeta } from './types';

const DEFAULT_ICON = '▣';

export function parseToolMeta(raw: unknown, id: string): ToolMeta {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;
  const icon = typeof o.icon === 'string' && o.icon ? o.icon : DEFAULT_ICON;
  const orderNum = Number(o.order);
  const order = Number.isFinite(orderNum) ? orderNum : 0;
  const meta: ToolMeta = { id, name, icon, order };
  if (typeof o.cwd === 'string' && o.cwd.trim()) meta.cwd = o.cwd.trim();
  if (typeof o.shell === 'string' && o.shell.trim()) meta.shell = o.shell.trim();
  if (o.env && typeof o.env === 'object') meta.env = o.env as Record<string, string>;
  return meta;
}
