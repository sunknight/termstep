// Builds the argv that drops a freshly spawned shell into a named tmux session
// using `tmux new -A -s NAME` — attach if the session exists, else create it.
// The name comes from tool.json (user-controlled), so we validate it strictly:
// only chars tmux accepts in a session name, no shell metacharacters.

// tmux session names: [A-Za-z0-9_-]; we also tolerate '.' and ':' then strip
// them (older tmux rejects '.' in -s names).
const SAFE_NAME = /^[A-Za-z0-9_.:-]+$/;

export function sanitizeTmuxName(raw: string): string | null {
  const name = raw.trim();
  if (!name || !SAFE_NAME.test(name)) return null;
  return name.replace(/[.:]/g, '-');
}

// argv for the spawned shell: run `exec tmux new -A -s '<name>'` and replace the
// shell with tmux, so detaching closes the pty (and reopening re-attaches).
export function tmuxArgv(name: string): string[] {
  const escaped = name.replace(/'/g, `'\\''`);
  return ['-c', `exec tmux new -A -s '${escaped}'`];
}
