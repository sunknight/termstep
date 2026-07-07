# Tauri 迁移 · 阶段 4：原生体验 + 打包 + 清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** 完成原生 macOS 体验（菜单/About），打包出 dmg 验证体积（94MB→~12MB），最后删除所有 Electron 残留，让仓库成为干净的 Tauri 工程。迁移收官。

**Architecture:** 新增 `src-tauri/src/menu.rs`（对偶 src/main/menu.ts）用 tauri::menu 建原生菜单 + 「检查更新…」项。删除 `src/main/`、`src/preload/`、`electron-builder.yml`、`electron.vite.config.ts`、`tsconfig.node.json`、`scripts/render-icon.cjs`、Electron 依赖。`tauri build` 产出 dmg。

**Tech Stack:** tauri::menu（Submenu/MenuItem/PredefinedMenuItem/AboutMetadataBuilder）、tauri build（dmg）。

**关联 Spec:** 第六节·原生体验、第八节·打包配置。

---

## File Structure

**Create:**
- `src-tauri/src/menu.rs` — 原生菜单（对偶 src/main/menu.ts）

**Modify:**
- `src-tauri/src/lib.rs` — 调 menu::set_app_menu + on_menu_event（检查更新）
- `src-tauri/Cargo.toml` — version 提到 0.5.0（与 package.json 同步）
- `src-tauri/tauri.conf.json` — bundle.icon 路径、productName 确认
- `package.json` — 删 electron 依赖 + 旧的 `_` 前缀 scripts + postinstall/rebuild + chokidar/node-pty；version 提到 0.5.0
- `.gitignore` — 清理 build/ 旧规则（图标源已迁 assets/）
- `CLAUDE.md` — 全面更新（架构、命令、gotchas 改 Tauri 版）

**Delete:**
- `src/main/` 整个目录（ptyService/ipc/toolManager/toolsScanner/cwd/menu/updater/seed/index.ts）
- `src/preload/` 整个目录（index.ts/global.d.ts）
- `electron-builder.yml`
- `electron.vite.config.ts`
- `tsconfig.json`（references 改：删 node 引用）+ `tsconfig.node.json`
- `scripts/render-icon.cjs`（依赖 Electron）
- `tests/ptyService.test.ts`（测 src/main 的 node-pty，已无对应代码）
- `tests/cwd.test.ts`、`tests/toolsScanner.test.ts`、`tests/updater.test.ts` —— **评估**：这些测的是 shared/ 和 main/ 的纯函数。shared 部分继续用（toolJson/bundle/toolConfig/tmux/buttonBlock/peekController/dangerous）。main 部分（scanTools/fetchRemoteMarkdown/liveCwd/compareVersions/parseManifest）的 TS 测试随 main 删除一并删——它们已有 Rust 对偶测试。

---

## Task A：menu.rs（原生菜单）

**Files:** Create `src-tauri/src/menu.rs`; Modify `src-tauri/src/lib.rs`

- [ ] **Step 1: 写 menu.rs**

对偶 src/main/menu.ts。macOS 第一项 label = app 名（TermStep）。菜单结构：TermStep / 编辑 / 视图 / 窗口。

创建 `src-tauri/src/menu.rs`：

```rust
//! 对偶 src/main/menu.ts。原生 macOS 菜单。第一项 label = TermStep（菜单栏粗体名）。

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Wry};

pub fn set_app_menu(handle: &AppHandle) -> tauri::Result<()> {
    let name = "TermStep";

    // TermStep 菜单（第一项 = 菜单栏粗体 app 名）
    let app_menu = Submenu::with_items(
        handle,
        name,
        true,
        &[
            &PredefinedMenuItem::about(handle, Some(&format!("关于 {}", name)),
                Some(AboutMetadataBuilder::new()
                    .name(Some(name))
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .build()))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, Some(&format!("隐藏 {}", name)))?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, Some(&format!("退出 {}", name)))?,
        ],
    )?;

    // 编辑菜单
    let edit_menu = Submenu::with_items(
        handle, "编辑", true,
        &[
            &PredefinedMenuItem::undo(handle, Some("撤销"))?,
            &PredefinedMenuItem::redo(handle, Some("重做"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some("剪切"))?,
            &PredefinedMenuItem::copy(handle, Some("复制"))?,
            &PredefinedMenuItem::paste(handle, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(handle, Some("全选"))?,
        ],
    )?;

    // 视图菜单：检查更新（自定义） + 分隔 + 切换全屏（自定义，因 PredefinedMenuItem 无 togglefullscreen）
    let check_update_item = MenuItem::with_id(handle, "check_update", "检查更新…", true, None::<&str>)?;
    let fullscreen_item = MenuItem::with_id(handle, "toggle_fullscreen", "全屏", true, None::<&str>)?;
    let view_menu = Submenu::with_items(
        handle, "视图", true,
        &[
            &check_update_item,
            &PredefinedMenuItem::separator(handle)?,
            &fullscreen_item,
        ],
    )?;

    // 窗口菜单
    let window_menu = Submenu::with_items(
        handle, "窗口", true,
        &[
            &PredefinedMenuItem::minimize(handle, Some("最小化"))?,
            &PredefinedMenuItem::zoom(handle, None)?,  // macOS "缩放"
            &PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?,
        ],
    )?;

    let menu = Menu::with_items(handle, &[&app_menu, &edit_menu, &view_menu, &window_menu])?;
    handle.set_menu(menu)?;
    Ok(())
}
```

