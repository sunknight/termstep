// TEMPORARY runtime stub for `window.api`. Stage 1 (Tauri scaffold) has no IPC
// wired up yet, but the renderer references window.api.* everywhere — without a
// stub, the first access (e.g. window.api.tools) throws "undefined is not an
// object" and ErrorBoundary shows "出错了" instead of the UI.
//
// This stub lets the React UI render: tools list is empty, terminals get no PTY
// output, update state stays idle. It is REPLACED entirely in Stage 2 by
// src/renderer/lib/api.ts (real Tauri invoke/listen wrappers). Delete this file
// (and its import in main.tsx) once the IPC layer migration lands.
//
// Shape mirrors preload/index.ts so every window.api.* call site compiles and
// runs without throwing.

// A no-op unsubscribe, matching the Electron-era contract where event-subscribe
// methods return a sync cleanup function (so `return window.api.x.onY(cb)` in a
// useEffect cleanup works). The Tauri adapter in Stage 2 returns a Promise
// instead — that difference is handled there, not here.
const noop = () => {};
const noopUnsub = () => noop;

// All "invoke-shaped" methods return a resolved Promise of a sensible empty
// value, so `.then(...)` chains don't break.
const emptyScanResult = { tools: [], errors: [] };
const emptyStr = () => Promise.resolve('');
const voidP = () => Promise.resolve();

export const stubApi = {
  tools: {
    list: () => Promise.resolve(emptyScanResult),
    onChanged: noopUnsub,
  },
  pty: {
    onData: noopUnsub,
    write: voidP,
    open: voidP,
    restart: voidP,
    resize: voidP,
    cwd: emptyStr,
    kill: voidP,
  },
  tool: {
    save: voidP,
    appendButtons: voidP,
    create: () => Promise.resolve(''),
    del: voidP,
    reorder: voidP,
  },
  shell: { openExternal: voidP },
  clipboard: { readText: emptyStr, writeText: noop },
  update: { onState: noopUnsub, check: voidP },
  bundle: {
    export: () => Promise.resolve({ canceled: true }),
    exportOne: (_id: string) => Promise.resolve({ canceled: true }),
    import: () => Promise.resolve({ canceled: true }),
  },
  refreshMd: voidP,
  fetchMdPreview: (_url: string) => Promise.resolve({ markdown: '', error: 'stub' }),
  pickMdFile: () => Promise.resolve({ canceled: true }),
  quick: { get: emptyStr, save: voidP },
} as const;
