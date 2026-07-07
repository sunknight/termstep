# Tauri 迁移 · 阶段 1：脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 Tauri v2 工程骨架，让 `tauri dev` 能启动一个原生窗口并加载现有 React renderer，验证 WKWebView 渲染兼容性——为后续模块迁移铺好地基。

**Architecture:** 在 worktree 根目录新增 `src-tauri/`（Rust 工程），保留现有 `src/renderer` 和 `src/shared`。renderer 改用普通 Vite 构建（替代 electron-vite），Tauri 在 dev 时连接 Vite dev server、打包时嵌入 Vite 构建产物。本阶段不接任何 IPC——只验证「原生窗口 + WebView 加载 React」这一最基础链路。临时保留 Electron 相关文件不删，避免中间态破坏；阶段 4 再清理。

**Tech Stack:** Tauri v2（已装 cargo tauri-cli 2.11.4）、Rust 1.92、Vite 5、React 18、TypeScript 5。本阶段涉及命令：`tauri dev`、`cargo build`、`vite build`。

**关联 Spec:** `docs/superpowers/specs/2026-07-07-migrate-to-tauri-design.md`（第一节·整体架构、第八节·打包配置）

**前置事实（已核实）:**
- 工具链就绪：`rustc 1.92.0`、`cargo tauri-cli 2.11.4`、`node v25.3.0`。
- `build/` 目录被 `.gitignore` 第 7 行 `build/` 忽略，且现有的 `!build/icon.png`/`!build/icon.svg` 例外**未生效**（git 对被忽略目录的子文件 unignore 需先 unignore 目录）。`build/icon.svg`（894 字节）和 `build/icon.png`（157KB）均**未纳入版本控制**——迁移时需重新处理图标源。
- 现有 `scripts/render-icon.cjs` 依赖 Electron 渲染 SVG→PNG，迁移后失效。
- renderer 入口：`src/renderer/index.html` → `src/renderer/main.tsx`。
- 现有 `tsconfig.web.json` 的 `include` 含 `src/preload/global.d.ts`（删除 preload 后需移除该引用）。

---

## File Structure（本阶段涉及）

**Create:**
- `src-tauri/Cargo.toml` — Rust 依赖（tauri v2）
- `src-tauri/tauri.conf.json` — Tauri 配置（窗口、构建钩子、bundle）
- `src-tauri/build.rs` — Tauri 构建脚本（必需）
- `src-tauri/src/main.rs` — 最小 main，初始化 Tauri + 创建窗口
- `src-tauri/src/lib.rs` — Tauri app builder（v2 推荐 lib/bin 分离，便于测试）
- `src-tauri/capabilities/default.json` — Tauri v2 权限声明（最小窗口权限）
- `vite.config.ts` — 普通 Vite 配置（替代 electron.vite.config.ts，仅 renderer）
- `assets/icon.svg` — 图标源（从 build/icon.svg 迁移，纳入版本控制）

**Modify:**
- `package.json` — 精简 scripts（dev/build/typecheck），新增 @tauri-apps 依赖；**本阶段暂不删除 electron 依赖**（避免破坏，阶段 4 清理）
- `.gitignore` — 调整 build/ 规则、加 `src-tauri/target/`
- `tsconfig.web.json` — 移除 `src/preload/global.d.ts` 引用（preload 将弃用）

**不动（本阶段）:** `src/renderer/**`（UI 全保留）、`src/shared/**`、`src/main/**`、`src/preload/**`、`electron.vite.config.ts`、`electron-builder.yml`——这些在后续阶段处理。

---

## Task 1: 创建 Tauri Rust 工程骨架

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`

- [ ] **Step 1: 创建 Cargo.toml**

创建 `src-tauri/Cargo.toml`：

```toml
[package]
name = "termstep"
version = "0.5.0"
description = "Local macOS app to run CLI commands via menus and buttons"
edition = "2021"
rust-version = "1.77"

