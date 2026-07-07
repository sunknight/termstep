// TEMPORARY: keeps `window.api.*` references compiling while the IPC layer is
// migrated to Tauri (Stage 2). The runtime value comes from lib/stubApi.ts
// (injected in main.tsx); this declaration only carries the TYPE so renderer
// call sites stay type-checked exactly as under Electron. Removed once
// src/renderer/lib/api.ts replaces all window.api call sites.
import type { Api } from '../../preload/index';

export {};

declare global {
  interface Window {
    api: Api;
  }
}
