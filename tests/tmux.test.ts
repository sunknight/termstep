import { describe, it, expect } from 'vitest';
import { sanitizeTmuxName, tmuxArgv } from '../src/shared/tmux';

describe('sanitizeTmuxName', () => {
  it('accepts plain alnum/dash/underscore names', () => {
    expect(sanitizeTmuxName('dev')).toBe('dev');
    expect(sanitizeTmuxName('my-session_1')).toBe('my-session_1');
  });

  it('strips . and : (tmux rejects them in -s names)', () => {
    expect(sanitizeTmuxName('dev.1')).toBe('dev-1');
    expect(sanitizeTmuxName('a:b')).toBe('a-b');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTmuxName('  dev  ')).toBe('dev');
  });

  it('rejects empty and shell-metacharacter names', () => {
    expect(sanitizeTmuxName('')).toBeNull();
    expect(sanitizeTmuxName('   ')).toBeNull();
    expect(sanitizeTmuxName("dev'; rm -rf /")).toBeNull();
    expect(sanitizeTmuxName('dev$(whoami)')).toBeNull();
    expect(sanitizeTmuxName('a b')).toBeNull();
  });
});

describe('tmuxArgv', () => {
  it('produces a -c argv running exec tmux new -A -s NAME', () => {
    const argv = tmuxArgv('dev');
    expect(argv[0]).toBe('-c');
    expect(argv[1]).toContain('tmux new -A -s');
    expect(argv[1]).toContain("'dev'");
    expect(argv[1].startsWith('exec ')).toBe(true);
  });
});
