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
    kill: (toolId: string) => ipcRenderer.invoke(IPC.PTY_KILL, toolId),
  },
  tool: {
    save: (toolId: string, markdown: string, meta: Partial<ToolMeta>) =>
      ipcRenderer.invoke(IPC.TOOL_SAVE, toolId, markdown, meta),
    create: (name: string) => ipcRenderer.invoke(IPC.TOOL_CREATE, name) as Promise<string>,
    del: (toolId: string) => ipcRenderer.invoke(IPC.TOOL_DELETE, toolId),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC.TOOL_REORDER, orderedIds),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
