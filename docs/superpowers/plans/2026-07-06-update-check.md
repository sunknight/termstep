# 检查更新与手动下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 TermStep 加上「检查更新 + sidebar 徽章通知 + 手动下载」——启动静默检查 + 菜单手动检查，发现新版本时在左侧 sidebar 底部显示「✦ 有新版本」徽章，点击展开 popover 显示更新日志并提供「去下载」按钮（在系统浏览器打开 DMG）。

**Architecture:** 纯主进程驱动（方案 A）。检查逻辑放 `src/main/updater.ts`：`net.fetch` 拉自托管 JSON manifest、`app.getVersion()` 比对版本、状态变化通过新 IPC 通道 `UPDATE_STATE` 广播给 renderer。renderer 只负责显示徽章。菜单项点击在 main 内直接触发检查。不引入新依赖；semver 比较自写。

**Tech Stack:** Electron 31（main 进程 `net`/`app`/`shell`/`Menu`）、React 18、TypeScript、vitest（纯函数测试，网络用注入 fetch mock）。

**Spec:** `docs/superpowers/specs/2026-07-06-update-check-design.md`

---

## File Structure

**新增：**
- `src/main/updater.ts` — 检查逻辑、状态机、纯函数 API（`checkForUpdates`/`getUpdateState`/`onUpdateState`/`compareVersions`/`parseManifest`）。所有可测纯函数（semver 比较、manifest 解析）都从这里 export。
- `tests/updater.test.ts` — 纯函数测试：semver 比较、manifest 解析。
- `src/renderer/components/UpdateBadge.tsx` — 徽章 + popover 组件。
- `src/renderer/hooks/useUpdateState.ts` — 订阅 `api.update.onState` 的 hook。

**改动：**
- `src/shared/types.ts` — `UPDATE_STATE` / `UPDATE_CHECK` 通道常量 + `UpdateState` 类型。
- `src/preload/index.ts` — `api.update`。
- `src/main/ipc.ts` — `UPDATE_CHECK` handler。
- `src/main/index.ts` — 启动检查接线（whenReady 后延迟 5s）+ 广播接线。
- `src/main/menu.ts` — 「视图」菜单加「检查更新…」。
- `src/renderer/components/Sidebar.tsx` — 在 `.sidebar-io` 下方插入 `<UpdateBadge />`。
- `src/renderer/styles.css` — `.update-badge` + `.update-popover` 样式。

---

## Task 1: 类型与 IPC 通道常量

**Files:**
- Modify: `src/shared/types.ts`

定义共享类型，所有后续 task 依赖它。这是 IPC 契约的单一来源（遵循现有「types.ts 定义通道常量」模式）。

- [ ] **Step 1: 在 `IPC` 常量末尾加两个通道**

在 `src/shared/types.ts` 的 `IPC` 对象里，`QUICK_SAVE: 'quick:save',` 这一行后面加：

```ts
  QUICK_SAVE: 'quick:save',
  UPDATE_STATE: 'update:state',
  UPDATE_CHECK: 'update:check',
```

- [ ] **Step 2: 在文件末尾加 `UpdateState` 类型**

在 `src/shared/types.ts` 末尾（`PtySpawnOpts` 接口之后）追加：

```ts
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
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS（无错误，类型已定义但还没被使用，不会报错）。

- [ ] **Step 4: commit**

```bash
git add src/shared/types.ts
git commit -m "feat(update): 加 UpdateState 类型与 IPC 通道常量"
```

---

## Task 2: semver 比较纯函数（TDD）

**Files:**
- Create: `src/main/updater.ts`
- Test: `tests/updater.test.ts`

先测后写 `compareVersions` —— spec 第 2 节的核心逻辑。纯函数，无副作用，最适合 TDD。

- [ ] **Step 1: 写失败测试**

创建 `tests/updater.test.ts`：

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { compareVersions } from '../src/main/updater';

describe('compareVersions', () => {
  it('returns >0 when remote is newer (patch)', () => {
    expect(compareVersions('0.4.0', '0.3.0')).toBeGreaterThan(0);
  });
  it('returns 0 when equal', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  });
  it('returns <0 when remote is older', () => {
    expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0);
  });
  it('compares numerically not lexically (1.0.0 > 0.9.9)', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
  it('handles two-digit segments (0.10.0 > 0.9.0)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });
  it('returns null for invalid remote version (abc)', () => {
    expect(compareVersions('abc', '0.3.0')).toBeNull();
  });
  it('returns null for invalid remote version (1.2)', () => {
    expect(compareVersions('1.2', '0.3.0')).toBeNull();
  });
  it('returns null for invalid remote version (1.2.3.4)', () => {
    expect(compareVersions('1.2.3.4', '0.3.0')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/updater.test.ts`
