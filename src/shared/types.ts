// Shared types + IPC channel name constants. Imported by main, preload, renderer, tests.
export const IPC = {
  TOOLS_LIST: 'tools:list',
  TOOLS_CHANGED: 'tools:changed',
  PTY_DATA: 'pty:data',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  TOOL_SAVE: 'tool:save',
  TOOL_CREATE: 'tool:create',
  TOOL_DELETE: 'tool:delete',
  TOOL_REORDER: 'tool:reorder',
} as const;
