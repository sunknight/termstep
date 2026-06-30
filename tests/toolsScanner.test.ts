import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanTools } from '../src/main/toolsScanner';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeTool(id: string, json: string | null, md: string) {
  const t = path.join(dir, id);
  await fs.mkdir(t, { recursive: true });
  if (json !== null) await fs.writeFile(path.join(t, 'tool.json'), json);
  await fs.writeFile(path.join(t, 'help.md'), md);
}

describe('scanTools', () => {
  it('returns empty when dir missing', async () => {
    const r = await scanTools(path.join(dir, 'nope'));
    expect(r.tools).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('uses defaults when tool.json missing', async () => {
    await writeTool('git', null, '# Git');
    const r = await scanTools(dir);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].meta.name).toBe('git');
    expect(r.tools[0].helpMarkdown).toBe('# Git');
  });

  it('parses tool.json and sorts by order', async () => {
    await writeTool('b', '{"name":"B","order":2}', '');
    await writeTool('a', '{"name":"A","order":1}', '');
    const r = await scanTools(dir);
    expect(r.tools.map((t) => t.meta.id)).toEqual(['a', 'b']);
  });

  it('skips tool with invalid JSON and reports error', async () => {
    await writeTool('bad', '{ not json', '');
    await writeTool('good', '{"name":"Good"}', '');
    const r = await scanTools(dir);
    expect(r.tools.map((t) => t.meta.id)).toEqual(['good']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].id).toBe('bad');
  });

  it('ignores non-directory entries', async () => {
    await fs.writeFile(path.join(dir, 'stray.txt'), 'x');
    const r = await scanTools(dir);
    expect(r.tools).toEqual([]);
  });
});