Expected: FAIL — `compareVersions is not a function`（模块还没创建）。

- [ ] **Step 3: 写最小实现**

创建 `src/main/updater.ts`：

```ts
// TermStep update checker (main process). Fetches a self-hosted JSON manifest,
// compares its version to app.getVersion(), and tracks a state that the renderer
// renders as a sidebar badge. No auto-download/install — clicking "去下载" opens
// the DMG url in the system browser (unsigned app, no Squirrel).
//
// All testable logic (semver compare, manifest parse) lives here as exported pure
// functions; the stateful check is a thin layer over them.

import type { UpdateState } from '../shared/types';

const MANIFEST_URL =
  process.env['TERMSTEP_UPDATE_URL'] ?? 'https://example.com/termstep/update.json';
const FETCH_TIMEOUT_MS = 10_000;

// Compare two `X.Y.Z` version strings. Returns >0 if `remote > current`, 0 if
// equal, <0 if `remote < current`, or null if `remote` is not a valid `X.Y.Z`
// (each of X/Y/Z must be a non-negative integer). `current` is assumed valid
// (it comes from package.json); we still guard it defensively.
export function compareVersions(remote: string, current: string): number | null {
  const r = parseSemver(remote);
  const c = parseSemver(current);
  if (!r || !c) return null;
  for (let i = 0; i < 3; i++) {
    if (r[i] > c[i]) return 1;
    if (r[i] < c[i]) return -1;
  }
  return 0;
}

// Parse "X.Y.Z" into [major, minor, patch] numbers, or null if malformed.
// Rejects: non-numeric, negative, missing segments, extra segments, leading
// zeros are allowed (0.03.0 == 0.3.0 numerically).
function parseSemver(v: string): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const parts = v.split('.');
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return [nums[0], nums[1], nums[2]];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/updater.test.ts`
Expected: PASS — 8 个用例全过。

- [ ] **Step 5: commit**

```bash
git add src/main/updater.ts tests/updater.test.ts
git commit -m "feat(update): semver 比较纯函数 + 测试"
```

---

## Task 3: manifest 解析纯函数（TDD）

**Files:**
- Modify: `src/main/updater.ts`
- Test: `tests/updater.test.ts`

加 `parseManifest` —— 校验 manifest JSON 并提取 `version`/`url`/`notes`。纯函数。

- [ ] **Step 1: 在测试文件追加失败测试**

在 `tests/updater.test.ts` 末尾追加：

```ts
import { parseManifest } from '../src/main/updater';

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const r = parseManifest('{"version":"0.4.0","url":"https://x/d.dmg","notes":"fix"}');
    expect(r).toEqual({ version: '0.4.0', url: 'https://x/d.dmg', notes: 'fix' });
  });
  it('defaults notes to empty string when omitted', () => {
    const r = parseManifest('{"version":"0.4.0","url":"https://x/d.dmg"}');
    expect(r).toEqual({ version: '0.4.0', url: 'https://x/d.dmg', notes: '' });
  });
  it('returns null for invalid JSON', () => {
    expect(parseManifest('not json')).toBeNull();
  });
  it('returns null when version is missing', () => {
    expect(parseManifest('{"url":"https://x/d.dmg"}')).toBeNull();
  });
  it('returns null when url is missing', () => {
    expect(parseManifest('{"version":"0.4.0"}')).toBeNull();
  });
  it('returns null when version is not a string', () => {
    expect(parseManifest('{"version":4,"url":"https://x"}')).toBeNull();
  });
  it('returns null when url is not a string', () => {
    expect(parseManifest('{"version":"0.4.0","url":5}')).toBeNull();
  });
});
```

