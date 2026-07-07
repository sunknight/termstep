# Tauri 迁移进度

记录各阶段执行情况与待人工确认项。

## 阶段 1：脚手架 — 完成 ✅

- **日期**: 2026-07-07
- **Plan**: `docs/superpowers/plans/2026-07-07-tauri-migration-stage1-scaffold.md`
- **提交**: `71ba464`(骨架) → `bc858ae`(config) → `f9b5d14`(图标) → `044f53a`(Vite) → `1ed862e`(cargo check 通过)

### 已验证
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过（`Finished`，无 error）
- `npx tauri info` 正确解析 config（frontendDist/devUrl/framework: React）
- `npm run build:web` 产出 `dist/`（index.html + CSS 20.6KB + JS 559KB，136 模块）
- `npm run dev`（tauri dev）端到端链路通：
  - Vite dev server ready @ `http://localhost:1420/`
  - Rust 编译完成（43.8s），`target/debug/termstep` 进程启动
  - 无 panic / runtime error
- 图标：源在 `assets/`（纳入版本控制），多尺寸在 `src-tauri/icons/`（gitignored，由 `npm run icon` 生成）

### 过程中修正的 plan 偏差（已记录，便于阶段 2 plan 参考）
1. **Cargo.toml 移除 `macos-private-api` feature** —— 该 feature 需在 tauri.conf.json 同步 `app.macOSPrivateApi: true`，阶段 1 用不到（YAGNI）。阶段 4 若需原生集成再加。
2. **lib.rs 需 `use tauri::Manager;`** —— `get_webview_window` 方法来自 Manager trait，plan 漏写 import。
3. **`tauri` CLI 通过 `@tauri-apps/cli`（devDep）而非全局 cargo 安装** —— npm scripts 用 `tauri`（node_modules/.bin 解析），手动命令用 `npx tauri`。
4. **`src-tauri/gen/` 是生成的 schema，需 gitignore**（capabilities 的 `$schema` 引用它，但不同 Tauri 版本会重建）。
5. **`src-tauri/Cargo.lock` 纳入版本控制**（Tauri 是二进制项目）。

### 待人工确认（headless 环境无法观察）
- [ ] **xterm.js 在 WKWebView 的 Canvas/WebGL 渲染**：阶段 1 未接 PTY，终端无输出；需在本机 `npm run dev` 后点击工具终端，确认 xterm 容器能初始化、不白屏/不崩溃。若 WebGL renderer 有问题，阶段 3 改用 Canvas renderer。

### 已知预期行为（非问题，阶段 2/3 处理）
- renderer 的 34 处 `window.api.*` 调用会报错（`window.api is undefined`）——临时 global.d.ts 让 typecheck 过，但运行时无 IPC。阶段 2 替换为 Tauri invoke/listen。
- Electron 相关文件/依赖仍保留（scripts 降级为 `_` 前缀），阶段 4 清理。

---

## 后续阶段（待执行）

- **阶段 2**：低风险模块（updater/tools/tool_io/cwd/watcher）→ Rust commands + renderer 适配
- **阶段 3**：PTY 攻坚（portable-pty + 6 行为）
- **阶段 4**：原生体验（菜单/Dock/About）+ 打包 + 清理 Electron
