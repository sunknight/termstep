// git unified diff 行分类——ConfigRecords 右栏着色渲染用。
// 纯展示逻辑，无 React 依赖，可被 vitest 直接覆盖。

export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'note' | 'ctx';

/**
 * 按行首特征分类一行 unified diff：
 * - `diff --git` / `index ` / `--- a/...` / `+++ b/...` → 文件头
 * - `@@ ... @@` → 段头
 * - 行首 `+`（排除 `+++`）→ 新增行
 * - 行首 `-`（排除 `---`）→ 删除行
 * - `\ No newline at end of file` → 尾注
 * - 其余（含空行）→ 上下文行
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('diff --git ') || line.startsWith('index ')) return 'file';
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  // `+++`/`---` 已在上面归为 file，这里剩下的才是真正的增删行
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('\\ No newline at end of file')) return 'note';
  return 'ctx';
}
