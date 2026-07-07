// TEMPORARY: keeps `window.api.*` references compiling while the IPC layer is
// migrated to Tauri (Stage 2). Removed once src/renderer/lib/api.ts replaces
// all window.api call sites.
export {};

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: any;
  }
}
