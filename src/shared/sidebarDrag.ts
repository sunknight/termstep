import type { Tool } from './types';

/** 拖拽释放目标的语义。 */
export type DropTarget =
  | { kind: 'before-tool'; id: string }
  | { kind: 'after-tool'; id: string }
  | { kind: 'append-group'; group: string | null };

/**
 * 同组内拖拽后，按 target 计算新的 flat order（工具 id 数组）。
 * 纯函数，便于单测。跨组移动不走这里——跨组由后端 tool_move 决定位置。
 *
 * - before-tool X：插入到 X 之前。
 * - after-tool X：插入到 X 之后。
 * - append-group G：插入到分组 G 的最后一个工具之后（G 空则末尾）。
 */
export function buildNewOrder(tools: Tool[], fromId: string, target: DropTarget): string[] {
  const order = tools.map((t) => t.meta.id);
  const fromIdx = order.indexOf(fromId);
  if (fromIdx < 0) return order;

  order.splice(fromIdx, 1);

  const groupOfId = (id: string): string | null => {
    const t = tools.find((x) => x.meta.id === id);
    return t?.meta.group ?? null;
  };

  let insertIdx: number;
  if (target.kind === 'before-tool') {
    insertIdx = order.indexOf(target.id);
    if (insertIdx < 0) insertIdx = order.length;
  } else if (target.kind === 'after-tool') {
    insertIdx = order.indexOf(target.id);
    if (insertIdx < 0) insertIdx = order.length;
    insertIdx += 1; // 插在该工具之后
  } else {
    // append-group：插到目标分组最后一个工具之后；该分组在剩余顺序里无工具
    // （空分组 / 源工具是该分组唯一工具）则追加到末尾，与后端 tool_move 一致。
    const group = target.group;
    let lastIdx = -1;
    for (let i = 0; i < order.length; i++) {
      if (groupOfId(order[i]) === group) {
        lastIdx = i;
      }
    }
    insertIdx = lastIdx < 0 ? order.length : lastIdx + 1;
  }
  order.splice(insertIdx, 0, fromId);
  return order;
}

/**
 * 跨组移动时，解析传给后端的 beforeId（null = 追加到目标分组末尾）。
 * - before-tool X → X
 * - after-tool X → flat order 中 X 的下一个工具（无则 null）
 * - append-group G → null
 */
export function resolveBeforeId(tools: Tool[], target: DropTarget): string | null {
  if (target.kind === 'before-tool') return target.id;
  if (target.kind === 'after-tool') {
    const idx = tools.findIndex((t) => t.meta.id === target.id);
    if (idx >= 0 && idx < tools.length - 1) return tools[idx + 1].meta.id;
    return null;
  }
  return null; // append-group
}

/** 比较两个 drop target 是否等价（避免无谓 re-render）。 */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'append-group') return a.group === (b as { group: string | null }).group;
  return a.id === (b as { id: string }).id;
}

// ── 分组拖拽排序 ─────────────────────────────────────────────────────────────

/** 分组头拖拽的释放目标：落在分组 group 的上沿（before）/ 下沿（after）。
 *  displayOrder 语义见 buildNewGroupsOrder。 */
export interface GroupDropTarget {
  group: string;
  place: 'before' | 'after';
}

/**
 * 拖分组头后，按 target 计算新的分组展示顺序（分组名数组）。
 * 纯函数，便于单测。
 *
 * displayOrder = 当前展示的分组名序列（**不含未分组**——未分组恒末尾不参与
 * 排序）。返回值整体写回 order.json 的 groups 数组：unindexed 分组一旦参与
 * 重排即被登记（位置固化）。
 *
 * - before G：把 from 移到 G 之前。
 * - after G：把 from 移到 G 之后（含「最后一个分组之后」= 全部分组末尾，
 *   组件层把「未分组头上沿」映射为该落点）。
 */
export function buildNewGroupsOrder(displayOrder: string[], from: string, target: GroupDropTarget): string[] {
  const order = [...displayOrder];
  const fromIdx = order.indexOf(from);
  if (fromIdx < 0) return order;
  order.splice(fromIdx, 1);
  let insertIdx = order.indexOf(target.group);
  if (insertIdx < 0) return displayOrder; // target 已不在序列中（防御），保持原序
  if (target.place === 'after') insertIdx += 1;
  order.splice(insertIdx, 0, from);
  return order;
}

/** 分组拖拽是否 no-op（新顺序与当前一致，不显示落点指示）。 */
export function isNoopGroupTarget(displayOrder: string[], from: string, target: GroupDropTarget): boolean {
  return JSON.stringify(buildNewGroupsOrder(displayOrder, from, target)) === JSON.stringify(displayOrder);
}

/** 比较两个分组 drop target 是否等价（避免无谓 re-render）。 */
export function sameGroupDropTarget(a: GroupDropTarget | null, b: GroupDropTarget | null): boolean {
  return a === b || (!!a && !!b && a.group === b.group && a.place === b.place);
}

/** 由 toolId 查所属分组名（未分组返回 null）。 */
function groupOfId(tools: Tool[], id: string): string | null {
  const t = tools.find((x) => x.meta.id === id);
  return t?.meta.group ?? null;
}

/**
 * 判断把 fromId 拖到 target 是否是 no-op（结果顺序/分组都不变）。
 * no-op 位置不应显示落点指示，让拖到自己原位的体验干净。
 *
 * 平凡 case：before/after 自己。注意 buildNewOrder 在 target.id === fromId 时会
 * 因 fromId 已被移除而定位不到（落到末尾），所以平凡 case 必须提前拦截。
 */
export function isNoopTarget(tools: Tool[], fromId: string, target: DropTarget): boolean {
  if ((target.kind === 'before-tool' || target.kind === 'after-tool') && target.id === fromId) {
    return true;
  }
  const fromGroup = groupOfId(tools, fromId);
  const targetGroup =
    target.kind === 'before-tool' || target.kind === 'after-tool' ? groupOfId(tools, target.id) : target.group;
  // 跨分组：必然变化
  if (fromGroup !== targetGroup) return false;
  const newOrder = buildNewOrder(tools, fromId, target);
  const currentOrder = tools.map((t) => t.meta.id);
  return JSON.stringify(newOrder) === JSON.stringify(currentOrder);
}
