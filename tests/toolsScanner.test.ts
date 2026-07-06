import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { scanTools, fetchRemoteMarkdown } from '../src/main/toolsScanner';

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

  it('reads a local file path as mdUrl', async () => {
    const ext = path.join(dir, 'remote.md');
    await fs.writeFile(ext, '# From File');
    await writeTool('a', `{"name":"A","mdUrl":${JSON.stringify(ext)}}`, '# Local');
    const r = await scanTools(dir);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].remoteMarkdown).toBe('# From File');
    // local help.md stays independent
    expect(r.tools[0].helpMarkdown).toBe('# Local');
    expect(r.errors).toEqual([]);
  });

  it('reads a file:// URL as mdUrl', async () => {
    const ext = path.join(dir, 'remote.md');
    await fs.writeFile(ext, '# From file URL');
    const fileUrl = pathToFileURL(ext).href;
    await writeTool('a', `{"name":"A","mdUrl":${JSON.stringify(fileUrl)}}`, '');
    const r = await scanTools(dir);
    expect(r.tools[0].remoteMarkdown).toBe('# From file URL');
  });
});

describe('fetchRemoteMarkdown (local path support)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'md-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reads an absolute path', async () => {
    const p = path.join(tmp, 'note.md');
    await fs.writeFile(p, 'hello');
    const r = await fetchRemoteMarkdown(p);
    expect(r.markdown).toBe('hello');
    expect(r.error).toBeUndefined();
  });

  it('reads a file:// URL', async () => {
    const p = path.join(tmp, 'note.md');
    await fs.writeFile(p, 'hi');
    const r = await fetchRemoteMarkdown(pathToFileURL(p).href);
    expect(r.markdown).toBe('hi');
  });

  it('reports error (no throw) for a missing local file', async () => {
    const r = await fetchRemoteMarkdown(path.join(tmp, 'nope.md'));
    expect(r.markdown).toBe('');
    expect(r.error).toBeTruthy();
  });
});

describe('fetchRemoteMarkdown (sensitive-path guard)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'md-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Create the file AND attempt to read it; assert the read is refused even
  // though the file exists (so the block is the guard, not a missing file).
  async function expectBlocked(rel: string) {
    const full = path.join(tmp, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, 'SECRET');
    const r = await fetchRemoteMarkdown(full);
    expect(r.markdown).toBe('');
    expect(r.error).toMatch(/敏感|拒绝/i);
  }

  it('blocks SSH key dir', async () => {
    await expectBlocked('.ssh/id_rsa');
  });
  it('blocks AWS credentials dir', async () => {
    await expectBlocked('.aws/credentials');
  });
  it('blocks kubeconfig dir', async () => {
    await expectBlocked('.kube/config');
  });
  it('blocks an id_* private key by name anywhere', async () => {
    await expectBlocked('notes/id_ed25519');
  });
  it('blocks .env* by name anywhere', async () => {
    await expectBlocked('project/.env.local');
  });
  it('blocks *.key / *.pem by name anywhere', async () => {
    await expectBlocked('certs/server.key');
    await expectBlocked('certs/server.pem');
  });
  it('blocks a path under macOS Keychains', async () => {
    await expectBlocked('Library/Keychains/login.keychain-db');
  });

  it('allows a normal markdown file', async () => {
    const p = path.join(tmp, 'docs', 'guide.md');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, '# ok');
    const r = await fetchRemoteMarkdown(p);
    expect(r.markdown).toBe('# ok');
    expect(r.error).toBeUndefined();
  });
});