[lib]
name = "termstep_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

说明：`macos-private-api` feature 用于后续可能需要的原生集成；`[lib]` 的 `crate-type` 含 `cdylib`/`staticlib` 是 Tauri v2 macOS 目标所需。本阶段只依赖 tauri + serde，后续模块任务再加 portable-pty/notify/reqwest 等。

- [ ] **Step 2: 创建 build.rs**

创建 `src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: 创建 lib.rs（Tauri app builder）**

创建 `src-tauri/src/lib.rs`：

```rust
// Tauri v2 推荐 lib/bin 分离：lib 持有 app 构造逻辑（便于将来 #[cfg(test)] 单测），
// main.rs 只是薄入口。本阶段无 command、无 setup，只创建窗口加载前端。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

说明：`#[cfg(debug_assertions)]` 让 dev 自动开 devtools（对应当前 Electron dev 默认开 devtools 的行为）。`generate_context!()` 会读 `tauri.conf.json` 和 `capabilities/`。

- [ ] **Step 4: 创建 main.rs（薄入口）**

创建 `src-tauri/src/main.rs`：

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    termstep_lib::run()
}
```

- [ ] **Step 5: 验证 cargo 能解析（先不构建，缺 tauri.conf.json 会报错属正常）**

Run: `cd src-tauri && cargo check 2>&1 | head -20`
Expected: 报错 `tauri-build` 找不到 `tauri.conf.json` 或 capability 缺失——这是预期的，下一任务补配置。确认 Cargo.toml 语法本身无误（无 "failed to parse manifest" 错误）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/build.rs src-tauri/src/main.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): scaffold src-tauri Rust project (Cargo.toml, main, lib, build)"
```

---

## Task 2: 创建 Tauri 配置与权限

**Files:**
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`

- [ ] **Step 1: 创建 tauri.conf.json**

创建 `src-tauri/tauri.conf.json`：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "TermStep",
  "version": "0.5.0",
  "identifier": "local.termstep",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev:web",
    "beforeBuildCommand": "npm run build:web"
  },
  "app": {
    "windows": [
      {
        "title": "TermStep",
        "width": 1200,
        "height": 800,
        "minWidth": 700,
        "minHeight": 500
      }
    ],
    "security": {
      "csp": null
    },
    "withGlobalTauri": false
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns"
    ],
    "macOS": {
      "minimumSystemVersion": "10.15"
    }
  }
}
```

说明：
- `frontendDist: "../dist"` — Vite 构建产物目录（相对 src-tauri）。
- `devUrl: "http://localhost:1420"` — Vite dev server 端口（Tauri 社区约定端口）。
- `beforeDevCommand`/`beforeBuildCommand` — Tauri 启动前自动跑的命令，指向 Task 4 将加的 `dev:web`/`build:web` scripts。
- `csp: null` — 终端 app，沿用现状（Electron 也没设 CSP）。
- `withGlobalTauri: false` — 用 ES module import 而非全局 `window.__TAURI__`。
- 图标路径指向 Task 3 将生成的 `icons/`。

- [ ] **Step 2: 创建 capabilities/default.json**

创建 `src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default"
  ]
}
```

说明：Tauri v2 用 capability 声明权限。`core:default` 含基础窗口/webview 权限。本阶段无 command/插件，最小权限即可。`main` 是默认 window label（tauri.conf.json 的 windows 数组未显式设 label 时默认 "main"）。后续阶段加 clipboard/opener 等 plugin 时在此扩充。

- [ ] **Step 3: 为 tauri.conf.json 的 window 显式设 label**

Edit `src-tauri/tauri.conf.json`，在 windows 数组的第一项加 `"label": "main"`：

将：
```json
      {
        "title": "TermStep",
```
改为：
```json
      {
        "label": "main",
        "title": "TermStep",
```

（capability 的 `windows: ["main"]` 需与此 label 匹配）

- [ ] **Step 4: 验证 JSON 语法**

