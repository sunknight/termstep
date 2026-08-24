import { describe, expect, it } from 'vitest';
import { draftFromTool, isDraftDirty } from '../src/shared/editorDraft';
import type { Tool, ToolMeta } from '../src/shared/types';

function makeTool(overrides: Partial<ToolMeta> = {}, helpMarkdown = '# hi\n'): Tool {
  return {
    meta: {
      id: 't1',
      name: 'demo',
      icon: '🛠️',
      order: 0,
      ...overrides,
    },
    helpMarkdown,
  };
}

describe('draftFromTool', () => {
  it('缺省可选字段映射为空串/默认值', () => {
    const d = draftFromTool(makeTool());
    expect(d.cwd).toBe('');
    expect(d.rootDir).toBe('');
    expect(d.tmux).toBe('');
    expect(d.initCommands).toBe('');
    expect(d.mdUrl).toBe('');
    expect(d.autoUpdate).toBe('');
    expect(d.group).toBe('');
    expect(d.layout).toBe('LR');
    expect(d.terminalHidden).toBe(false);
    expect(d.useRemote).toBe(false);
    expect(d.markdown).toBe('# hi\n');
  });

  it('完整字段逐一映射', () => {
    const d = draftFromTool(
      makeTool({
        cwd: '~/p',
        rootDir: '~/p/packages',
        tmux: 'dev',
        initCommands: ['cd ~/p', 'ls'],
        mdUrl: 'https://x/y.md',
        autoUpdateMinutes: 30,
        group: 'g1',
        layout: 'TB',
        terminalHidden: true,
        useRemote: true,
      }),
    );
    expect(d).toMatchObject({
      cwd: '~/p',
      rootDir: '~/p/packages',
      tmux: 'dev',
      initCommands: 'cd ~/p\nls',
      mdUrl: 'https://x/y.md',
      autoUpdate: '30',
      group: 'g1',
      layout: 'TB',
      terminalHidden: true,
      useRemote: true,
    });
  });

  it('useRemote=true 但 mdUrl 为空 → effective 折算为本地（与保存语义一致）', () => {
    expect(draftFromTool(makeTool({ useRemote: true })).useRemote).toBe(false);
    expect(draftFromTool(makeTool({ useRemote: true, mdUrl: '  ' })).useRemote).toBe(false);
    expect(draftFromTool(makeTool({ useRemote: true, mdUrl: 'u.md' })).useRemote).toBe(true);
  });
});

describe('isDraftDirty', () => {
  it('相同快照不脏', () => {
    const t = makeTool();
    expect(isDraftDirty(draftFromTool(t), draftFromTool(t))).toBe(false);
  });

  it('任一字段不同即脏（覆盖每个字段）', () => {
    const base = draftFromTool(makeTool({ mdUrl: 'u.md', initCommands: ['a'] }, 'm'));
    const fields: (keyof typeof base)[] = [
      'name', 'icon', 'cwd', 'rootDir', 'tmux', 'initCommands', 'mdUrl',
      'autoUpdate', 'group', 'layout', 'terminalHidden', 'markdown', 'useRemote',
    ];
    for (const f of fields) {
      const next = { ...base };
      if (typeof base[f] === 'boolean') {
        (next[f] as boolean) = !base[f];
      } else {
        (next[f] as string) = (base[f] as string) + '~';
      }
      expect(isDraftDirty(base, next), `field ${f}`).toBe(true);
    }
  });

  it('改回原样的字段不脏', () => {
    const base = draftFromTool(makeTool());
    const next = { ...base, name: 'other' };
    expect(isDraftDirty(base, next)).toBe(true);
    next.name = base.name;
    expect(isDraftDirty(base, next)).toBe(false);
  });
});
