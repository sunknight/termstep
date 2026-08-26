import { describe, it, expect } from 'vitest';
import type { Tool } from '../src/shared/types';
import {
  buildNewGroupsOrder,
  buildNewOrder,
  isNoopGroupTarget,
  isNoopTarget,
  resolveBeforeId,
  sameGroupDropTarget,
  sameDropTarget,
} from '../src/shared/sidebarDrag';

// 构造一个最小 Tool（只关心 meta.id 和 meta.group，buildNewOrder 用到的字段）。
function tool(id: string, group?: string): Tool {
  return {
    meta: {
      id,
      name: id,
      icon: '★',
      order: 0,
      ...(group ? { group } : {}),
    },
    helpMarkdown: '',
  };
}

function tools(...ts: ReturnType<typeof tool>[]): Tool[] {
  return ts;
}

describe('buildNewOrder', () => {
  it('before-tool moves dragged item before target', () => {
    const list = tools(tool('a'), tool('b'), tool('c'));
    // 拖 c 到 a 之前 → [c, a, b]
    expect(buildNewOrder(list, 'c', { kind: 'before-tool', id: 'a' })).toEqual(['c', 'a', 'b']);
  });

  it('after-tool moves dragged item after target', () => {
    const list = tools(tool('a'), tool('b'), tool('c'));
    // 拖 a 到 b 之后 → [b, a, c]
    expect(buildNewOrder(list, 'a', { kind: 'after-tool', id: 'b' })).toEqual(['b', 'a', 'c']);
  });

  it('before-tool on immediate-next sibling is no-op', () => {
    const list = tools(tool('a'), tool('b'), tool('c'));
    // 拖 a 到 b 之前（b 是 a 的下一个）→ 顺序不变
    expect(buildNewOrder(list, 'a', { kind: 'before-tool', id: 'b' })).toEqual(['a', 'b', 'c']);
  });

  it('after-tool on immediate-prev sibling is no-op', () => {
    const list = tools(tool('a'), tool('b'), tool('c'));
    // 拖 b 到 a 之后（a 是 b 的上一个）→ 顺序不变
    expect(buildNewOrder(list, 'b', { kind: 'after-tool', id: 'a' })).toEqual(['a', 'b', 'c']);
  });

  it('append-group inserts after last tool of that group', () => {
    const list = tools(
      tool('a', '前端'),
      tool('b', '前端'),
      tool('c', '后端'),
    );
    // 拖 c 到「前端」分组末尾（b 之后）→ [a, b, c]
    expect(buildNewOrder(list, 'c', { kind: 'append-group', group: '前端' })).toEqual(['a', 'b', 'c']);
  });

  it('append-group for ungrouped (null) inserts after last ungrouped tool', () => {
    const list = tools(
      tool('a', '前端'),
      tool('b'),
      tool('c'),
    );
    // 拖 a 到未分组末尾（c 之后）→ [b, c, a]
    expect(buildNewOrder(list, 'a', { kind: 'append-group', group: null })).toEqual(['b', 'c', 'a']);
  });

  it('append-group for empty group inserts at end of order', () => {
    const list = tools(
      tool('a', '前端'),
      tool('b', '后端'),
    );
    // 「测试」分组没有任何工具 → 追加到末尾
    expect(buildNewOrder(list, 'a', { kind: 'append-group', group: '测试' })).toEqual(['b', 'a']);
  });

  it('returns unchanged order when fromId not found', () => {
    const list = tools(tool('a'), tool('b'));
    expect(buildNewOrder(list, 'x', { kind: 'before-tool', id: 'a' })).toEqual(['a', 'b']);
  });
});

describe('resolveBeforeId', () => {
  it('before-tool returns target id', () => {
    const list = tools(tool('a'), tool('b'));
    expect(resolveBeforeId(list, { kind: 'before-tool', id: 'b' })).toBe('b');
  });

  it('after-tool returns next tool id when available', () => {
    const list = tools(tool('a'), tool('b'), tool('c'));
    // a 之后 → before b
    expect(resolveBeforeId(list, { kind: 'after-tool', id: 'a' })).toBe('b');
  });

  it('after-tool returns null when last tool', () => {
    const list = tools(tool('a'), tool('b'));
    expect(resolveBeforeId(list, { kind: 'after-tool', id: 'b' })).toBeNull();
  });

  it('append-group always returns null', () => {
    const list = tools(tool('a', '前端'));
    expect(resolveBeforeId(list, { kind: 'append-group', group: '前端' })).toBeNull();
  });
});

describe('sameDropTarget', () => {
  it('null vs null is equal', () => {
    expect(sameDropTarget(null, null)).toBe(true);
  });

  it('different kinds are not equal', () => {
    expect(
      sameDropTarget({ kind: 'before-tool', id: 'a' }, { kind: 'after-tool', id: 'a' }),
    ).toBe(false);
  });

  it('same before-tool id is equal', () => {
    expect(
      sameDropTarget({ kind: 'before-tool', id: 'a' }, { kind: 'before-tool', id: 'a' }),
    ).toBe(true);
  });

  it('same append-group is equal', () => {
    expect(
      sameDropTarget({ kind: 'append-group', group: '前端' }, { kind: 'append-group', group: '前端' }),
    ).toBe(true);
  });

  it('ungrouped (null) vs grouped is not equal', () => {
    expect(
      sameDropTarget({ kind: 'append-group', group: null }, { kind: 'append-group', group: '前端' }),
    ).toBe(false);
  });
});