Run: `cd src-tauri && python3 -c "import json; json.load(open('tauri.conf.json')); json.load(open('capabilities/default.json')); print('JSON OK')"`
Expected: `JSON OK`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat(tauri): add tauri.conf.json + minimal capability"
```

---

## Task 3: 处理图标资产

背景：`build/icon.svg` 和 `build/icon.png` 当前未纳入 git（被忽略）。Tauri 需要多尺寸图标（`icons/32x32.png` 等 + `.icns`）。方案：把 SVG 源纳入版本控制，用 `tauri icon` 命令从一张 1024×1024 PNG 生成全套。

由于 `render-icon.cjs` 依赖 Electron（即将移除），需要一个不依赖 Electron 的方式从 SVG 生成 1024 PNG。本阶段临时方案：直接从主仓库的现有 `build/icon.png`（已是 1024×1024）拷贝过来作为源，纳入版本控制，再用 `tauri icon` 生成多尺寸。

**Files:**
- Create: `assets/icon.png`（1024×1024 源图）
- Create: `assets/icon.svg`（矢量源，留作记录）
- Create: `src-tauri/icons/*`（由 `tauri icon` 生成，gitignore）

- [ ] **Step 1: 创建 assets 目录并拷贝图标源**

从主仓库的 `build/icon.png`（1024×1024）和 `build/icon.svg` 拷贝到 worktree 的 `assets/`（一个不被 git 忽略、且语义清晰的位置）：

```bash
mkdir -p assets
cp /Users/sunknight/web/code/sk_ideas/termstep/build/icon.png assets/icon.png
cp /Users/sunknight/web/code/sk_ideas/termstep/build/icon.svg assets/icon.svg
ls -la assets/
```
Expected: 看到 `icon.png`（~157KB）和 `icon.svg`（894 字节）。

- [ ] **Step 2: 用 tauri icon 生成多尺寸图标**

```bash
cd src-tauri && cargo tauri icon ../assets/icon.png 2>&1 | tail -15
```
Expected: 输出类似 `Loading source-icon: .../assets/icon.png` + 生成 `src-tauri/icons/` 下的 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico` 等多尺寸文件。确认：
```bash
ls src-tauri/icons/
```
应包含至少 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`（与 tauri.conf.json 的 `bundle.icon` 列表对应）。

- [ ] **Step 3: 把生成的 icons/ 加入 gitignore（构建产物，不纳入版本控制）**

在 worktree 根的 `.gitignore`，找到已有的 `# git worktrees` 段落，在其下方追加。用 Edit 工具把：

```
# git worktrees (local isolation workspaces)
.worktrees/
```
改为：
```
# git worktrees (local isolation workspaces)
.worktrees/

# Tauri generated icons (regenerated via `tauri icon`, source kept in assets/)
src-tauri/icons/
# Rust build artifacts
src-tauri/target/
```

- [ ] **Step 4: 验证 gitignore 生效 + assets 会被跟踪**

```bash
git check-ignore src-tauri/icons/32x32.png && echo "icons ignored OK"
git check-ignore src-tauri/target 2>/dev/null && echo "target ignored OK"
git check-ignore assets/icon.png || echo "assets NOT ignored (will be tracked) OK"
```
Expected: 三行 OK。

- [ ] **Step 5: Commit**

```bash
git add assets/icon.png assets/icon.svg .gitignore
git commit -m "feat(tauri): track icon source in assets/, gitignore generated icons/target

build/icon.* were never in git (the build/ ignore + !build/icon.png exception
never worked). Move sources to assets/ and regenerate multi-size icons via
`tauri icon` (committed in assets/, generated set gitignored)."
```

---

## Task 4: 配置 Vite（替代 electron-vite）

现有 `electron.vite.config.ts` 配三个目标（main/preload/renderer）。Tauri 只需 renderer，改用普通 Vite。

**Files:**
- Create: `vite.config.ts`
- Modify: `tsconfig.web.json`（移除 preload 引用）
- Modify: `package.json`（加 dev:web/build:web 脚本 + @tauri-apps 依赖）

- [ ] **Step 1: 创建 vite.config.ts**

创建 `vite.config.ts`（worktree 根目录）：

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Tauri 期望的固定端口（与 tauri.conf.json 的 devUrl 对应）。
// clearScreen 让 Tauri 的 cargo 输出不被 Vite 清屏覆盖。
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer'),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri 同时启动一个 Rust 进程和一个前端 dev server；
    // 监听 host 防止 dev server 在某些环境绑定到错误地址。
    host: '0.0.0.0',
    watch: {
      // 不监听 Rust 源码（Tauri 自己管）
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 用 webview 加载，目标现代浏览器
    target: 'es2022',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
```

说明：`root` 设为 `src/renderer`（与原 electron-vite renderer root 一致），`outDir` 用绝对路径指向 worktree 根的 `dist/`（Tauri 的 `frontendDist: "../dist"`）。`strictPort: true` + `port: 1420` 与 tauri.conf.json 对齐。

- [ ] **Step 2: 修改 tsconfig.web.json 移除 preload 引用**

Edit `tsconfig.web.json`，把：
```json
  "include": ["src/renderer/**/*", "src/shared/**/*", "src/preload/global.d.ts"]
