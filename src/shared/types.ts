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
} as const;

export interface ToolMeta {
  id: string;
  name: string;
  icon: string;
  order: number;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
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
}
