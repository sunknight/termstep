import { describe, it, expect } from 'vitest';
import { mergeToolJson } from '../src/shared/toolJson';

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