注意：因为同一个文件里两个 `import { ... } from '../src/main/updater'` 会冲突，把顶部的 import 合并。最终测试文件顶部应该是：

```ts
import { compareVersions, parseManifest } from '../src/main/updater';
```

（删掉 Task 2 里那行单独的 `import { compareVersions } ...`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/updater.test.ts`
Expected: FAIL — `parseManifest is not a function`。

- [ ] **Step 3: 写最小实现**

在 `src/main/updater.ts` 的 `compareVersions` 函数后面、`parseSemver` 前面，加：

```ts
// Validated manifest shape. `parseManifest` returns this or null.
export interface ParsedManifest {
  version: string;
  url: string;
  notes: string;
}

// Parse and validate the remote manifest JSON. Returns null for any malformed
// payload (non-JSON, missing version/url, wrong types). notes defaults to "".
// We deliberately accept ONLY these three fields and ignore extras.
export function parseManifest(raw: string): ParsedManifest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const version = o['version'];
  const url = o['url'];
  const notes = o['notes'];
  if (typeof version !== 'string' || typeof url !== 'string') return null;
  if (version.length === 0 || url.length === 0) return null;
  return { version, url, notes: typeof notes === 'string' ? notes : '' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/updater.test.ts`
Expected: PASS — 全部 15 个用例（8 semver + 7 manifest）通过。

- [ ] **Step 5: commit**

```bash
git add src/main/updater.ts tests/updater.test.ts
git commit -m "feat(update): manifest 解析纯函数 + 测试"
```

---

## Task 4: 状态机与 checkForUpdates

**Files:**
- Modify: `src/main/updater.ts`

加有状态层：模块级状态变量、回调注册、`checkForUpdates`（带超时、防重入、manual 分支、去重）、`getUpdateState`、`onUpdateState`、`initUpdateState`（读去重标记初始化状态）。`fetch` 与文件读写通过注入，便于测试。

- [ ] **Step 1: 在 `src/main/updater.ts` 追加状态机**

在文件末尾追加（`import` 已有 `UpdateState`；需要补 `fs` 和 `net` 的动态导入，因为 Electron 的 `net` 只能在 main 运行时用，测试不直接调 `checkForUpdates`——见测试策略说明）：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';

// Dedup store path: <userData>/update-state.json holds the last version we
// notified the user about, so a repeat launch with the same available version
// doesn't re-flag. Manual checks ignore this.
const STATE_FILE = () => path.join(app.getPath('userData'), 'update-state.json');

// --- Stateful layer (main process only) ---
let state: UpdateState = { status: 'idle' };
let checking = false;
const listeners = new Set<(s: UpdateState) => void>();

// Read the "already notified" version from disk (if any). Used to suppress
// repeat auto-notifications for the same version across launches.
function readNotifiedVersion(): string | null {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf8');
    const obj = JSON.parse(raw) as { version?: unknown };
    return typeof obj.version === 'string' ? obj.version : null;
  } catch {
    return null;
  }
}

// Record that we've notified the user about `version`.
function writeNotifiedVersion(version: string): void {
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ version }));
  } catch {
    // non-fatal — dedup is best-effort
  }
}

function setState(next: UpdateState): void {
  state = next;
  for (const cb of listeners) cb(state);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function onUpdateState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Fetch the manifest and update state. `manual=true` surfaces errors to the UI
// (user clicked "检查更新"); `manual=false` (auto check) fails silently.
// Guarded against re-entry (concurrent calls return current state).
export async function checkForUpdates(opts: { manual: boolean }): Promise<UpdateState> {
  if (checking) return state;
  checking = true;
  try {
    if (opts.manual) setState({ status: 'checking' });
    const raw = await fetchManifest(MANIFEST_URL);
    const manifest = parseManifest(raw);
    if (!manifest) {
      if (opts.manual) setState({ status: 'error', error: '更新信息格式无效' });
      // silent on auto — leave state as-is (idle)
      return state;
    }
    const cmp = compareVersions(manifest.version, app.getVersion());
    if (cmp === null) {
      if (opts.manual) setState({ status: 'error', error: '更新版本号格式无效' });
      return state;
    }
    if (cmp > 0) {
      // Dedup: an auto check for a version we already notified about stays idle.
      if (!opts.manual && readNotifiedVersion() === manifest.version) {
        return state;
      }
      setState({
        status: 'available',
        version: manifest.version,
        url: manifest.url,
        notes: manifest.notes,
      });
      writeNotifiedVersion(manifest.version);
    } else {
      if (opts.manual) setState({ status: 'upToDate' });
    }
    return state;
  } catch {
    if (opts.manual) setState({ status: 'error', error: '检查更新失败，请检查网络后重试' });
    return state;
  } finally {
    checking = false;
  }
}

// Fetch `url` with a 10s timeout, return its body text. Throws on non-2xx or
// network error. Uses Electron's `net` (respects system proxy settings).
function fetchManifest(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('timeout'));
    }, FETCH_TIMEOUT_MS);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}
```

注意 import 调整：把文件顶部的 `import type { UpdateState } from '../shared/types';` 保留，并在其下方加上面三个 import（`fs`/`path`/`electron`）。`app`/`net` 来自 `electron`，`fs`/`path` 来自 `node:`。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: commit**

```bash
git add src/main/updater.ts
git commit -m "feat(update): 状态机与 checkForUpdates（超时/防重入/去重）"
```

（`checkForUpdates` 本身不写自动化测试——它依赖 Electron 的 `net`/`app`/磁盘，属集成层，遵循项目既有范围。纯逻辑 `compareVersions`/`parseManifest` 已在 Task 2/3 覆盖。）

---

## Task 5: preload 暴露 api.update

**Files:**
- Modify: `src/preload/index.ts`

遵循现有 preload 模式（`onXxx` 返回 offFn，`invoke` 包裹）。

- [ ] **Step 1: 在 `api` 对象加 `update`**

在 `src/preload/index.ts` 里，找到 `clipboard: { ... }` 块（约 50-57 行），在其后、`bundle:` 之前，插入：

```ts
  update: {
    // Main pushes UpdateState whenever the check result changes. The renderer's
    // useUpdateState hook subscribes; initial state arrives via the first push
    // (main broadcasts on window ready) — no separate "get current" IPC needed.
    onState: (cb: (s: UpdateState) => void) => {
      const h = (_e: unknown, s: UpdateState) => cb(s);
      ipcRenderer.on(IPC.UPDATE_STATE, h);
      return () => {
        ipcRenderer.off(IPC.UPDATE_STATE, h);
      };
    },
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  },
```

- [ ] **Step 2: 补 import**

把文件顶部的 import 改成包含 `UpdateState`：

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ScanResult, type ToolMeta, type PtySpawnOps, type UpdateState } from '../shared/types';
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS（preload 属 tsconfig.node，`UpdateState` 已在 shared 定义）。