describe('isNoopTarget', () => {
  const list = tools(tool('a'), tool('b'), tool('c'));

  it('before-tool self is no-op', () => {
    expect(isNoopTarget(list, 'b', { kind: 'before-tool', id: 'b' })).toBe(true);
    expect(isNoopTarget(list, 'a', { kind: 'before-tool', id: 'a' })).toBe(true);
    expect(isNoopTarget(list, 'c', { kind: 'before-tool', id: 'c' })).toBe(true);
  });

  it('after-tool self is no-op', () => {
    expect(isNoopTarget(list, 'b', { kind: 'after-tool', id: 'b' })).toBe(true);
  });

  it('before-tool immediate-next sibling (gap below the dragged tool) is no-op', () => {
    // drag b, drop before c (b is currently right before c) → no-op
    expect(isNoopTarget(list, 'b', { kind: 'before-tool', id: 'c' })).toBe(true);
    // drag a, drop before b → no-op
    expect(isNoopTarget(list, 'a', { kind: 'before-tool', id: 'b' })).toBe(true);
  });

  it('after-tool immediate-prev sibling (gap above the dragged tool) is no-op', () => {
    // drag b, drop after a (b is currently right after a) → no-op
    expect(isNoopTarget(list, 'b', { kind: 'after-tool', id: 'a' })).toBe(true);
    // drag c, drop after b → no-op
    expect(isNoopTarget(list, 'c', { kind: 'after-tool', id: 'b' })).toBe(true);
  });

  it('real reorder is not no-op', () => {
    // drag a, drop before c → [b, a, c]
    expect(isNoopTarget(list, 'a', { kind: 'before-tool', id: 'c' })).toBe(false);
    // drag c, drop before a → [c, a, b]
    expect(isNoopTarget(list, 'c', { kind: 'before-tool', id: 'a' })).toBe(false);
    // drag a, drop after c → [b, c, a]
    expect(isNoopTarget(list, 'a', { kind: 'after-tool', id: 'c' })).toBe(false);
  });

  it('cross-group is never no-op', () => {
    const multi = tools(tool('a', '前端'), tool('b', '后端'));
    expect(isNoopTarget(multi, 'a', { kind: 'before-tool', id: 'b' })).toBe(false);
    expect(isNoopTarget(multi, 'b', { kind: 'append-group', group: '前端' })).toBe(false);
  });

  it('append-group own group when already last is no-op', () => {
    const multi = tools(tool('a', '前端'), tool('b', '前端'), tool('c', '后端'));
    // drag b (last of 前端) append to 前端 → no-op
    expect(isNoopTarget(multi, 'b', { kind: 'append-group', group: '前端' })).toBe(true);
    // drag a (not last of 前端) append to 前端 → moves to end → not no-op
    expect(isNoopTarget(multi, 'a', { kind: 'append-group', group: '前端' })).toBe(false);
  });
});

describe('buildNewGroupsOrder', () => {
  const order = ['前端', '后端', '运维'];

  it('before moves dragged group before target', () => {
    // 拖 运维 到 前端 之前 → [运维, 前端, 后端]
    expect(buildNewGroupsOrder(order, '运维', { group: '前端', place: 'before' })).toEqual([
      '运维',
      '前端',
      '后端',
    ]);
  });

  it('after moves dragged group after target', () => {
    // 拖 前端 到 后端 之后 → [后端, 前端, 运维]
    expect(buildNewGroupsOrder(order, '前端', { group: '后端', place: 'after' })).toEqual([
      '后端',
      '前端',
      '运维',
    ]);
  });

  it('after last group = end of all groups (未分组头上沿映射)', () => {
    // 拖 前端 到 运维 之后 → [后端, 运维, 前端]
    expect(buildNewGroupsOrder(order, '前端', { group: '运维', place: 'after' })).toEqual([
      '后端',
      '运维',
      '前端',
    ]);
  });

  it('returns unchanged order when from not found', () => {
    expect(buildNewGroupsOrder(order, '不存在', { group: '前端', place: 'before' })).toEqual(order);
  });

  it('returns unchanged order when target not found (defensive)', () => {
    expect(buildNewGroupsOrder(order, '前端', { group: '不存在', place: 'before' })).toEqual(order);
  });
});

describe('isNoopGroupTarget', () => {
  const order = ['前端', '后端', '运维'];

  it('adjacent position is no-op', () => {
    // 前端 已在 后端 之前 → before 后端 = no-op
    expect(isNoopGroupTarget(order, '前端', { group: '后端', place: 'before' })).toBe(true);
    // 后端 已在 前端 之后 → after 前端 = no-op
    expect(isNoopGroupTarget(order, '后端', { group: '前端', place: 'after' })).toBe(true);
  });

  it('real move is not no-op', () => {
    expect(isNoopGroupTarget(order, '运维', { group: '前端', place: 'before' })).toBe(false);
    expect(isNoopGroupTarget(order, '前端', { group: '运维', place: 'after' })).toBe(false);
  });
});

describe('sameGroupDropTarget', () => {
  it('null vs null is equal', () => {
    expect(sameGroupDropTarget(null, null)).toBe(true);
  });

  it('same group and place is equal', () => {
    expect(sameGroupDropTarget({ group: '前端', place: 'before' }, { group: '前端', place: 'before' })).toBe(true);
  });

  it('different place on same group is not equal', () => {
    expect(sameGroupDropTarget({ group: '前端', place: 'before' }, { group: '前端', place: 'after' })).toBe(false);
  });
});
