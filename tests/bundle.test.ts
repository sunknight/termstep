import { describe, it, expect } from 'vitest';
import { serializeTools, parseToolsBundle, BUNDLE_VERSION } from '../src/shared/bundle';
import type { Tool } from '../src/shared/types';

function tool(id: string, name: string, md = `# ${name}`, extra: Partial<Tool['meta']> = {}): Tool {
  return {
    meta: { id, name, icon: '★', order: 0, ...extra },
    helpMarkdown: md,
  };
}

describe('serializeTools / parseToolsBundle round-trip', () => {
  it('round-trips a few tools with all meta fields', () => {
    const original = [
      tool('git', 'Git', '# Git', { tmux: 'dev', initCommands: ['cd ~/p'], mdUrl: 'https://x.io/h.md', autoUpdateMinutes: 5, cwd: '~' }),
      tool('docker', 'Docker'),
    ];
    const json = JSON.stringify(serializeTools(original, '2026-07-01T00:00:00Z'));
    const res = parseToolsBundle(json);
    expect(res.error).toBeUndefined();
    expect(res.tools.map((t) => t.meta.id)).toEqual(['git', 'docker']);
    const git = res.tools[0];
    expect(git.meta.tmux).toBe('dev');
    expect(git.meta.initCommands).toEqual(['cd ~/p']);
    expect(git.meta.mdUrl).toBe('https://x.io/h.md');
    expect(git.helpMarkdown).toBe('# Git');
  });

  it('marks the bundle with the current version and app name', () => {
    const b = serializeTools([tool('a', 'A')], 'now');
    expect(b.version).toBe(BUNDLE_VERSION);
    expect(b.app).toBe('gui_anything');
  });

  it('does not serialize derived special/readOnly flags', () => {
    const t = tool('_quick', '快捷命令');
    t.meta.special = true;
    t.meta.readOnly = true;
    const json = JSON.stringify(serializeTools([t], 'now'));
    expect(json).not.toContain('"special"');
    expect(json).not.toContain('"readOnly"');
  });
});

describe('parseToolsBundle — error handling', () => {
  it('rejects invalid JSON', () => {
    const res = parseToolsBundle('{ not json');
    expect(res.tools).toEqual([]);
    expect(res.error).toMatch(/JSON/);
  });

  it('rejects a non-object root', () => {
    expect(parseToolsBundle('[]').error).toBeTruthy();
    expect(parseToolsBundle('42').error).toBeTruthy();
  });

  it('rejects when tools is missing or not an array', () => {
    expect(parseToolsBundle('{"version":1}').error).toMatch(/tools/);
    expect(parseToolsBundle('{"tools":{}}').error).toMatch(/tools/);
  });

  it('rejects an empty tools array', () => {
    expect(parseToolsBundle('{"tools":[]}').error).toMatch(/没有/);
  });

  it('accepts a flat {id, name, helpMarkdown} shape (no meta wrapper)', () => {
    const json = JSON.stringify({
      version: 1,
      tools: [{ id: 'x', name: 'X', helpMarkdown: '# X' }],
    });
    const res = parseToolsBundle(json);
    expect(res.error).toBeUndefined();
    expect(res.tools[0].meta.id).toBe('x');
    expect(res.tools[0].meta.name).toBe('X');
  });

  it('synthesizes an id when missing', () => {
    const json = JSON.stringify({ version: 1, tools: [{ name: 'NoId', helpMarkdown: '' }] });
    const res = parseToolsBundle(json);
    expect(res.tools[0].meta.id).toBe('tool-1');
  });
});
