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
  TOOL_MOVE: 'tool:move',
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
  /** `@/` placeholder anchor (tool root directory). Priority rootDir > cwd > ~.
   *  When empty/absent, @/ falls back to cwd, then to ~ (shell-expands).
   *  Does NOT affect pty spawn (spawn still uses cwd). */
  rootDir?: string;
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
  // 稳定来源标识（UUID v4）。跨导入不变：同一 bundle 再次导入时按它匹配已有
  // 工具决定更新 vs 新建。区别于 `id`（物理目录名=存储位置）。由后端在首次
  // 导入/迁移时生成并写进 tool.json，前端只读不写。
  sourceId?: string;
  // 分组名（自由文本）。空/缺失 = 未分组。仅用于侧栏展示分区，不影响执行。
  group?: string;
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
  // 分组展示顺序（来自 order.json 的 groups 数组）。渲染端按此顺序画分组标题。
  groups: string[];
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

// --- 版本控制（git 配置记录）---
// 每次保存且文件有变动时自动提交；此处是只读的历史/diff 查询类型。
export interface CommitEntry {
  hash: string;
  shortHash: string;
  time: number;
  message: string;
}
export interface VcsDiff {
  diff: string;
}

// --- 导入预检风险摘要（对偶 src-tauri/src/pure.rs ToolRiskSummary）---
// 导入 bundle 前后端扫描风险字段，前端据此弹确认对话框。
export interface ToolRiskSummary {
  name: string;
  shell?: string;
  initCommands: string[];
  mdUrl?: string;
  envKeys: string[];
}
