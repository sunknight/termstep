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
});
