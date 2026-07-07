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

（无——迁移已完成）

---

## 阶段 4：原生体验 + 打包 + 清理 — 完成 ✅

- **日期**: 2026-07-07
- **Plan**: `docs/superpowers/plans/2026-07-07-tauri-migration-stage4-native-cleanup.md`

### 已完成

| Task | 提交 | 说明 |
|---|---|---|
| menu.rs | `ba35413` | 原生 macOS 菜单（4 子菜单 + 检查更新/全屏） |
| 删除 Electron | `c555145` | 删 6416 行（src/main、src/preload、配置、依赖） |
| tauri build | — | dmg 产出 |
| CLAUDE.md | (本 task) | 全面更新为 Tauri 版 |

### 🎯 核心成果：体积对比

| | 体积 | 说明 |
|---|---|---|
| Electron (旧 0.4.0) | **94 MB** | 含 Chromium |
| Tauri (新 0.5.0) | **5.4 MB** | 系统 WebView |
| **降幅** | **-94.3%** | 超额完成（预期 12-15MB） |

产物：`src-tauri/target/release/bundle/dmg/TermStep_0.5.0_aarch64.dmg`（5,636,714 字节）。

### 验证
- ✅ cargo check 通过，55 Rust 测试 PASS
- ✅ typecheck 0 错误
- ✅ vitest 7 文件 105 测试全绿（shared 纯逻辑零回归）
- ✅ node_modules 476 → 139 packages
- ✅ `tauri build` 成功，dmg 5.4MB
- ✅ Electron 代码零残留

### 待人工确认
- [ ] dmg 安装运行：双击 dmg，拖到 Applications，`xattr -cr` 后启动
- [ ] 菜单栏显示 TermStep/编辑/视图/窗口
- [ ] PTY 6 行为 + tmux + 复制粘贴（见阶段 3 待确认项）

## 阶段 3：PTY 攻坚 — 完成 ✅

- **日期**: 2026-07-07
- **Plan**: `docs/superpowers/plans/2026-07-07-tauri-migration-stage3-pty.md`

### 已完成

| Task | 提交 | 说明 |
|---|---|---|
| tmux.rs | `915942f` | sanitize_tmux_name + tmux_argv（6 测试 PASS） |
| pty.rs | `05cc3f8` | PtyService 池 + 6 行为 + 读线程 emit + generation guard |
| commands.rs + lib.rs | `05cc3f8` | pty_* 接真实 PtyService；manage + kill_all on Destroyed |

**Rust 测试合计 55 PASS**（49 + tmux 6）。

### 6 行为实现情况

| 行为 | 实现 | 验证 |
|---|---|---|
| 1 登录 shell `-l` | `cmd.arg("-l")` | ✅ 进程树见 `bash -l`（带 -l） |
| 2 TERM=xterm-256color | `cmd.env("TERM", "xterm-256color")` | 待手测 `echo $TERM` |
| 3 locale 回退 | `LANG/LC_CTYPE` 仅 unset 时设 | 待手测中文文件名 |
| 4 COLORTERM | 仅 unset 时设 truecolor | 待手测 `echo $COLORTERM` |
| 5 initCommands 时机 | spawn 后立即 write_all | 待手测 |
| 6 restart 竞态 | generation 号 identity guard | 待手测连点 restart |

### 过程中修正的 plan 偏差
1. **PtyEntry 保留 master**：plan 草稿漏了 resize 需 master，实现时 entry 存 `Box<dyn MasterPty + Send>`（take_writer/try_clone_reader 不消耗 master）。
2. **读线程 generation guard 的锁层级**：`svc.lock()` → `svc.ptys.lock()` 两层锁（PtyService 内 ptys 是 Mutex<HashMap>），非 `ptys.ptys.get()` 单层。
3. **读线程用 `try_state`** 而非 `state`（EOF 时 app 可能正在关闭，try_state 容错返回 None）。
4. **kill_all 挂在 on_window_event(Destroyed)**：Tauri v2 无 before-quit 全局钩子，用窗口销毁事件近似。

### 验证结果（端到端）
- ✅ `cargo check` 通过，55 Rust 测试全 PASS
- ✅ `npm run dev` 启动，无 panic / openpty/spawn/reader/writer 失败
- ✅ **PTY 核心链路通**：进程树见 termstep 派生 `bash -l`（登录 shell 子进程），证明 spawn 成功
- ✅ 行为 1（登录 shell -l）已通过进程树验证

### 待人工确认（headless 无法看 GUI 终端输出）
请在 `.worktrees/migrate-to-tauri` 跑 `npm run dev`，激活某工具终端后逐项验证：
- [ ] **行为 2 TERM**：`echo $TERM` → `xterm-256color`
- [ ] **行为 3 locale**：`touch 中文 && ls` → 文件名正常（非 `?`）；`echo $LANG` 含 UTF-8
- [ ] **行为 4 COLORTERM**：`echo $COLORTERM` → `truecolor`；`ls --color` 有色
- [ ] **行为 5 initCommands**：配 `initCommands: ["echo HI"]` → 首屏见 HI
- [ ] **行为 6 restart**：快速连点重启按钮 → 尺寸不回缩、新 shell 存活
- [ ] **tmux**：配 `tmux: "x"` → `tmux ls` 含 session；重开 re-attach
- [ ] **resize**：拖窗口 → `stty size` 更新
- [ ] **cwd 跟随**：顶栏 cwd 跟随 `cd`
- [ ] **复制粘贴**：选中复制、⌘V 粘贴
- [ ] **Ctrl-C**：中断命令正常
- [ ] **中文输出**：`echo 你好` 不乱码（UTF-8 boundary）

### 已知潜在风险（手测时关注）
- **UTF-8 多字节跨 chunk 边界**：读线程用 `String::from_utf8_lossy`，中文字符若跨 4KB chunk 可能断裂显示。若乱码，改用 wezterm 式 UTF-8 boundary 累积 buffer。
- **portable-pty vs node-pty 信号传递**：Ctrl-C/Ctrl-Z 行为可能有细微差异。

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
