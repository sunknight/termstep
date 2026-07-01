import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ScanResult, type ToolMeta, type PtySpawnOpts } from '../shared/types';

const api = {
  tools: {
    list: (): Promise<ScanResult> => ipcRenderer.invoke(IPC.TOOLS_LIST),
    onChanged: (cb: (r: ScanResult) => void) => {
      const h = (_e: unknown, r: ScanResult) => cb(r);
      ipcRenderer.on(IPC.TOOLS_CHANGED, h);
      return () => {
        ipcRenderer.off(IPC.TOOLS_CHANGED, h);
      };
    },
  },
  pty: {
    onData: (cb: (toolId: string, data: string) => void) => {
      const h = (_e: unknown, payload: { toolId: string; data: string }) => cb(payload.toolId, payload.data);
      ipcRenderer.on(IPC.PTY_DATA, h);
      return () => {
        ipcRenderer.off(IPC.PTY_DATA, h);
      };
    },
    write: (toolId: string, data: string, opts?: PtySpawnOpts) =>
      ipcRenderer.invoke(IPC.PTY_WRITE, toolId, data, opts),
    open: (toolId: string, opts?: PtySpawnOpts) =>
      ipcRenderer.invoke(IPC.PTY_OPEN, toolId, opts),
    restart: (toolId: string, opts?: PtySpawnOpts) =>
      ipcRenderer.invoke(IPC.PTY_RESTART, toolId, opts),
    resize: (toolId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.PTY_RESIZE, toolId, cols, rows),
    // Live cwd of the tool's shell (follows the user's cd).
    cwd: (toolId: string) => ipcRenderer.invoke(IPC.PTY_CWD, toolId) as Promise<string>,
    kill: (toolId: string) => ipcRenderer.invoke(IPC.PTY_KILL, toolId),
  },
  tool: {
    save: (toolId: string, markdown: string, meta: Partial<ToolMeta>) =>
      ipcRenderer.invoke(IPC.TOOL_SAVE, toolId, markdown, meta),
    create: (name: string) => ipcRenderer.invoke(IPC.TOOL_CREATE, name) as Promise<string>,
    del: (toolId: string) => ipcRenderer.invoke(IPC.TOOL_DELETE, toolId),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC.TOOL_REORDER, orderedIds),
  },
  shell: {
    // Open an external http(s)/mailto link in the default browser.
    openExternal: (url: string) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  },
  bundle: {
    export: () => ipcRenderer.invoke(IPC.TOOLS_EXPORT),
    exportOne: (toolId: string) => ipcRenderer.invoke(IPC.TOOL_EXPORT_ONE, toolId),
    import: () => ipcRenderer.invoke(IPC.TOOLS_IMPORT),
  },
  refreshMd: () => ipcRenderer.invoke(IPC.TOOL_REFRESH_MD),
  // Preview-fetch a URL (no save). Returns {markdown, error}.
  fetchMdPreview: (url: string) =>
    ipcRenderer.invoke(IPC.MD_FETCH_PREVIEW, url) as Promise<{
      markdown: string;
      error: string | null;
    }>,
  quick: {
    get: () => ipcRenderer.invoke(IPC.QUICK_GET) as Promise<string>,
    save: (md: string) => ipcRenderer.invoke(IPC.QUICK_SAVE, md),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
