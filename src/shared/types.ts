// Shared types + IPC channel name constants. Imported by main, preload, renderer, tests.
export const IPC = {
  TOOLS_LIST: 'tools:list',
  TOOLS_CHANGED: 'tools:changed',
  PTY_DATA: 'pty:data',
  PTY_WRITE: 'pty:write',
  PTY_OPEN: 'pty:open',
  PTY_RESTART: 'pty:restart',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_CWD: 'pty:cwd',
  TOOL_SAVE: 'tool:save',
  TOOL_APPEND_MD: 'tool:appendMd',
  TOOL_CREATE: 'tool:create',
  TOOL_DELETE: 'tool:delete',
  TOOL_REORDER: 'tool:reorder',
  OPEN_EXTERNAL: 'shell:openExternal',
  CLIPBOARD_READ: 'clipboard:read',
  CLIPBOARD_WRITE: 'clipboard:write',
  TOOLS_EXPORT: 'tools:export',
  TOOL_EXPORT_ONE: 'tool:exportOne',
  TOOLS_IMPORT: 'tools:import',
  TOOL_REFRESH_MD: 'tool:refreshMd',
  MD_FETCH_PREVIEW: 'md:fetchPreview',
  MD_PICK_FILE: 'md:pickFile',
  QUICK_GET: 'quick:get',
  QUICK_SAVE: 'quick:save',
  UPDATE_STATE: 'update:state',
  UPDATE_CHECK: 'update:check',
} as const;

export interface ToolMeta {
  id: string;
  name: string;
  icon: string;
  order: number;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  // tmux session name — when set, the shell execs `tmux new -A -s <name>`
  // (attach to an existing session, else create+attach).
  tmux?: string;
  // Commands injected into the terminal right after spawn, one per line.
  initCommands?: string[];
  // Remote markdown URL — when set, help.md is fetched from here (read-only)
  // instead of read from disk; takes priority over a local help.md.
  mdUrl?: string;
  // Auto-refresh cadence (minutes) for a mdUrl tool. 0 disables auto-refresh.
  // Omitted -> default applied at scan time.
  autoUpdateMinutes?: number;
  // Which help source is "effective" (shown as the tool's help): true = the
  // fetched remote copy (requires mdUrl), false/omitted = the local help.md.
  // Set by the editor's 本地/远程 tab (the checked one is the effective source).
  useRemote?: boolean;
}

export interface Tool {
  meta: ToolMeta;
  // Local help.md content — always present, always editable.
  helpMarkdown: string;
  // Remote markdown fetched from meta.mdUrl (read-only). Present only when a
  // URL is configured. Kept separate from helpMarkdown so toggling the URL off
  // restores the untouched local content.
  remoteMarkdown?: string;
}

export interface ScanError {
  id: string;
  message: string;
}

export interface ScanResult {
  tools: Tool[];
  errors: ScanError[];
}

export interface PtySpawnOpts {
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  tmux?: string;
  initCommands?: string[];
}

// Auto-update check state. The main process fetches a self-hosted JSON manifest
// and compares its version to app.getVersion(); this discriminated union is the
// state broadcast to the renderer over IPC.UPDATE_STATE. Only `available`
// renders the sidebar badge; `upToDate`/`error` produce a transient popover
// right after a MANUAL check (auto checks fail silently).
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'upToDate' }
  | { status: 'available'; version: string; url: string; notes: string }
  | { status: 'error'; error: string };
