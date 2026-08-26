import { describe, it, expect } from 'vitest';
import { mergeToolJson, migrateMeta } from '../src/shared/toolJson';

describe('mergeToolJson', () => {
  it('clears mdUrl when the patch sends an empty string (the "URL won\'t unstick" bug)', () => {
    const existing = { name: 'T', mdUrl: 'https://x.io/h.md', autoUpdateMinutes: 5, useRemote: true };
    const merged = mergeToolJson(existing, { mdUrl: '' });
    expect(merged.mdUrl).toBeUndefined();
    // autoUpdateMinutes and useRemote are meaningless without a URL — cleared too
    expect(merged.autoUpdateMinutes).toBeUndefined();
    expect(merged.useRemote).toBeUndefined();
    expect(merged.name).toBe('T');
  });

  it('keeps autoUpdateMinutes when mdUrl is still set', () => {
    const merged = mergeToolJson({ name: 'T' }, { mdUrl: 'https://x.io/h.md', autoUpdateMinutes: 10 });
    expect(merged.mdUrl).toBe('https://x.io/h.md');
    expect(merged.autoUpdateMinutes).toBe(10);
  });

  it('prunes cleared cwd / tmux / empty initCommands', () => {
    const existing = { name: 'T', cwd: '~/p', tmux: 'dev', initCommands: ['a'] };
    const merged = mergeToolJson(existing, { cwd: '', tmux: '   '.trim(), initCommands: [] });
    expect(merged.cwd).toBeUndefined();
    expect(merged.tmux).toBeUndefined();
    expect(merged.initCommands).toBeUndefined();
  });

  it('prunes cleared group', () => {
    const merged = mergeToolJson({ name: 'T', group: '前端' }, { group: '' });
    expect(merged.group).toBeUndefined();
  });

  it('keeps group when set', () => {
    const merged = mergeToolJson({ name: 'T' }, { group: '后端' });
    expect(merged.group).toBe('后端');
  });

  it('preserves existing fields the editor does not manage (e.g. env)', () => {
    const existing = { name: 'T', env: { FOO: 'bar' }, order: 2 };
    const merged = mergeToolJson(existing, { name: 'T2' });
    expect(merged.env).toEqual({ FOO: 'bar' });
    expect(merged.order).toBe(2);
    expect(merged.name).toBe('T2');
  });

  it('patch overrides existing values', () => {
    const merged = mergeToolJson({ name: 'old', cwd: '/a' }, { name: 'new', cwd: '/b' });
    expect(merged.name).toBe('new');
    expect(merged.cwd).toBe('/b');
  });
});

describe('mergeToolJson rootDir', () => {
  it('prunes cleared rootDir (empty string)', () => {
    const merged = mergeToolJson({ rootDir: '/srv/api' }, { rootDir: '' });
    expect(merged.rootDir).toBeUndefined();
  });

  it('keeps rootDir when set', () => {
    const merged = mergeToolJson({ name: 'A' }, { rootDir: '/srv/api' });
    expect(merged.rootDir).toBe('/srv/api');
  });

  it('keeps existing rootDir when patch does not touch it', () => {
    const merged = mergeToolJson({ name: 'A', rootDir: '/srv/api' }, { name: 'B' });
    expect(merged.rootDir).toBe('/srv/api');
  });
});

// 对偶 src-tauri/src/pure.rs merge_tool_json layout/terminalHidden prune。
describe('mergeToolJson layout/terminalHidden', () => {
  it('prunes cleared layout (empty string)', () => {
    const merged = mergeToolJson({ name: 't', layout: 'TB' }, { layout: '' });
    expect(merged).toEqual({ name: 't' });
    expect('layout' in merged).toBe(false);
  });
  it('keeps layout=TB', () => {
    const merged = mergeToolJson({ name: 't' }, { layout: 'TB' });
    expect(merged).toEqual({ name: 't', layout: 'TB' });
  });
  it('keeps existing layout when patch does not touch it', () => {
    const merged = mergeToolJson({ name: 't', layout: 'TB' }, { cwd: '/x' });
    expect(merged).toEqual({ name: 't', layout: 'TB', cwd: '/x' });
  });
  it('prunes terminalHidden=false', () => {
    const merged = mergeToolJson({ name: 't', terminalHidden: true }, { terminalHidden: false });
    expect(merged).toEqual({ name: 't' });
    expect('terminalHidden' in merged).toBe(false);
  });
  it('keeps terminalHidden=true', () => {
    const merged = mergeToolJson({ name: 't' }, { terminalHidden: true });
    expect(merged).toEqual({ name: 't', terminalHidden: true });
  });
});

describe('migrateMeta', () => {
  it('converts type=document to layout=TB + terminalHidden=true and drops type', () => {
    const before = { name: 'doc', type: 'document', cwd: '/x' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 'doc', cwd: '/x', layout: 'TB', terminalHidden: true });
    expect('type' in after).toBe(false);
  });

  it('drops type=terminal and leaves layout/terminalHidden unset', () => {
    const before = { name: 't', type: 'terminal', shell: 'zsh' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't', shell: 'zsh' });
    expect('type' in after).toBe(false);
    expect('layout' in after).toBe(false);
    expect('terminalHidden' in after).toBe(false);
  });

  it('drops legacy type field when empty string', () => {
    const before = { name: 't', type: '' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't' });
    expect('type' in after).toBe(false);
  });

  it('preserves existing layout/terminalHidden (idempotent re-run)', () => {
    const before = { name: 't', layout: 'TB', terminalHidden: false };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't', layout: 'TB', terminalHidden: false });
  });

  it('ignores unknown type values (treats as default)', () => {
    const before = { name: 't', type: 'weird' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't' });
    expect('type' in after).toBe(false);
  });
});

// 对偶 src-tauri/src/pure.rs merge_tool_json kind/webUrl 裁剪。
describe('mergeToolJson kind/webUrl', () => {
  it('keeps kind=web when patched', () => {
    const m = mergeToolJson({ name: 't' }, { kind: 'web', webUrl: 'http://localhost:38311/' });
    expect(m.kind).toBe('web');
    expect(m.webUrl).toBe('http://localhost:38311/');
  });
  it('prunes cleared kind (back to default)', () => {
    const m = mergeToolJson({ name: 't', kind: 'web' }, { kind: '' });
    expect('kind' in m).toBe(false);
  });
  it('prunes cleared webUrl', () => {
    const m = mergeToolJson({ name: 't', webUrl: 'http://x/' }, { webUrl: '' });
    expect('webUrl' in m).toBe(false);
  });
  it('preserves webUrl when patch does not touch it (默认态不发送)', () => {
    const m = mergeToolJson({ name: 't', webUrl: 'http://x/' }, { cwd: '/y' });
    expect(m.webUrl).toBe('http://x/');
    expect(m.cwd).toBe('/y');
  });
  it('never strips legacy `type` via merge (migrateMeta owns that)', () => {
    // merge 不做 type 迁移语义——历史 type 字段由迁移链处理，merge 只透传。
    const m = mergeToolJson({ name: 't', type: 'document' }, { kind: 'web' });
    expect(m.type).toBe('document');
    expect(m.kind).toBe('web');
  });
});
