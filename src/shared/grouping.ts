import type { Tool } from './types';

/** 未分组 section 的名字（与渲染端一致）。 */
export const UNGROUPED = '未分组';

export interface GroupSection {
  name: string;
  tools: Tool[];
  isUngrouped: boolean;
}

/**
 * 把扁平有序的 tools 按 meta.group 分区。
 *
 * - indexedGroups 顺序决定已登记分组的展示顺序；
 * - 工具引用了但不在 indexedGroups 里的分组（手动改 tool.json / 导入）按字母序
 *   追加到已登记分组之后；
 * - 未分组（meta.group 空/缺失）恒放最后；若为空则整个 section 不返回
 *   （避免出现空的「未分组」）。
 * - 空的已登记分组（indexedGroups 里有但无工具）**保留**：显式创建过的分组
 *   不因临时清空工具而消失。
 * - 组内工具顺序 = 它们在入参 tools 数组中的相对顺序（flat order 的子序列）。
 */
export function buildGroupedView(tools: Tool[], indexedGroups: string[]): GroupSection[] {
  const sections: GroupSection[] = [];

  // 1. 已登记分组，按索引顺序
  for (const name of indexedGroups) {
    sections.push({
      name,
      tools: tools.filter((t) => t.meta.group === name),
      isUngrouped: false,
    });
  }

  // 2. 未索引分组：工具引用了但不在 indexedGroups 里，按字母序去重追加
  const indexed = new Set(indexedGroups);
  const unindexed = new Set<string>();
  for (const t of tools) {
    const g = t.meta.group;
    if (g && !indexed.has(g)) unindexed.add(g);
  }
  const unindexedSorted = Array.from(unindexed).sort((a, b) => a.localeCompare(b));
  for (const name of unindexedSorted) {
    sections.push({
      name,
      tools: tools.filter((t) => t.meta.group === name),
      isUngrouped: false,
    });
  }

  // 3. 未分组（恒末尾）；空则不追加
  const ungroupedTools = tools.filter((t) => !t.meta.group);
  if (ungroupedTools.length > 0) {
    sections.push({
      name: UNGROUPED,
      tools: ungroupedTools,
      isUngrouped: true,
    });
  }

  return sections;
}