- [ ] **Step 4: commit**

```bash
git add src/preload/index.ts
git commit -m "feat(update): preload 暴露 api.update（onState/check）"
```

---

## Task 6: main 接线（IPC handler + 启动检查 + 广播 + 菜单）

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/menu.ts`

把 updater 接进 main：注册 `UPDATE_CHECK` handler、启动延迟检查、状态广播到所有窗口、菜单项。

- [ ] **Step 1: 在 `src/main/ipc.ts` 注册 handler**

在 `registerIpc` 函数里，紧接 `ipcMain.handle(IPC.QUICK_SAVE, ...)` 之后（文件末尾的 `});` 之前），加：

```ts
  ipcMain.handle(IPC.UPDATE_CHECK, async () => {
    // Manual check: surface result (including errors) to the UI.
    return updater.checkForUpdates({ manual: true });
  });
```

并在 `ipc.ts` 顶部加 import：

```ts
import * as updater from './updater';
```

（用 namespace import 避免 name 冲突。）

- [ ] **Step 2: 在 `src/main/index.ts` 接广播 + 启动检查**

在 `src/main/index.ts` 顶部 import 区加：

```ts
import * as updater from './updater';
```

在 `app.whenReady().then(async () => { ... })` 块内，紧接 `await createWindow();`（约 107 行）之后、`app.on('activate', ...)` 之前，加：

```ts
  // Auto-update: broadcast every updater state change to all renderer windows
  // (sidebar badge subscribes via api.update.onState). Then kick a silent check
  // ~5s after startup (delayed so window/pty/tools scan settle first; auto
  // checks fail silently when offline — no UI noise).
  updater.onUpdateState((s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.UPDATE_STATE, s);
  });
  // Re-broadcast current state to any newly opened window (e.g. mac re-activate
  // after window-all-closed on other platforms — here mainly for consistency).
  app.on('browser-window-created', (_e, w) => {
    w.webContents.once('did-finish-load', () => w.webContents.send(IPC.UPDATE_STATE, updater.getUpdateState()));
  });
  setTimeout(() => {
    void updater.checkForUpdates({ manual: false });
  }, 5000);
