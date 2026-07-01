import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScanResult, Tool } from '../shared/types';
import { parseToolMeta } from '../shared/toolConfig';

export const DEFAULT_AUTO_UPDATE_MINUTES = 5;

// Fetch a remote help.md. Returns {markdown, error}; on failure markdown is ''
// so a broken URL degrades to an empty (but still read-only) pane rather than
// crashing the whole scan.
async function fetchRemoteMarkdown(url: string): Promise<{ markdown: string; error?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { markdown: '', error: `HTTP ${res.status}` };
    const text = await res.text();
    return { markdown: text };
  } catch (e) {
    return { markdown: '', error: (e as Error).message };
  }
}

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

    // Help source: a configured mdUrl wins (read-only, fetched remotely);
    // otherwise read the local help.md. The two are mutually exclusive by design.
    let helpMarkdown = '';
    if (meta.mdUrl) {
      meta.readOnly = true;
      if (meta.autoUpdateMinutes === undefined) {
        meta.autoUpdateMinutes = DEFAULT_AUTO_UPDATE_MINUTES;
      }
      const fetched = await fetchRemoteMarkdown(meta.mdUrl);
      helpMarkdown = fetched.markdown;
      if (fetched.error) {
        result.errors.push({ id, message: `远程帮助加载失败 (${meta.mdUrl}): ${fetched.error}` });
      }
    } else {
      try {
        helpMarkdown = await fs.readFile(path.join(child, 'help.md'), 'utf8');
      } catch {
        // missing help -> empty
      }
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