> 注意：PredefinedMenuItem 的 about/services/hide/hide_others/show_all/quit/undo/redo/cut/copy/paste/select_all/minimize/zoom/close_window/separator 方法名需确认（Tauri 封装层）。若方法名不同（如 `hide_others` vs `hide_others`），按编译错误调整。zoom 在 macOS 是窗口缩放，可能无中文 label 参数。

- [ ] **Step 2: lib.rs 注册菜单 + on_menu_event**

Edit `src-tauri/src/lib.rs`：
- 顶部 mod 加 `mod menu;`
- setup 里（在 pty_service manage 之后、kill_all 之前）加：
```rust
// 原生应用菜单（对偶 src/main/menu.ts）+ About 元数据
if let Err(e) = menu::set_app_menu(app.handle()) {
    eprintln!("menu setup failed: {}", e);
}
```
- setup 之后、`.run` 之前加 `on_menu_event` 处理「检查更新」和「全屏」：
```rust
.on_menu_event(|app, event| match event.id().as_ref() {
    "check_update" => {
        let h = app.handle().clone();
        let st = app.state::<std::sync::Arc<std::sync::Mutex<crate::updater::UpdaterState>>>().inner().clone();
        let av = app.package_info().version.to_string();
        let sf = app.state::<std::sync::Mutex<std::path::PathBuf>>().inner().lock().unwrap().clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::updater::check_for_updates(h, st, av, sf, true).await;
        });
    }
    "toggle_fullscreen" => {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
        }
    }
    _ => {}
})
```

- [ ] **Step 3: cargo check + dev 验证菜单**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | grep error`
修正方法名/类型错误。

启动 `npm run dev`，确认菜单栏出现 TermStep/编辑/视图/窗口（需 GUI 手测）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/menu.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): native macOS menu (对偶 menu.ts) + check-update menu item"
```

---

## Task B：删除 Electron 代码 + 依赖

**Files:** Delete 多个；Modify package.json/.gitignore/tsconfig

- [ ] **Step 1: 删除 src/main/ 和 src/preload/ 整个目录**

```bash
git rm -r src/main src/preload
```

- [ ] **Step 2: 删除 Electron 构建配置**

```bash
git rm electron-builder.yml electron.vite.config.ts
```

- [ ] **Step 3: 删除 node-pty 相关的 tsconfig.node.json + render-icon.cjs**

```bash
git rm tsconfig.node.json scripts/render-icon.cjs
```

`tsconfig.json`（references 两个子配置）改为：
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.web.json" }]
}
```

- [ ] **Step 4: 删除测 Electron main/ 的测试文件**

```bash
git rm tests/ptyService.test.ts tests/cwd.test.ts tests/toolsScanner.test.ts tests/updater.test.ts
```

> 保留：tests/bundle/buttonBlock/toolConfig/toolJson/tmux/peekController/dangerous（测 shared/ 纯逻辑，仍有效）。

- [ ] **Step 5: 清理 package.json**

Edit `package.json`：
- `version` → `0.5.0`
- 删 scripts：`_dev_electron`/`_build_electron`/`_package_electron`/`_icon_electron`/`postinstall`/`rebuild`/`preview`
- 删 devDependencies：`electron`/`electron-builder`/`electron-vite`/`@types/node`（main/preload 用，renderer 不需要）
- 删 dependencies：`node-pty`/`chokidar`
- 保留：react/react-dom/@vitejs/plugin-react/vite/typescript/vitest/@xterm/@uiw/markdown-it/@codemirror/@tauri-apps

最终 package.json scripts：
```json
"scripts": {
  "dev": "tauri dev",
  "dev:web": "vite",
  "build": "tauri build",
  "build:web": "vite build",
  "typecheck": "tsc --noEmit -p tsconfig.web.json",
  "test": "vitest run",
  "test:watch": "vitest",
  "icon": "tauri icon assets/icon.png",
  "package": "tauri build"
}
```

- [ ] **Step 6: 清理 .gitignore 的 build/ 旧规则**

Edit `.gitignore`，删掉这段（build/ 目录不再使用，图标源在 assets/）：
```
build/
# ...but the app icon source assets live in build/ (electron-builder convention);
# keep them tracked so dev Dock + packaging work out of the box.
!build/icon.svg
!build/icon.png

