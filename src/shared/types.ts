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
  TOOL_SAVE: 'tool:save',
  TOOL_CREATE: 'tool:create',
  TOOL_DELETE: 'tool:delete',
  TOOL_REORDER: 'tool:reorder',
  OPEN_EXTERNAL: 'shell:openExternal',
  TOOLS_EXPORT: 'tools:export',
  TOOL_EXPORT_ONE: 'tool:exportOne',
  TOOLS_IMPORT: 'tools:import',
  TOOL_REFRESH_MD: 'tool:refreshMd',
} as const;

// Reserved id of the built-in tool whose `buttons` blocks back the global
// quick-command dropdown. Seeded at startup; editable like any tool.
export const QUICK_TOOL_ID = '_quick';

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
  // Derived flags (set by the scanner, never persisted to tool.json).
  special?: boolean;
  readOnly?: boolean;
}

export interface Tool {
  meta: ToolMeta;
  helpMarkdown: string;
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