```
改为：
```json
  "include": ["src/renderer/**/*", "src/shared/**/*"]
```

（`src/preload/global.d.ts` 声明 `window.api`，Tauri 不用 preload；但本阶段 preload 目录还在，只是不让 renderer 类型检查依赖它。阶段 4 删除 preload 目录。）

注意：renderer 当前代码里大量 `window.api.*` 调用，移除 `global.d.ts` 后 typecheck 会报 `Property 'api' does not exist on type 'Window'`。本阶段先用一个临时的 ambient 声明让 typecheck 通过，阶段 2 renderer 适配时再正式替换。

创建 `src/renderer/types/global.d.ts`（renderer 本地 ambient 声明，临时）：

```typescript
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
```

并把 `tsconfig.web.json` 的 include 改为：
```json
  "include": ["src/renderer/**/*", "src/shared/**/*"]
```

（`src/renderer/types/global.d.ts` 已被 `src/renderer/**/*` 涵盖，无需显式列出）

- [ ] **Step 3: 修改 package.json 加 web 脚本与 Tauri 依赖**

先看当前 package.json 的 scripts 与 dependencies（阶段 0 已读过，确认行号）：

Edit `package.json` 的 `scripts`，在现有 scripts 基础上**新增**（不删旧的，阶段 4 清理）：

把：
```json
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "postinstall": "find node_modules/node-pty -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true",
    "rebuild": "electron-builder install-app-deps && (find node_modules/node-pty -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true)",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "icon": "electron scripts/render-icon.cjs",
    "package": "electron-vite build && electron-builder"
  },
```
改为：
```json
  "scripts": {
    "dev": "tauri dev",
    "dev:web": "vite",
    "build": "tauri build",
    "build:web": "vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "icon": "cargo tauri icon assets/icon.png",
    "package": "tauri build",
    "_dev_electron": "electron-vite dev",
    "_build_electron": "electron-vite build",
    "_package_electron": "electron-vite build && electron-builder",
    "_icon_electron": "electron scripts/render-icon.cjs"
  },
