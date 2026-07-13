import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ScanResult, ToolMeta, PtySpawnOpts, UpdateState } from '../../shared/types';

// 同构 preload/index.ts 的 api，但底层走 Tauri invoke/listen。
// 所有命名空间/方法签名与原 window.api 一致，调用点只需 window.api → api。
//
// 事件订阅方法（onData/onChanged/onState）返回 Promise<UnlistenFn>（listen 异步）；
// 组件用 useTauriEvent 包装，不要直接把返回值当 effect cleanup。
export const api = {
  tools: {
    list: (): Promise<ScanResult> => invoke('tools_list'),
    onChanged: (cb: (r: ScanResult) => void) =>
      listen<ScanResult>('tools:changed', (e) => cb(e.payload)),
  },
  pty: {
    onData: (cb: (toolId: string, data: string) => void) =>
      listen<{ toolId: string; data: string }>('pty:data', (e) => cb(e.payload.toolId, e.payload.data)),
    write: (toolId: string, data: string, opts?: PtySpawnOpts) =>
      invoke('pty_write', { toolId, data, opts }),
    open: (toolId: string, opts?: PtySpawnOpts) => invoke('pty_open', { toolId, opts }),
    restart: (toolId: string, opts?: PtySpawnOpts) => invoke('pty_restart', { toolId, opts }),
    resize: (toolId: string, cols: number, rows: number) => invoke('pty_resize', { toolId, cols, rows }),
    cwd: (toolId: string) => invoke<string>('pty_cwd', { toolId }),
    kill: (toolId: string) => invoke('pty_kill', { toolId }),
  },
  tool: {
    save: (toolId: string, markdown: string, meta: Partial<ToolMeta>) =>
      invoke('tool_save', { toolId, markdown, metaPatch: meta }),
    appendMd: (toolId: string, body: string) =>
      invoke<boolean>('tool_append_md', { toolId, body }),
    create: (name: string) => invoke<string>('tool_create', { name }),
    del: (toolId: string) => invoke('tool_delete', { toolId }),
    reorder: (orderedIds: string[]) => invoke('tool_reorder', { orderedIds }),
  },
  shell: {
    openExternal: (url: string) => invoke('open_external', { url }),
  },
  clipboard: {
    readText: () => invoke<string>('clipboard_read'),
    writeText: (text: string) => invoke('clipboard_write', { text }),
  },
  update: {
    onState: (cb: (s: UpdateState) => void) =>
      listen<UpdateState>('update:state', (e) => cb(e.payload)),
    check: () => invoke('update_check'),
  },
  bundle: {
    // Same shapes as the Electron preload / Rust backend (tools_export etc.).
    export: () =>
      invoke<{ canceled: true } | { canceled: false; path: string; count: number; error?: string }>(
        'tools_export',
      ),
    exportOne: (toolId: string) =>
      invoke<{ canceled: true } | { canceled: false; path: string; error?: string }>('export_one', {
        toolId,
      }),
    import: () =>
      invoke<{ canceled: true } | { canceled: false; count: number; error?: string }>('tools_import'),
  },
  refreshMd: () => invoke('refresh_md'),
  fetchMdPreview: (url: string) =>
    invoke<{ markdown: string; error: string | null }>('fetch_md_preview', { url }),
  pickMdFile: () =>
    invoke<{ canceled: true } | { canceled: false; path: string }>('pick_md_file'),
  quick: {
    get: () => invoke<string>('quick_get'),
    save: (md: string) => invoke('quick_save', { md }),
  },
};
