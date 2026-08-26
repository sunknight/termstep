import { describe, it, expect } from 'vitest';
import { parseToolMeta, normalizeWebUrl } from '../src/shared/toolConfig';

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

// 对偶 src-tauri/src/pure.rs parse_tool_meta layout/terminalHidden。
describe('parseToolMeta layout/terminalHidden', () => {
  it('parses layout=TB', () => {
    const m = parseToolMeta({ name: 't', layout: 'TB' }, 't');
    expect(m.layout).toBe('TB');
  });
  it('parses layout=LR', () => {
    const m = parseToolMeta({ name: 't', layout: 'LR' }, 't');
    expect(m.layout).toBe('LR');
  });
  it('layout defaults undefined when missing', () => {
    const m = parseToolMeta({ name: 't' }, 't');
    expect(m.layout).toBeUndefined();
  });
  it('drops invalid layout values', () => {
    const m = parseToolMeta({ name: 't', layout: 'diagonal' }, 't');
    expect(m.layout).toBeUndefined();
  });
  it('parses terminalHidden=true', () => {
    const m = parseToolMeta({ name: 't', terminalHidden: true }, 't');
    expect(m.terminalHidden).toBe(true);
  });
  it('parses terminalHidden=false', () => {
    const m = parseToolMeta({ name: 't', terminalHidden: false }, 't');
    expect(m.terminalHidden).toBe(false);
  });
  it('terminalHidden defaults undefined when missing', () => {
    const m = parseToolMeta({ name: 't' }, 't');
    expect(m.terminalHidden).toBeUndefined();
  });
});

// 对偶 src-tauri/src/pure.rs parse_tool_meta kind/webUrl。
describe('parseToolMeta kind/webUrl', () => {
  it('parses kind=web', () => {
    const m = parseToolMeta({ name: 't', kind: 'web' }, 't');
    expect(m.kind).toBe('web');
  });
  it('drops invalid kind values (treated as default)', () => {
    expect(parseToolMeta({ name: 't', kind: 'terminal' }, 't').kind).toBeUndefined();
    expect(parseToolMeta({ name: 't', kind: '' }, 't').kind).toBeUndefined();
    expect(parseToolMeta({ name: 't', kind: 'WEB' }, 't').kind).toBeUndefined();
  });
  it('kind defaults undefined when missing', () => {
    expect(parseToolMeta({ name: 't' }, 't').kind).toBeUndefined();
  });
  it('parses webUrl (trimmed)', () => {
    const m = parseToolMeta({ name: 't', kind: 'web', webUrl: '  http://localhost:38311/  ' }, 't');
    expect(m.webUrl).toBe('http://localhost:38311/');
  });
  it('drops blank webUrl', () => {
    expect(parseToolMeta({ name: 't', webUrl: '   ' }, 't').webUrl).toBeUndefined();
  });
  it('webUrl preserved without kind (切回默认保留场景)', () => {
    const m = parseToolMeta({ name: 't', webUrl: 'http://x/' }, 't');
    expect(m.kind).toBeUndefined();
    expect(m.webUrl).toBe('http://x/');
  });
});

describe('normalizeWebUrl', () => {
  it('empty/whitespace → empty (clears the field)', () => {
    expect(normalizeWebUrl('')).toBe('');
    expect(normalizeWebUrl('   ')).toBe('');
  });
  it('no scheme → auto-prefix http://', () => {
    expect(normalizeWebUrl('localhost:38311')).toBe('http://localhost:38311');
    expect(normalizeWebUrl(' example.com/x ')).toBe('http://example.com/x');
  });
  it('host:port is NOT treated as a scheme (关键：localhost:38311)', () => {
    // "localhost:" 形似 scheme，但无 // —— 必须 prepend 而不是原样保留
    expect(normalizeWebUrl('localhost:38311')).not.toBe('localhost:38311');
  });
  it('keeps existing scheme:// unchanged', () => {
    expect(normalizeWebUrl('http://localhost:38311/')).toBe('http://localhost:38311/');
    expect(normalizeWebUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeWebUrl('file:///Users/x/page.html')).toBe('file:///Users/x/page.html');
  });
  it('scheme detection is case-insensitive', () => {
    expect(normalizeWebUrl('HTTP://x/')).toBe('HTTP://x/');
  });
});