# electron-builder
release/
```

保留其余。

- [ ] **Step 7: npm install 清理 node_modules + 验证**

```bash
rm -rf node_modules package-lock.json
npm install
```

验证：typecheck 通过、vitest（剩 7 个 shared 测试文件）全绿。

- [ ] **Step 8: cargo check 确认 Rust 端无引用问题**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
（Rust 不依赖 TS 删除，应仍 55 PASS）

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(tauri): remove Electron (src/main, src/preload, configs, deps)

Migration complete: no Electron code remains. Deleted:
- src/main/ (ptyService/ipc/toolManager/toolsScanner/cwd/menu/updater/seed/index)
- src/preload/ (index.ts/global.d.ts)
- electron-builder.yml, electron.vite.config.ts, tsconfig.node.json
- scripts/render-icon.cjs (depended on Electron)
- tests for Electron main modules (ptyService/cwd/toolsScanner/updater)
- electron/electron-builder/electron-vite/node-pty/chokidar deps
Kept: shared/ pure logic + its vitest suites (regression baseline)."
```

---

## Task C：打包 dmg + 验证体积

**Files:** 无（构建产物）

- [ ] **Step 1: tauri build**

```bash
npm run build
```

（等价 `tauri build`：先 `npm run build:web` 产出 dist，再 cargo build --release + bundle dmg。release 编译较慢，5-15 分钟）

- [ ] **Step 2: 检查产物体积**

```bash
ls -lh src-tauri/target/release/bundle/dmg/*.dmg
du -sh src-tauri/target/release/bundle/dmg/*.dmg
```
Expected: **~12-15 MB**（vs Electron 94MB，降幅 ~85%）。

- [ ] **Step 3: 记录体积**

把 dmg 路径和体积记进进度文档。

- [ ] **Step 4: Commit 进度**

```bash
git add docs/superpowers/plans/tauri-migration-progress.md
git commit -m "docs(tauri): record stage 4 completion + final dmg size"
```

---

## Task D：更新 CLAUDE.md

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1: 全面更新 CLAUDE.md**

更新内容：
- **What this is**：删 "Electron"，改 "Tauri"
- **Commands**：dev/build/typecheck/test/package 改 Tauri 版
- **Architecture**：三进程 → Rust 后端（src-tauri）+ React renderer（src/renderer）+ shared。移除 preload 段。加 src-tauri/src/ 模块说明。
- **IPC contract**：Electron ipcMain → Tauri `#[tauri::command]`。types.ts 的 IPC 常量 → Tauri command 名（去 `:`）。
- **Gotchas**：
  - 删 node-pty native module rebuild
  - 删 preload sandbox clipboard
  - 保留并改写 xterm display:none（仍适用）
  - 保留 pty 生命周期竞态（改为 Rust generation guard 表述）
  - 保留打包未签名（用户需 xattr -cr，Tauri 版同理）
  - 删 ptyService live test（Rust 测试在 src-tauri）
  - 加：tauri dev 端口 1420（与 vite.config 对齐）
  - 加：userData = ~/Library/Application Support/TermStep（与 Electron 同路径）

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md for Tauri (commands, architecture, gotchas)"
```

---

## 阶段 4 完成标准（= 迁移完成）

- [x] menu.rs 原生菜单（TermStep/编辑/视图/窗口 + 检查更新）
- [x] Electron 代码/依赖全删除
- [x] typecheck + vitest（shared）全绿
- [x] cargo test 55 PASS
- [x] tauri build 产出 dmg，体积 ~12-15MB（vs 94MB）
- [x] CLAUDE.md 更新为 Tauri 版

## 风险

- **菜单方法名**：Tauri 封装的 PredefinedMenuItem 方法名（hide_others/show_all/about 等）需按编译反馈调整。
- **release 编译慢**：首次 cargo build --release 5-15 分钟。
- **删除测试**：删 tests/updater.test.ts 等会失去 TS 版纯函数测试——但 Rust 对偶测试已覆盖（compare_versions/parse_manifest/sensitive_path/scan）。
- **图标打包**：tauri.conf.json 的 bundle.icon 路径需与 `tauri icon` 生成的文件名完全匹配。
