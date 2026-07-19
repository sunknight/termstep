// Merge a tool.json blob with an editor patch, pruning optional fields the
// editor clears. Without pruning, `{...existing, ...patch}` silently keeps the
// old value of a cleared field (e.g. mdUrl) — which is the "clearing the URL
// doesn't stick" bug. Pure so it is unit-testable and free of Electron deps.

const PRUNE_WHEN_EMPTY_STRING = ['cwd', 'rootDir', 'tmux', 'mdUrl', 'group', 'type'] as const;

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
  return merged;
}
