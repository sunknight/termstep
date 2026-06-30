import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScanResult, Tool } from '../shared/types';
import { parseToolMeta } from '../shared/toolConfig';

export async function scanTools(toolsDir: string): Promise<ScanResult> {
  const result: ScanResult = { tools: [], errors: [] };
  let entries: string[];
  try {
    entries = await fs.readdir(toolsDir);
  } catch {
    return result; // dir missing -> empty
  }
  for (const entry of entries) {
    const child = path.join(toolsDir, entry);
    let stat;
    try {
      stat = await fs.stat(child);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const id = entry;
    const toolJsonPath = path.join(child, 'tool.json');
    let metaRaw: unknown;
    try {
      await fs.access(toolJsonPath);
      metaRaw = JSON.parse(await fs.readFile(toolJsonPath, 'utf8'));
    } catch (e) {
      // present-but-unparseable -> skip + report; missing -> defaults
      if (await exists(toolJsonPath)) {
        result.errors.push({ id, message: `tool.json 解析失败: ${(e as Error).message}` });
        continue;
      }
      metaRaw = {};
    }
    const meta = parseToolMeta(metaRaw, id);
    let helpMarkdown = '';
    try {
      helpMarkdown = await fs.readFile(path.join(child, 'help.md'), 'utf8');
    } catch {
      // missing help -> empty
    }
    result.tools.push({ meta, helpMarkdown });
  }
  result.tools.sort(
    (a, b) => a.meta.order - b.meta.order || a.meta.id.localeCompare(b.meta.id)
  );
  return result;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
