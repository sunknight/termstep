import { describe, it, expect } from 'vitest';
import { buildGroupedView, UNGROUPED } from '../src/shared/grouping';
import type { Tool } from '../src/shared/types';

function tool(id: string, group: string | undefined, order: number): Tool {
  return {
    meta: { id, name: id, icon: '▣', order, group },
    helpMarkdown: '',
  };
}

describe('buildGroupedView', () => {
  it('returns single ungrouped section when no groups and no tool has group', () => {
    const tools = [tool('a', undefined, 0), tool('b', undefined, 1)];
    const view = buildGroupedView(tools, []);
    expect(view).toHaveLength(1);
    expect(view[0].name).toBe(UNGROUPED);
    expect(view[0].isUngrouped).toBe(true);
    expect(view[0].tools.map((t) => t.meta.id)).toEqual(['a', 'b']);
  });

  it('outputs indexed groups in order, then ungrouped last', () => {
    const tools = [
      tool('a', '前端', 0),
      tool('b', '后端', 1),
      tool('c', '前端', 2),
      tool('d', undefined, 3),
    ];
    const view = buildGroupedView(tools, ['前端', '后端']);
    expect(view.map((g) => g.name)).toEqual(['前端', '后端', UNGROUPED]);
    // 组内保持 flat order 相对位置
    expect(view[0].tools.map((t) => t.meta.id)).toEqual(['a', 'c']);
    expect(view[1].tools.map((t) => t.meta.id)).toEqual(['b']);
    expect(view[2].tools.map((t) => t.meta.id)).toEqual(['d']);
  });

  it('appends unindexed groups (referenced but not in index) in alphabetical order', () => {
    // 工具引用了 '后端'、'前端'，但 indexedGroups 只有 ['前端']
    const tools = [
      tool('a', '前端', 0),
      tool('b', '后端', 1),
      tool('c', undefined, 2),
    ];
    const view = buildGroupedView(tools, ['前端']);
    // indexed '前端' 在前；unindexed '后端' 按字母序追加；最后未分组
    expect(view.map((g) => g.name)).toEqual(['前端', '后端', UNGROUPED]);
  });

  it('hides empty indexed groups (no tool references them)', () => {
    // indexedGroups 含 '空分组'，但没有工具引用它 → 不渲染（分组头隐藏）
    const tools = [tool('a', '前端', 0)];
    const view = buildGroupedView(tools, ['前端', '空分组']);
    expect(view.map((g) => g.name)).toEqual(['前端']);
  });

  it('restores an emptied group at its indexed position when a tool references it again', () => {
    // 分组被清空后登记名仍留在 order.json 的 groups 里；工具重新引用 → 按登记位置恢复
    const tools = [tool('a', '前端', 0), tool('b', '测试', 1)];
    const view = buildGroupedView(tools, ['测试', '前端']);
    expect(view.map((g) => g.name)).toEqual(['测试', '前端']);
  });

  it('omits ungrouped section when it is empty', () => {
    const tools = [tool('a', '前端', 0)];
    const view = buildGroupedView(tools, ['前端']);
    // 所有工具都在分组里 → 不渲染空未分组
    expect(view.map((g) => g.name)).toEqual(['前端']);
  });

  it('preserves within-group relative order from flat array', () => {
    // flat order: a(前端), b(后端), c(前端), d(前端) → 前端组内顺序 a,c,d
    const tools = [
      tool('a', '前端', 0),
      tool('b', '后端', 1),
      tool('c', '前端', 2),
      tool('d', '前端', 3),
    ];
    const view = buildGroupedView(tools, ['前端', '后端']);
    expect(view[0].tools.map((t) => t.meta.id)).toEqual(['a', 'c', 'd']);
  });

  it('dedupes unindexed groups', () => {
    const tools = [tool('a', 'X', 0), tool('b', 'X', 1)];
    const view = buildGroupedView(tools, []);
    // X 未索引但被两个工具引用 → 只出现一次；无未分组工具，故无 UNGROUPED
    expect(view.map((g) => g.name)).toEqual(['X']);
    expect(view[0].tools).toHaveLength(2);
  });
});