```

说明：主命令（dev/build/package/icon）切到 Tauri；旧的 electron 命令降级为 `_` 前缀的别名（阶段 4 删除）。`typecheck` 仍含 `tsconfig.node.json`（main/preload 还在，阶段 4 删）。`postinstall`/`rebuild`（node-pty 相关）本阶段保留——它们是 Electron 专用的，但留着不害事，阶段 4 随 node-pty 一起删。

- [ ] **Step 4: 在 package.json dependencies 加 @tauri-apps/api**

Edit `package.json`，在 `dependencies` 对象里加一行（renderer 调 invoke/listen 用；本阶段虽未调用，先装好）：

把：
```json
  "dependencies": {
    "@codemirror/lang-markdown": "^6.3.0",
```
改为：
```json
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@codemirror/lang-markdown": "^6.3.0",
```

- [ ] **Step 5: 安装新依赖**

```bash
npm install
```
Expected: 安装 `@tauri-apps/api`。可能有一些 electron 相关的 deprecation 警告，忽略。

- [ ] **Step 6: 验证 vite build 能产出 dist**

```bash
npm run build:web 2>&1 | tail -20
ls dist/
```
Expected: Vite 构建成功，`dist/` 下有 `index.html`、`assets/`（含 JS/CSS bundle）。如有 TS 报错（`window.api` 相关），确认 Step 2 的临时 global.d.ts 已生效；其他报错需排查（renderer 代码本应能在无 Electron 环境下被 Vite 打包，因为它只 import @tauri-apps/api 而非 electron）。

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts tsconfig.web.json package.json package-lock.json src/renderer/types/global.d.ts
git commit -m "feat(tauri): add Vite config + @tauri-apps/api, switch dev/build scripts

Renderer builds via plain Vite (was electron-vite). Scripts: dev/build → tauri,
dev:web/build:web → vite. Electron scripts demoted to _ prefix (removed Stage 4).
Temp window.api ambient decl keeps typecheck green until IPC layer migration."
```

---

## Task 5: 验证 Tauri 工程能构建

**Files:** 无新建，验证现有配置。

- [ ] **Step 1: cargo check（验证 Rust 工程配置完整）**

```bash
cd src-tauri && cargo check 2>&1 | tail -30
```
Expected: 首次会下载大量 crate 依赖（tauri 依赖较多，需几分钟）。最终应输出 `Finished` 或仅 warning，无 error。若报 `generate_context!` 相关错误（找不到 config/icons），回到 Task 2/3 检查 `tauri.conf.json` 路径与 `icons/` 是否生成。

注意：首次 `cargo check` 编译时间长（5-15 分钟）是正常的，Tauri 依赖树庞大。后续增量编译会快。

- [ ] **Step 2: 验证 tauri.conf.json 被 Tauri 接受**

```bash
cd src-tauri && cargo tauri info 2>&1 | head -30
```
Expected: 输出 app 信息（productName: TermStep、version、identifier、各平台 bundle 状态等），无 config 解析错误。

- [ ] **Step 3: Commit（如有改动；本任务主要是验证，可能无文件变更）**

```bash
git status --short
```
若 `src-tauri/Cargo.lock` 已生成：
```bash
git add src-tauri/Cargo.lock
git commit -m "chore(tauri): add Cargo.lock"
```
若 Cargo.lock 很大，确认它**不应**被 gitignore（Cargo.lock 对二进制项目应纳入版本控制，Tauri 是二进制项目）。

---

## Task 6: 首次启动 tauri dev 验证端到端

这是阶段 1 的验收任务：确认「Tauri 原生窗口 + WKWebView 加载现有 React renderer」链路通。

**Files:** 无。

- [ ] **Step 1: 启动 tauri dev**

```bash
npm run dev
```
（等价 `tauri dev`，它会先跑 `npm run dev:web` 启动 Vite dev server @ :1420，再编译并启动 Rust 窗口）

Expected 行为：
1. Vite dev server 启动（输出 `Local: http://localhost:1420/`）
2. Rust 编译（首次很慢，后续秒开）
3. 弹出一个原生 macOS 窗口（标题 TermStep，1200×800）
4. 窗口内加载 React app

**这是手工验证任务**——需要观察窗口实际表现。可能的结果：

- **理想**：React app 正常渲染（侧边栏/终端/帮助区三栏布局可见，工具列表可能为空或报错，因为 window.api 不存在——这正常，本阶段不接 IPC）。
- **可接受**：UI 渲染但 `window.api` 调用报错（控制台 red error）——符合预期，renderer 还没改。
- **需排查**：白屏、xterm.js Canvas/WebGL 在 WKWebView 下崩溃、CSS 严重错位。

让 dev server 跑着，在另一个终端检查是否有窗口进程：
```bash
pgrep -fl "TermStep\|tauri\|cargo" | head
```
Expected: 看到相关进程。

- [ ] **Step 2: 重点验证 xterm.js 在 WKWebView 的渲染**

在启动的 app 里，如果有默认工具（seed），点击它激活终端。观察：
- xterm 是否正常绘制（黑底/光标闪烁）
- Canvas vs WebGL renderer 是否工作
- 终端区域是否白屏或报错

由于本阶段 PTY 未接，终端不会有 shell 输出——**只验证 xterm 容器能初始化、不崩溃**。输入会触发 `window.api.pty.write` 报错（预期内）。

记录观察结果（用于阶段 3 PTY 迁移的参照）。

- [ ] **Step 3: 停止 dev server**

在运行 `npm run dev` 的终端按 `Ctrl+C`，确认 Vite + Rust 进程都退出。

- [ ] **Step 4: 记录阶段 1 验收结论**

在 worktree 根创建（或追加）`docs/superpowers/plans/tauri-migration-progress.md`，记录：
```markdown
# Tauri 迁移进度

## 阶段 1：脚手架 — 完成 ✅
- 日期: 2026-07-07
- tauri dev 能启动原生窗口加载 React renderer
- xterm.js 在 WKWebView 渲染情况: <填观察: 正常/Canvas OK/WebGL 问题/白屏>
- 已知问题（阶段 2+ 处理）:
  - window.api 调用报错（预期，阶段 2 替换 IPC 层）
  - <其他观察>
```

- [ ] **Step 5: Commit 进度记录**

```bash
git add docs/superpowers/plans/tauri-migration-progress.md
git commit -m "docs(tauri): record stage 1 (scaffold) completion"
```

---

## 阶段 1 完成标准（Definition of Done）

- [x] `src-tauri/` 工程存在，`cargo check` 通过
- [x] `tauri.conf.json` + `capabilities/default.json` 配置正确，`cargo tauri info` 无误
- [x] 图标源在 `assets/`，生成的多尺寸图标在 `src-tauri/icons/`（gitignored）
- [x] `vite.config.ts` 替代 electron-vite，`npm run build:web` 产出 `dist/`
- [x] `npm run dev`（tauri dev）能弹出原生窗口加载 React
- [x] xterm.js 在 WKWebView 不崩溃（关键兼容性验证通过）
- [x] Electron 相关文件仍保留（阶段 4 清理），不破坏现状

## 阶段 1 不做（留给后续阶段）

- 任何 `#[tauri::command]`（阶段 2+）
- PTY 服务（阶段 3）
- renderer `window.api.*` 调用点改造（阶段 2/3）
- 删除 Electron 文件 / 依赖（阶段 4）
- 原生菜单、Dock 图标、About（阶段 4）
- 打 dmg（阶段 4）

---

## 风险与回退

- **风险：`cargo check` 首次编译超时/失败。** Tauri 依赖树大，首次编译 5-15 分钟。若网络慢导致 crate 下载失败，重试 `cargo check`。若某个 crate 编译失败，检查 Rust 版本（需 ≥1.77，当前 1.92 OK）。
- **风险：WKWebView 下 xterm.js 渲染异常。** 这是阶段 1 要验证的核心兼容性。若 WebGL renderer 有问题，xterm 可回退到 Canvas renderer（`terminal.renderer` 配置），阶段 3 PTY 迁移时处理。
- **回退：** 本阶段全是新增文件 + scripts 改动，Electron 文件未动。`git checkout .` + 删除 `src-tauri/`、`vite.config.ts`、`assets/` 即可完全回退到纯 Electron 状态。