```

- [ ] **Step 3: 在 `src/main/menu.ts` 加菜单项**

在 `setAppMenu` 函数的「视图」菜单 submenu 数组（`label: '视图'` 下）**最前面**插入「检查更新…」和一个分隔符。把视图菜单块改成：

```ts
    {
      label: '视图',
      submenu: [
        {
          label: '检查更新…',
          click: () => {
            void import('./updater').then((m) => m.checkForUpdates({ manual: true }));
          },
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
```

注意：菜单用动态 `import('./updater')` 而非顶层 import，避免 `menu.ts` ↔ `updater.ts` 形成循环（`updater.ts` 不 import `menu.ts`，但用动态 import 更稳，也避免 menu 加载时机问题）。

- [ ] **Step 4: typecheck + test**

Run: `npm run typecheck && npm test`
Expected: PASS（typecheck 无错；120 个测试仍全过，新增 updater 测试也过）。

- [ ] **Step 5: commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/main/menu.ts
git commit -m "feat(update): main 接线（IPC handler/启动检查/广播/菜单项）"
```

---

## Task 7: useUpdateState hook

**Files:**
- Create: `src/renderer/hooks/useUpdateState.ts`

订阅 `api.update.onState`，初值 `{ status: 'idle' }`（main 在 window ready 时会主动广播一次当前状态，hook 收到即更新）。遵循现有 `useTools` hook 模式。

- [ ] **Step 1: 创建 hook**

创建 `src/renderer/hooks/useUpdateState.ts`：

```ts
import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/types';

// Subscribe to update-check state from the main process. Initial value is idle;
// main pushes the real current state shortly after window load (see
// index.ts browser-window-created / did-finish-load broadcast). Only `available`
// renders the sidebar badge; manual-check results surface transiently.
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => window.api.update.onState(setState), []);
  return state;
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS（`api.update` 类型已在 Task 5 通过 preload 的 `Api` 类型 export 暴露给 renderer）。

- [ ] **Step 3: commit**

```bash
git add src/renderer/hooks/useUpdateState.ts
git commit -m "feat(update): useUpdateState hook"
```

---

## Task 8: UpdateBadge 组件 + CSS

**Files:**
- Create: `src/renderer/components/UpdateBadge.tsx`
- Modify: `src/renderer/styles.css`

徽章：`available` 时显示「✦ 有新版本」，点击展开 popover（版本号、notes、「去下载」「稍后再说」「再检查」）。`upToDate`/`error` 在手动检查后通过临时 popover 反馈 3 秒。`api.update` 类型来自 preload 的 `Api`（`global.d.ts` 已让 `window.api` 有完整类型，无需改 global.d.ts）。

- [ ] **Step 1: 创建组件**

创建 `src/renderer/components/UpdateBadge.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUpdateState } from '../hooks/useUpdateState';
import type { UpdateState } from '../../shared/types';

// A transient, self-dismissing popover for manual-check feedback ("已是最新版本"
// / "检查失败…"). Shown for 3s after a manual check resolves to upToDate/error,
// then disappears. Distinct from the available-version popover (which stays open
// until the user acts on it).
const TRANSIENT_MS = 3000;

// Sidebar "✦ 有新版本" badge + popover. Rendered at the bottom of the sidebar,
// below the import/export buttons. Only the `available` state shows the badge;
// manual checks that resolve to upToDate/error pop a brief message.
export function UpdateBadge() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false); // available-version popover open?
  const [transient, setTransient] = useState<string | null>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);

  // Detect a manual check completing in upToDate/error and flash a transient
  // message. We key off the status changing INTO upToDate/error (the renderer
  // can't tell manual from auto directly, but auto checks never set these
  // states — see updater.checkForUpdates — so any upToDate/error here is manual).
  const prevStatus = useRef<UpdateState['status']>('idle');
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = state.status;
    if (state.status === prev) return;
    if (state.status === 'upToDate') {
      setTransient('当前已是最新版本');
      setOpen(false);
    } else if (state.status === 'error') {
      setTransient(state.error);
      setOpen(false);
    } else {
      setTransient(null);
    }
  }, [state]);

  useEffect(() => {
    if (transient === null) return;
    const t = window.setTimeout(() => setTransient(null), TRANSIENT_MS);
    return () => clearTimeout(t);
  }, [transient]);

  if (state.status !== 'available' && transient === null) return null;

  return (
    <>
      {state.status === 'available' && (
        <button
          ref={badgeRef}
          className="update-badge"
          onClick={() => setOpen((v) => !v)}
          title={`新版本 v${state.version}`}
        >
          ✦ 有新版本
        </button>
      )}

      {(open || transient !== null) &&
        badgeRef.current &&
        createPortal(
          <div
            className="update-popover"
            style={popoverPos(badgeRef.current)}
            onClick={(e) => e.stopPropagation()}
          >
            {transient !== null ? (
              <div className="up-transient">{transient}</div>
            ) : state.status === 'available' ? (
              <>
                <div className="up-title">✦ 新版本 v{state.version}</div>
                {state.notes && <div className="up-notes">{state.notes}</div>}
                <div className="up-actions">
                  <button
                    className="up-primary"
                    onClick={() => void window.api.shell.openExternal(state.url)}
                  >
                    去下载
                  </button>
                  <button className="up-secondary" onClick={() => setOpen(false)}>
                    稍后再说
                  </button>
                </div>
                <button
                  className="up-recheck"
                  onClick={() => void window.api.update.check()}
                >
                  再检查一次
                </button>
              </>
            ) : null}
          </div>,
          document.body
        )}
    </>
  );
}

