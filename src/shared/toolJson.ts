// Merge a tool.json blob with an editor patch, pruning optional fields the
// editor clears. Without pruning, `{...existing, ...patch}` silently keeps the
// old value of a cleared field (e.g. mdUrl) — which is the "clearing the URL
// doesn't stick" bug. Pure so it is unit-testable and free of Electron deps.

const PRUNE_WHEN_EMPTY_STRING = ['cwd', 'rootDir', 'tmux', 'mdUrl', 'group', 'layout'] as const;

export function mergeToolJson(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const k of Object.keys(existing)) if (existing[k] !== undefined) merged[k] = existing[k];
  for (const k of Object.keys(patch)) if (patch[k] !== undefined) merged[k] = patch[k];

  // A cleared optional field arrives as '' (or [] for initCommands): drop it so
  // it leaves the file rather than being masked by the old persisted value.
  for (const k of PRUNE_WHEN_EMPTY_STRING) {
    if (merged[k] === '') delete merged[k];
  }
  if (Array.isArray(merged.initCommands) && merged.initCommands.length === 0) {
    delete merged.initCommands;
  }
  // autoUpdateMinutes and useRemote are meaningless without a URL — clear them
  // together with mdUrl.
  if (!merged.mdUrl) {
    delete merged.autoUpdateMinutes;
    delete merged.useRemote;
  }
  // terminalHidden=false 是默认值，prune 掉保持 tool.json 整洁（与 layout 空串同理）。
  if (merged.terminalHidden === false) {
    delete merged.terminalHidden;
  }
  return merged;
}

/**
 * 把旧 `type` 字段迁移到新的 `layout` + `terminalHidden` 字段（统一布局系统）。
 * - `type:"document"` → `layout:"TB"` + `terminalHidden:true`（保留原「文档为主」观感）。
 * - `type:"terminal"` / `type:""` / 未知值 / 缺失 → 不设 layout/terminalHidden（走默认 LR + 可见）。
 * - 任何情况都删除 `type` 字段。
 * 幂等：输入已无 `type` 字段则原样返回（layout/terminalHidden 不动）。
 * 对偶 src-tauri/src/pure.rs migrate_meta。
 */
export function migrateMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta)) {
    if (k === 'type') continue; // type 字段一律丢弃
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  if (meta.type === 'document') {
    out.layout = 'TB';
    out.terminalHidden = true;
  }
  return out;
}
