// Import/export bundle format. Pure logic — no fs, no Electron — so it is
// unit-testable and usable in both main and renderer.
import type { Tool, ToolMeta } from './types';
import { parseToolMeta } from './toolConfig';

export const BUNDLE_VERSION = 1;

// ToolMeta minus the derived flag the scanner sets (special) — it is never
// persisted to tool.json and must not round-trip through a bundle.
export type SerializableMeta = ToolMeta;

export interface BundleTool {
  meta: SerializableMeta;
  helpMarkdown: string;
}

export interface ToolsBundle {
  version: number;
  app: string;
  // Human-readable export timestamp; not consulted on import.
  exportedAt?: string;
  tools: BundleTool[];
}

function stripDerived(meta: ToolMeta): SerializableMeta {
  return { ...meta };
}

export function serializeTools(tools: Tool[], exportedAt: string): ToolsBundle {
  return {
    version: BUNDLE_VERSION,
    app: 'gui_anything',
    tools: tools.map((t) => ({ meta: stripDerived(t.meta), helpMarkdown: t.helpMarkdown })),
    // included for human-readability; not consulted on import
    exportedAt,
  };
}

export interface ParseResult {
  tools: BundleTool[];
  error?: string;
}

export function parseToolsBundle(raw: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { tools: [], error: `JSON 解析失败: ${(e as Error).message}` };
  }
  if (!obj || typeof obj !== 'object') return { tools: [], error: '根元素不是对象' };
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.tools)) return { tools: [], error: '缺少 tools 数组' };

  const tools: BundleTool[] = [];
  for (let i = 0; i < o.tools.length; i++) {
    const item = o.tools[i];
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    // Accept either { meta: {...} } or a flat { id, name, ... } shape.
    const metaIn =
      it.meta && typeof it.meta === 'object'
        ? (it.meta as Record<string, unknown>)
        : it;
    const fallbackId = typeof it.id === 'string' && it.id ? it.id : `tool-${i + 1}`;
    const id =
      typeof metaIn.id === 'string' && metaIn.id ? metaIn.id : fallbackId;
    const meta = stripDerived(parseToolMeta(metaIn, id));
    const helpMarkdown = typeof it.helpMarkdown === 'string' ? it.helpMarkdown : '';
    tools.push({ meta, helpMarkdown });
  }

  if (tools.length === 0) return { tools: [], error: '没有可导入的工具' };
  return { tools };
}
