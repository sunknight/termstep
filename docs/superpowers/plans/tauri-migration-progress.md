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
6. **阶段 1 漏了运行时 `window.api` stub**（启动报 `undefined is not an object (evaluating 'window.api.tools')`）：临时 global.d.ts 只声明了类型、运行时 `window.api` 仍是 undefined，React 渲染即崩溃到 ErrorBoundary。补 `src/renderer/lib/stubApi.ts`（no-op，shape 同 preload Api）+ main.tsx 注入；global.d.ts 改回强类型 `Api`（之前用 `any` 还顺带触发了 `.then()` 回调的 implicit-any 错误）。阶段 2 用 `lib/api.ts`（真 Tauri 包装）替换 stub。
7. **`tauri dev` 的子进程清理需彻底**：Vite dev server 在 Tauri 进程退出后偶尔残留并占用 1420 端口，导致下次 `npm run dev` 报 `Port 1420 is already in use`。清理需 `lsof -ti:1420 | xargs kill -9` + 杀 `target/debug/termstep`、`com.apple.WebKit.*` 等。

### 待人工确认（headless 环境无法观察）
- [ ] **UI 正常渲染（非 ErrorBoundary）**：stub 修复后 `npm run dev` 窗口应显示三栏布局（侧边栏空/终端区/帮助区），而非"出错了"界面。
- [ ] **xterm.js 在 WKWebView 的 Canvas/WebGL 渲染**：阶段 1 未接 PTY，终端无输出（stub 的 write 是 no-op）；需在本机 `npm run dev` 后点击工具终端，确认 xterm 容器能初始化、不白屏/不崩溃。若 WebGL renderer 有问题，阶段 3 改用 Canvas renderer。

### 已知预期行为（非问题，阶段 2/3 处理）
- renderer 的 34 处 `window.api.*` 调用会报错（`window.api is undefined`）——临时 global.d.ts 让 typecheck 过，但运行时无 IPC。阶段 2 替换为 Tauri invoke/listen。
- Electron 相关文件/依赖仍保留（scripts 降级为 `_` 前缀），阶段 4 清理。

---

## 后续阶段（待执行）

- **阶段 3**：PTY 攻坚（portable-pty + 6 行为）
- **阶段 4**：原生体验（菜单/Dock/About）+ 打包 + 清理 Electron

---

## 阶段 2：低风险模块 — 完成 ✅

- **日期**: 2026-07-07
- **Plan**: `docs/superpowers/plans/2026-07-07-tauri-migration-stage2-modules.md`

### 已完成（7 个 Rust 模块 + renderer 适配）

| 模块/Task | 提交 | 测试 |
|---|---|---|
| types.rs + pure.rs | `3074555` | 14 测试 PASS（merge/append/meta/slugify） |
| updater.rs | `662fb76` | 15 测试 PASS（compare_versions/parse_manifest） |
| tools.rs | `47925d2` | 20 测试 PASS（scan + 敏感路径守卫 + fetchRemoteMarkdown） |
| cwd.rs + tool_io.rs + watcher.rs + seed.rs | `8c33b21` | 无单测（fs/OS 调用，靠手测） |
| commands.rs + lib.rs 注册 | `5dd42db` | 24 commands 注册，cargo check 通过 |
| renderer api.ts + 34 调用点 | `aab70be` | typecheck 0 错误，vitest shared 全绿 |

**Rust 测试合计 49 PASS**（14+15+20）。

### 过程中修正的 plan 偏差（已记录，供阶段 3 plan 参考）
1. **notify 6.x API 变化**：`recommended_watcher` 只接单个回调（不再接 Config 参数），用闭包包 channel。
2. **Tauri v2 把 clipboard 移到插件**：`app.clipboard()` 是 v1 API。改用 `arboard` crate（无需插件注册/capability，更简单）。
3. **reqwest 用 rustls-tls**（`default-features=false, features=["rustls-tls"]`）避免系统 openssl 依赖。
4. **`tempfile` crate 修测试并行冲突**：tools 测试用 nanos 时间戳做唯一目录偶发冲突，改用 `tempfile::TempDir`（自动唯一 + drop 清理）稳定。
5. **invoke 返回类型需显式标注**：Electron 时代 preload 返回 `Promise<any>` 静默编译，Tauri `invoke<T>` 默认 `Promise<unknown>`，bundle.export/import 等需显式标注 union 类型对齐 Rust 后端 JSON shape。
6. **TerminalView 的 pty:data 订阅提到组件顶层**：原 `offDataRef.current = pty.onData(...)` 赋值模式与 Tauri 异步 `listen` 不兼容，改用 `useTauriEvent` + termRef。
7. **starter_help_md 用 Rust raw string**：`{{` 在 format! 需转义 `{{{{`，改用 `r#"..."#` raw string 直接写 `{{`。

### 验证结果（端到端）
- ✅ `cargo test`：49 Rust 测试全 PASS
- ✅ `npx tsc --noEmit`：0 错误
- ✅ `npm run build:web`：成功（561KB JS）
- ✅ vitest：10/11 文件通过（140 测试），仅 `ptyService.test.ts` 失败（node-pty Electron 代码，阶段 3/4 删）；shared 纯逻辑测试全绿——零回归
- ✅ `npm run dev`（tauri dev）：窗口启动，无 panic/error
- ✅ **userData 数据天然连续**：Tauri 读到 Electron 时代创建的全部工具（git + tool-2~12），路径 `~/Library/Application Support/TermStep/tools/` 完全相同，零丢失
- ✅ auto-update 链路通：`update-state.json` 写入 `{"version":"0.5.0"}`

### 待人工确认（headless 环境无法观察 GUI）
- [ ] **工具列表渲染**：窗口侧边栏应显示 git + tool-2~12（共 13 个工具），非空
- [ ] **工具 CRUD**：新建/编辑/删除/排序生效
- [ ] **导入导出**：rfd 对话框弹出 + json 读写
- [ ] **quick commands**：下拉显示按钮，编辑保存生效
- [ ] **剪贴板**：终端选中复制、⌘C/⌘V（arboard）
- [ ] **外链**：帮助页链接在浏览器打开
- [ ] **更新检查**：sidebar 徽章状态变化
- [ ] **mdUrl 订阅**：编辑工具加 http URL → 远程内容显示
- [ ] **终端区域**：xterm 初始化不崩溃（PTY stub，无输出正常）

### 已知预期行为（非问题，阶段 3 处理）
- PTY 是 stub：`pty_*` commands 返回空/no-op，终端无 shell 输出、输入无响应。
- Electron 相关文件/依赖仍保留（`src/main/`、`src/preload/`、electron-builder 等），阶段 4 清理。
