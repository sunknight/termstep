import { describe, it, expect } from 'vitest';
import { parseToolMeta } from '../src/shared/toolConfig';

describe('parseToolMeta', () => {
  it('fills defaults from id when fields missing', () => {
    const m = parseToolMeta({}, 'git');
    expect(m).toEqual({ id: 'git', name: 'git', icon: '▣', order: 0 });
  });

  it('uses provided name/icon/order', () => {
    const m = parseToolMeta({ name: 'Git', icon: '🌿', order: 3 }, 'git');
    expect(m.name).toBe('Git');
    expect(m.icon).toBe('🌿');
    expect(m.order).toBe(3);
  });

  it('keeps optional cwd/shell/env only when valid', () => {
    const m = parseToolMeta({ cwd: '~/r', shell: '/bin/sh', env: { X: '1' } }, 'git');
    expect(m.cwd).toBe('~/r');
    expect(m.shell).toBe('/bin/sh');
    expect(m.env).toEqual({ X: '1' });
  });

  it('drops blank name/icon and non-finite order', () => {
    const m = parseToolMeta({ name: '   ', icon: '', order: 'nope' }, 'git');
    expect(m.name).toBe('git');
    expect(m.icon).toBe('▣');
    expect(m.order).toBe(0);
  });

  it('ignores non-object input', () => {
    const m = parseToolMeta(null, 'git');
    expect(m.name).toBe('git');
  });

  it('parses tmux, initCommands (array), mdUrl, autoUpdateMinutes', () => {
    const m = parseToolMeta(
      {
        tmux: 'dev',
        initCommands: ['cd ~/proj', 'source venv/bin/activate'],
        mdUrl: 'https://example.com/help.md',
        autoUpdateMinutes: 10,
      },
      'git'
    );
    expect(m.tmux).toBe('dev');
    expect(m.initCommands).toEqual(['cd ~/proj', 'source venv/bin/activate']);
    expect(m.mdUrl).toBe('https://example.com/help.md');
    expect(m.autoUpdateMinutes).toBe(10);
  });

  it('accepts initCommands as a newline/comma-separated string', () => {
    const m = parseToolMeta({ initCommands: 'ls\npwd, echo hi\n  ' }, 'git');
    expect(m.initCommands).toEqual(['ls', 'pwd', 'echo hi']);
  });

  it('drops empty/invalid optional fields and non-finite autoUpdateMinutes', () => {
    const m = parseToolMeta({ tmux: '   ', initCommands: [], autoUpdateMinutes: NaN }, 'git');
    expect(m.tmux).toBeUndefined();
    expect(m.initCommands).toBeUndefined();
    expect(m.autoUpdateMinutes).toBeUndefined();
  });

  it('reads useRemote when true', () => {
    expect(parseToolMeta({ useRemote: true }, 'git').useRemote).toBe(true);
    expect(parseToolMeta({ useRemote: false }, 'git').useRemote).toBeUndefined();
  });

  it('parses group', () => {
    const m = parseToolMeta({ name: 'A', group: '前端' }, 'x');
    expect(m.group).toBe('前端');
  });

  it('drops blank group', () => {
    const m = parseToolMeta({ name: 'A', group: '   ' }, 'x');
    expect(m.group).toBeUndefined();
  });

  it('group defaults undefined', () => {
    const m = parseToolMeta({ name: 'A' }, 'x');
    expect(m.group).toBeUndefined();
  });
});

describe('parseToolMeta rootDir', () => {
  it('parses rootDir when present', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '/srv/api' }, 'x');
    expect(m.rootDir).toBe('/srv/api');
  });

  it('trims rootDir whitespace', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '  /srv/api  ' }, 'x');
    expect(m.rootDir).toBe('/srv/api');
  });

  it('drops blank rootDir', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '   ' }, 'x');
    expect(m.rootDir).toBeUndefined();
  });

  it('rootDir absent -> undefined', () => {
    const m = parseToolMeta({ name: 'A' }, 'x');
    expect(m.rootDir).toBeUndefined();
  });

  it('rootDir with ~ kept verbatim', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '~/api' }, 'x');
    expect(m.rootDir).toBe('~/api');
  });
});