// Position the portal popover just above the badge, aligned to the badge's left
// edge, clamped to the viewport.
function popoverPos(anchor: HTMLElement): React.CSSProperties {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 280));
  return { left: `${left}px`, top: `${Math.max(8, r.top - 8)}px`, transform: 'translate(0, -100%)' };
}
```

- [ ] **Step 2: 加 CSS**

在 `src/renderer/styles.css` 末尾追加（配色与 `.io-btn`/`.notif` 一致：浅底、细边框、小圆角、12px 字号）：

```css
/* Update badge + popover (sidebar bottom). */
.update-badge {
  display: block;
  margin-top: 6px;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid #f0b8b8;
  background: #fff0f0;
  color: #b00;
  border-radius: 6px;
  text-align: center;
}
.update-badge:hover { background: #ffe0e0; }

.update-popover {
  position: fixed;
  z-index: 300;
  width: 264px;
  background: #fff;
  border: 1px solid #cfd2da;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.45;
}
.update-popover .up-title { font-weight: 600; color: #b00; margin-bottom: 6px; }
.update-popover .up-notes {
  white-space: pre-wrap; word-break: break-word; color: #333;
  max-height: 160px; overflow-y: auto; margin-bottom: 8px;
}
.update-popover .up-actions { display: flex; gap: 8px; margin-bottom: 6px; }
.update-popover .up-primary {
  flex: 1; cursor: pointer; padding: 6px; font-size: 12px;
  border: 1px solid #6b8cff; background: #4a6cff; color: #fff; border-radius: 6px;
}
.update-popover .up-primary:hover { background: #3a5cff; }
.update-popover .up-secondary {
  flex: 1; cursor: pointer; padding: 6px; font-size: 12px;
  border: 1px solid #cfd2da; background: #fff; color: #555; border-radius: 6px;
}
.update-popover .up-secondary:hover { background: #f2f3f6; }
.update-popover .up-recheck {
  display: block; margin-left: auto; cursor: pointer; font-size: 11px;
  color: #6b8cff; background: transparent; border: 0; padding: 0;
}
.update-popover .up-recheck:hover { color: #3a5cff; }
.update-popover .up-transient { color: #555; }
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: commit**

```bash
git add src/renderer/components/UpdateBadge.tsx src/renderer/styles.css
git commit -m "feat(update): UpdateBadge 徽章与 popover 组件 + CSS"
```

---

## Task 9: 把 UpdateBadge 接进 Sidebar

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

在 `.sidebar-io`（导入导出按钮区）下方插入 `<UpdateBadge />`。组件自己用 hook 取状态，Sidebar 不需传 props。

- [ ] **Step 1: 在 Sidebar 渲染 UpdateBadge**

在 `src/renderer/components/Sidebar.tsx` 顶部 import 区加：

```ts
import { UpdateBadge } from './UpdateBadge';
```

把 `.sidebar-io` 那段（约 108-111 行）改成在 div 内最后插入 `<UpdateBadge />`：

```tsx
      <div className="sidebar-io">
        <button className="io-btn" onClick={props.onExport} title="导出全部工具为 JSON">⤓ 导出</button>
        <button className="io-btn" onClick={props.onImport} title="从 JSON 导入工具">⤒ 导入</button>
      </div>
      <UpdateBadge />
      {!props.floating && <div className="sidebar-resizer" onMouseDown={startDrag} title="拖动调整宽度" />}
```

注意 `<UpdateBadge />` 放在 `.sidebar-io` div **外面**（它是 sidebar nav 的直接子元素，在 io 区和 resizer 之间），这样徽章宽度撑满 sidebar（与 `.new-tool` 一致）。

- [ ] **Step 2: typecheck + test**

Run: `npm run typecheck && npm test`
Expected: PASS（typecheck 无错；测试全过）。

- [ ] **Step 3: commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(update): Sidebar 接入 UpdateBadge 徽章"
```

---

## Task 10: 手动验证

**Files:** 无（纯验证）

按 spec 的手动验证清单跑一遍。dev 模式下用本地 manifest 测。

- [ ] **Step 1: 准备本地 manifest**

在项目根建一个临时文件 `update-test.json`（不要 commit，或建在 /tmp）：

```bash
mkdir -p /tmp/ts-update && cat > /tmp/ts-update/update.json <<'EOF'
{"version":"99.9.9","url":"https://example.com/TermStep-99.9.9.dmg","notes":"测试更新\n- 修复 Cmd+V\n- 新增检查更新"}
EOF
```

起一个静态服务器（任选一个）：

```bash
cd /tmp/ts-update && python3 -m http.server 8000
```

- [ ] **Step 2: 启动 dev 验证「有新版本」徽章**

新终端：

```bash
TERMSTEP_UPDATE_URL=http://localhost:8000/update.json npm run dev
```

Expected: 启动后约 5 秒，左侧 sidebar 底部（导入导出按钮下方）出现「✦ 有新版本」徽章。

- [ ] **Step 3: 验证 popover**

点击徽章 → popover 展开，显示「✦ 新版本 v99.9.9」、notes（含换行）、「去下载」「稍后再说」「再检查一次」三按钮。点「去下载」→ 系统浏览器打开 `https://example.com/TermStep-99.9.9.dmg`。点「稍后再说」→ popover 关闭，徽章仍在。

- [ ] **Step 4: 验证去重**

退出 app，重新 `npm run dev`（同样的 `TERMSTEP_UPDATE_URL`）。
Expected: 这次徽章**不出现**（同版本已去重，`update-state.json` 记了 `99.9.9`）。

- [ ] **Step 5: 验证手动检查覆盖去重**

清除去重标记：

```bash
rm ~/Library/Application\ Support/TermStep/update-state.json
```

启动后徽章出现 → 点徽章 → 「稍后再说」关闭 popover（徽章仍在）→ 此时去重已写入 → 点徽章展开 → 点「再检查一次」。
Expected: 即使已去重，手动「再检查一次」仍正常执行（popover 重新拉一次 manifest，仍显示 available）。这个分支验证手动检查不读去重标记。

- [ ] **Step 6: 验证「已是最新版本」**

改 manifest 版本 ≤ 当前（package.json 是 0.3.0）：

```bash
cat > /tmp/ts-update/update.json <<'EOF'
{"version":"0.3.0","url":"https://example.com/x.dmg","notes":""}
EOF
```

清去重标记，重启 dev。徽章不出现（自动检查 → upToDate 但 auto 不广播 upToDate，所以无 UI）。然后菜单「视图 → 检查更新…」。
Expected: 菜单点击后，popover 闪现「当前已是最新版本」，3 秒后消失。

- [ ] **Step 7: 验证断网静默**

清去重标记，断网（关 WiFi），重启 dev。
Expected: 启动后无任何提示、无报错（auto 检查失败静默）。控制台无 uncaught error。

- [ ] **Step 8: 清理**

删除临时 manifest 与服务器进程（Ctrl+C）。可选：清 `update-state.json` 与 `update-test.json`。

```bash
rm -f update-test.json
```

- [ ] **Step 9: 最终全量验证**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS；全部测试通过（120 + 15 updater = 135）。

---

## Self-Review 记录

**1. Spec coverage（逐节核对）：**
- 第 1 节 manifest 格式 / URL 来源 / semver 自写 → Task 2 (semver) + Task 3 (parse) + Task 4 (`MANIFEST_URL` env fallback)。✓
- 第 2 节 状态机 / 触发时机 / 去重 / manual 分支 / 防重入 / 超时 → Task 4 (`checkForUpdates`/`readNotifiedVersion`/`writeNotifiedVersion`/`checking` guard/`AbortController`-equivalent timeout via `req.abort()`) + Task 6 (启动延迟 5s + `setTimeout`)。✓
- 第 3 节 IPC 通道 / preload api / 菜单项 / 徽章 UI / popover → Task 1 (通道+类型) + Task 5 (preload) + Task 6 (IPC handler + 菜单) + Task 7 (hook) + Task 8 (badge+popover) + Task 9 (Sidebar 接入)。✓
- 第 4 节 边界情况（无网络/404/非法 JSON/超时/版本格式/≤当前/离线/重复启动/dev 模式）→ Task 4 错误分支覆盖；测试在 Task 2/3 覆盖纯函数。✓
- 第 4 节 测试策略（纯函数测试，不测集成）→ Task 2/3。✓
- 第 4 节 手动验证清单 → Task 10。✓

**2. Placeholder scan:** 无 TBD/TODO/"适当处理"等。每个代码步骤都有完整代码。✓

**3. Type consistency:**
- `UpdateState` union（Task 1 定义）→ Task 4/5/7/8 全部用同一形态（`status` 判别 + available 带 `version`/`url`/`notes`，error 带 `error`）。✅
- `compareVersions(remote, current)` 签名 Task 2 定义，Task 4 调用 `compareVersions(manifest.version, app.getVersion())` 顺序一致。✅
- `parseManifest(raw): ParsedManifest | null` Task 3 定义，Task 4 调用一致。✅
- `checkForUpdates({ manual })` Task 4 定义，Task 6（IPC + 菜单）调用一致。✅
- `api.update.onState(cb)` / `api.update.check()` Task 5 定义，Task 7/8 调用一致。✅
- `onUpdateState`/`getUpdateState` Task 4 定义，Task 6 调用一致。✅
