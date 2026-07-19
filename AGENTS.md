# AGENTS.md

> 本文件是新会话的**项目初始化上下文**。读完它即可获得完整的项目架构、模块实现、知识点、历史坑点和代码结构，无需重新探索项目。请始终保持与代码同步。

## 1. 这是什么

**TermStep** —— 一个本地 macOS **Tauri v2** 桌面应用，把任意 CLI 命令变成可点击的菜单/按钮。

核心模型：用户定义若干「工具」(tool)，每个工具有：
- 一个**持久终端**（portable-pty + xterm.js，真实 shell）；
- 一个 **markdown 帮助页**，其中 ` ```buttons ` / ` ```buttons-json ` 围栏会渲染成一键执行的命令按钮。

技术栈：**Tauri v2（Rust 后端）+ React 18 / TypeScript（渲染端）+ Vite**。曾从 Electron 迁移而来（见 `docs/superpowers/specs/2026-07-07-migrate-to-tauri-design.md`），数据路径刻意保持兼容，老用户零迁移。

当前版本 **0.9.2**。bundle identifier `local.termstep`。

---

## 2. 常用命令

```bash
npm run dev          # tauri dev：Vite dev server (:1420) + Rust 窗口 + HMR（开发主入口）
npm run dev:web      # 仅 Vite 渲染端 dev server（无原生窗口，调 UI 时用）
npm run build        # tauri build：release dmg（未签名，主机架构）
npm run build:web    # vite build：渲染端 → dist/（被 tauri 消费）
npm run typecheck    # tsc --noEmit -p tsconfig.web.json（渲染端 + shared）
npm run test         # vitest run（node 环境）
npm run test:watch   # vitest 监听
npm run icon         # 从 assets/icon.png 重新生成 src-tauri/icons/（改图标后必须）
npm run version:set <x.y.z>   # 一键同步四处版本号（见下）
npm run release      # universal dmg 构建并拷到 release/
```

单测：
- 单文件：`npx vitest run tests/buttonBlock.test.ts`
- 按名：`npx vitest run -t "restart keeps"`
- Rust 测试：`cargo test --manifest-path src-tauri/Cargo.toml`（tools/pure/vcs/tmux/commands 等，~80+ 测试）
- Rust 检查：`cargo check --manifest-path src-tauri/Cargo.toml`

**设置版本号**：`npm run version:set 0.9.3`（脚本 `scripts/set-version.mjs`）同步四处：`package.json`、`src-tauri/Cargo.toml`（[package] 段）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock`（仅 `name = "termstep"` 紧随的那条 version，不会误伤其它 crate）。**不要手动逐个改，极易漏 Cargo.lock。** 支持 `--dry-run`。

**发布新版本**（推荐用 `changelog-gen` skill 一键走完）：在 AI 对话里说「**用 changelog-gen 发版**」，skill 会按四步交互流程逐步问、按回答执行——升版本号 → 写 CHANGELOG → 提交 → 打 tag + 推送，免去手敲多条命令。流程要点：

1. **版本级别**：skill 问大/中/小，按语义化版本递增对应段（大 `0.9.7→1.0.0` / 中 `→0.10.0` / 小 `→0.9.8`）。选定后自动 `npm run version:set -- <新版本>`（**不加 `--tag`**，tag 放第 4 步）。
2. **CHANGELOG**：skill 取 `<最近 tag>..HEAD` 提交，按「面向用户、不面向开发」原则提炼成条目（绝不照抄 commit subject、绝不写模块名/函数名/数据字段），插入 `CHANGELOG.md` 顶部第一个 `## [` 之前。规则细节见 skill 本体 `skills/changelog-gen/SKILL.md`。
3. **提交**：skill 先判断分支——**在 feature 分支上会停下来问是否先合并回 main**（发版提交应打在 main 上）；确认后 `git commit -m "chore(release): <版本>"`，版本号 + CHANGELOG 一个提交。
4. **打 tag + 推送**：预检 `v<版本>` 不存在 → `git tag v<版本>` → `git push origin <分支>` + `git push origin v<版本>`。tag 打在 release commit 上。

**手动发版**（不走 skill）：`npm run version:set -- <版本>` → 手写 CHANGELOG 条目 → `git add` 版本文件 + CHANGELOG → `git commit -m "chore(release): <版本>"` → `git tag v<版本>` → `git push origin main --tags`。CHANGELOG 必须手写，**脚本和 skill 都不替你决定怎么写**——skill 只是按规则辅助提炼。

**注意**：发版前确认在 main 上（或打算从 feature 分支合并回 main）；本地 main 不落后远程（`git fetch` 后 `git log origin/main..main` 看本地领先、`git log main..origin/main` 看是否落后）；远程若已有同名 tag 会停下问，**绝不 `--force` 覆盖**。

**端口 1420 冲突**：`npm run dev` 报 "Port 1420 is already in use" 时，`lsof -ti:1420 | xargs kill -9`（上个 Vite 没干净退出）。

---

## 3. 项目与代码结构

```
termstep/
├── src/                      # TypeScript（渲染端 + 共享）
│   ├── renderer/             # React 18 渲染端（WKWebView）
│   │   ├── App.tsx           # 三栏布局入口：侧栏 / 终端 / 帮助或编辑器
│   │   ├── main.tsx          # React 挂载点
│   │   ├── components/       # UI 组件（见 §5.3）
│   │   ├── hooks/            # useTools / useTauriEvent / useUpdateState / usePeek
│   │   └── lib/              # api.ts / markdown.ts / termRegistry.ts / theme.ts ...
│   └── shared/               # 纯 TS，前后端共享（Rust 有对偶实现）
│       ├── types.ts          # 类型 + IPC 通道名常量（IPC 契约的唯一来源）
│       ├── buttonBlock.ts    # buttons / buttons-json 围栏解析与渲染
│       ├── toolJson.ts       # mergeToolJson（对偶 pure.rs）
│       ├── toolConfig.ts     # parseToolMeta
│       ├── bundle.ts         # 导入/导出 bundle
│       ├── dangerous.ts      # 危险命令检测
│       ├── tmux.ts           # tmux 会话名 sanitize + argv
│       └── peekController.ts # 折叠面板的 hover-peek 逻辑
├── src-tauri/                # Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── main.rs           # 薄入口，只调 lib::run()
│   │   ├── lib.rs            # Builder + setup() + State 注入 + 命令注册 + menu_event
│   │   ├── commands.rs       # 所有 #[tauri::command]，薄封装（见 §5.1）
│   │   ├── pty.rs            # portable-pty 池（按 toolId），见 §6.3
│   │   ├── tools.rs          # scan_tools + fetch_remote_markdown + SSRF/敏感路径守卫
│   │   ├── tool_io.rs        # tool CRUD / 排序索引 / 迁移（见 §6.5）
│   │   ├── watcher.rs        # notify 文件监听 → emit tools:changed + auto-refresh tick
│   │   ├── updater.rs        # reqwest 清单检查 → emit update:state
│   │   ├── vcs.rs            # 配置版本控制（git 快照与历史，见 §6.6）
│   │   ├── pure.rs           # 纯数据转换（merge/buildButtonsAppend/serialize/parse/risk）
│   │   ├── types.rs          # Rust 对偶类型（ToolMeta/Tool/ScanResult/...）
│   │   ├── tmux.rs           # sanitize_tmux_name + tmux_argv
│   │   ├── cwd.rs            # lsof 取 shell 实时 cwd
│   │   ├── menu.rs           # 原生 macOS 菜单
│   │   └── seed.rs           # 首次运行默认工具
│   ├── Cargo.toml            # 依赖（见 §4）
│   ├── tauri.conf.json       # 窗口/CSP/bundle 配置
│   └── capabilities/default.json  # 仅 core:default + dialog:default
├── tests/                    # vitest 单测（node 环境，覆盖 shared/）
├── scripts/set-version.mjs   # 版本号同步脚本
├── assets/icon.png           # 应用图标源（tracked；icons/ 是生成的，gitignored）
├── docs/superpowers/         # 设计文档与实现计划（specs/ plans/）
└── ln_library_data -> ~/Library/Application Support/TermStep   # 用户数据软链
```

构建产物（均 gitignored）：`dist/`（Vite 渲染端）、`out/`（旧 electron 残留，可忽略）、`release/`（dmg）、`src-tauri/target/`（Rust）、`src-tauri/icons/`、`src-tauri/gen/`。

---

## 4. 技术栈与关键依赖

**渲染端** (`package.json`)：React 18（dev 开 StrictMode）、`@uiw/react-codemirror` + `@codemirror/lang-markdown`（markdown 编辑器）、`@xterm/xterm` + `@xterm/addon-fit`（终端）、`markdown-it`（markdown 渲染）、`@tauri-apps/api` + `@tauri-apps/plugin-dialog`（IPC + 原生对话框）。

**后端** (`src-tauri/Cargo.toml`)：
- `tauri` 2 + `tauri-plugin-dialog` 2（窗口/IPC/原生对话框）
- `portable-pty` 0.9（终端进程，wezterm 实现）
- `notify` 6（文件监听，**注意 6.x API 见 §6.4**）
- `reqwest` 0.12（HTTP，`native-tls`，禁重定向）
- `arboard` 3（剪贴板，**不用 tauri clipboard 插件**）
- `rfd` 0.15（原生文件对话框）、`opener` 0.7（系统浏览器打开 URL）
- `uuid` v4（工具 ID）、`regex`、`dirs`、`chrono`、`tokio`（full）

**打包**：unsigned、host-arch（`release` 脚本做 universal）。收方撞 Gatekeeper 需 `xattr -cr "/Applications/TermStep.app"` 或右键→打开。

---

## 5. 架构

两侧由 Tauri v2 串联。渲染端**只**通过 `lib/api.ts`（invoke）+ `useTauriEvent`（listen）与后端通信，**绝不**直接 `window.*`。

### 5.1 IPC 契约（最重要的约定）

`src/shared/types.ts` 定义 `IPC` 常量对象，含全部通道名。三端共用：
- 渲染端：`lib/api.ts` 封装 `invoke` / `listen`。
- 后端：命令名 = 通道名把 `:` → `_`（如 `tools:list` → `tools_list`）。

**新增一个 IPC 调用的四步**：
1. 在 `src/shared/types.ts` 的 `IPC` 加通道常量；
2. 在 `src-tauri/src/commands.rs` 加 `#[tauri::command]`（参数从前端 camelCase 传入）；
3. 在 `src-tauri/src/lib.rs` 的 `generate_handler!` 注册；
4. 在 `src/renderer/lib/api.ts` 的 `api` 对象加方法。

跨命令的共享状态用 `tauri::State<T>`，在 `lib.rs` 的 `setup()` 里 `app.manage()` 注入。**多个 `Mutex<PathBuf>` 必须用 newtype 区分**（`ToolsDir`/`ConfigsDir`/`UpdateStateFile`），否则 Tauri State 按类型查找会冲突。所有取锁用 `lock_or_recover!` 宏（跳过中毒锁，避免一处 panic 永久瘫痪子系统）。

### 5.2 工具是磁盘上的数据，不是代码

每个工具是 `configs/tools/<UUID>/` 目录，含 `tool.json`（name/icon/cwd/shell/env/tmux/initCommands/mdUrl/useRemote/autoUpdateMinutes）和 `help.md`。整个 UI 由扫描该目录派生（`tools.rs: scan_tools`）。应用内编辑只是把这些文件写回。

**排序**：单一来源 `tools/order.json`（`{"order":["uuid1",...]}`），**不是**每个 tool.json 的 order 字段。不在索引里的 id 兜底排末尾（usize::MAX），彼此按 id 稳定排序。写索引用「临时文件 + rename」保证原子（避免 watcher 读到半截 JSON）。

**ID 策略**：UUID v4 做目录名（`tool_io.rs: new_tool_id`），从根本上消除导入同名冲突。name 不决定目录名。

### 5.3 渲染端组件

- **App.tsx**：三栏布局。状态：`activeId` / `editingId` / `liveCwd` / 侧栏与帮助栏的折叠态及宽度（都持久化到 localStorage）。每 ~1.5s 轮询当前 shell 的实时 cwd（`api.pty.cwd`）。两阶段导入：preview（选文件+解析+风险扫描，不写盘）→ 确认 → confirm（落盘）。
- **TerminalPane**：每个工具一个 `TerminalView`，切工具只 toggle `display:none`。xterm Terminal + pty **懒创建**于首次激活，之后跨切换常驻。
- **TerminalView**：xterm 实例 + fit；注意 `display:none` 容器首帧渲染坑（§6.2）。
- **HelpPane**：markdown 渲染（markdown-it），拦截 `.cmd-btn` 点击 → `runCommand`；TOC + 长内容分节折叠。
- **EditorPane**：CodeMirror 编辑 tool.json + help.md。
- **Sidebar**：工具列表 + 拖拽排序 + 新建/删除/导入导出。
- **QuickCommands**：全局快捷命令下拉（读 `quick-commands.md`，在当前激活终端执行）。
- **ConfigRecords**：配置版本历史 modal（`__global__`=全部 / toolId=单工具）。
- **ParamPromptModal / QuickAddModal / HelpModal**：各种弹窗。

### 5.4 hooks
- `useTools`：订阅 `tools:changed` + 首次 `tools:list`。
- `useTauriEvent`：封装 listen，返回 cleanup（listen 是异步的，**别**把返回值直接当 effect cleanup）。
- `useUpdateState` / `usePeek`。

### 5.5 lib
- **api.ts**：唯一 IPC 入口。结构与旧 Electron preload 的 `window.api` 同构，调用点只需 `window.api` → `api`。
- **termRegistry.ts**：toolId → Terminal 映射；`runCommand` 把命令粘进正确终端。
- **markdown.ts**：覆盖 markdown-it 的 `fence` 规则（§6.1）。
- **runCommandChecked.ts**：执行前过 `isDangerousCommand` 二次确认。
- **theme.ts / clipboardToast.ts / dialog.ts / paramPrompt.tsx**。

---

## 6. 模块实现详解与知识点

### 6.1 `buttons` markdown 扩展（核心特色）

`renderer/lib/markdown.ts` 覆盖 fence 规则：
- ` ```buttons `：每行一个按钮，语法 `命令 [# 标签] [// edit]`。`shared/buttonBlock.ts` 解析成 `<button class="cmd-btn">`。
  - 行尾 ` // edit` = 粘贴不回车（编辑模式）。
  - 行首（trim 后）`//` = **纯文本标签**（`<div class="cmd-text">`，不可点击）。
  - 行首 `#` = shell 注释，只留源码不渲染。
- ` ```buttons-json `：JSON 描述，命令用 `{{name}}` 占位，点按钮弹表单。值做 **POSIX shell 转义**后替换（含空格/引号也安全，**占位符外面不要再包引号**）。参数可配 hint/options/default/required。

后端 `pure.rs` 有对偶实现（merge/serialize/parse/scan_tool_risk）。`scan_tool_risk` 在导入预检时汇总风险字段（自定义 shell / initCommands / mdUrl / envKeys），前端据此弹确认。

### 6.2 终端：懒加载 + 持久化 + 首帧渲染

- 每个工具一个 xterm Terminal + portable-pty，**首次激活才创建**，之后跨工具切换常驻（`PtyService` 按 toolId 缓存）。
- **坑**：绝不在 `display:none` 容器里创建 xterm —— 渲染器不画提示符。只在 tab 可见时创建，并在显示后用 `requestAnimationFrame` 调 `fit()`。
- 实时 cwd：顶栏显示，由后端 `pty_cwd` 命令先试 lsof 取 shell pid 的 cwd，失败回退 meta.cwd 再回退 home。

### 6.3 PtyService（`src-tauri/src/pty.rs`）

portable-pty 池，keyed by toolId。**6 个微妙行为**（文件头注释列出）：
1. **登录 shell `-l`**：GUI 应用继承的是 launchd 的最小 PATH（缺 `/opt/homebrew/bin`）；`-l` 让 zsh 读 `~/.zprofile`。否则打包后 `git`/`brew` "not found"。
2. **`TERM=xterm-256color`**：portable-pty 无 `name` 字段（不像 node-pty），必须 `cmd.env("TERM", ...)`。同理 `LANG`/`LC_CTYPE`/`COLORTERM` —— **仅 unset 时设**，保留用户已设（否则 BSD `ls` 对非 ASCII 文件名显示 `?`）。
3. initCommands 写入时机：spawn 后立即 write（缓冲到 shell 就绪）。
4. restart 竞态：**generation guard**（见下）。
5. `desired` map 记住每个终端尺寸，respawn 时保持。**退出不清 desired**（尺寸跨 shell 存活）。
6. `take_writer` 只能调一次，存 `Mutex<Option<...>>`；`try_clone_reader` 交读线程；master 留在 entry 支持 resize。

**generation guard（关键坑）**：被 kill 的 shell 的读线程**异步**到 EOF。`ensure` 给每个 entry 分配递增 generation；读线程 EOF 时比对 `entry.generation == my_gen`，只有匹配才移除 —— 这样 restart 旧 shell 的延迟 EOF 不会踢掉新 shell 或重置其尺寸。读线程用 `try_state`（不是 `state`）以容忍 app 拆除。

**哨兵防重复 spawn**：`in_progress` HashSet + `SentinelGuard`（RAII）消除「检查无 entry → 释放锁 → spawn」窗口内的并发重复 spawn（否则后插入者覆盖前者 entry，前者 child 成孤儿）。early return 路径（openpty/spawn/reader/writer 失败）必须 `killer.kill()` 已 spawn 的 child，否则泄漏。

### 6.4 watcher（`src-tauri/src/watcher.rs`）

- **notify 6.x API 变了**：`recommended_watcher` 接**单个回调**（返回 `Result<Event>`），不是旧的 `(callback, Config)`。用 mpsc channel 包一层闭包。
- debounce ~200ms；触发后再 sleep 150ms 让连续写入稳定再 scan。
- 初始 scan 后立即广播一次（renderer 启动即有数据）。
- auto-refresh tick（30s）：检查 mdUrl 工具的 `autoUpdateMinutes` 是否到期。
- `WatcherState` 用 `Arc<Mutex<...>>`，`refresh_md` 命令也共享它访问 `lastTools`。

### 6.5 迁移链（`src-tauri/src/tool_io.rs`，启动时同步执行）

启动时在 `lib.rs setup()` 里、任何 scan/seed/pty **之前**、同步执行三步迁移（全部幂等）：
1. **`migrate_to_configs_blocking`**：旧布局（`tools/` + `quick-commands.md` 直接在 user_data_dir）→ `configs/` 子目录（configs 成为 git 仓库根）。幂等判断**用 `configs/.migrated` 标志文件**（不用 configs 是否存在——create_dir 成功但 rename 失败会留空 configs，那种仍需重试）。标志文件必须在所有 rename 成功后才写。
2. **`migrate_to_uuid_ids_blocking`**：旧 slug 目录名 → UUID（解决导入同名冲突）。已是合法 UUID（含版本位校验）跳过。
3. **`migrate_order_to_index_blocking`**：每个 tool.json 的 `order` 字段 → 单一 `order.json` 索引，并清理 tool.json 的 order。必须在 UUID 迁移**之后**（索引存迁移后的 UUID 目录名）。

### 6.6 配置版本控制（`src-tauri/src/vcs.rs`，0.9.1+）

在 `configs/` 上用系统 git 做本地快照：
- **零外部依赖**：统一 `std::process::Command` 调系统 git（macOS 标配）。每个 Command 设 `.current_dir(configs_dir)`，git 操作**绝不触及上级**的 Chromium 运行时目录。
- **降级安全**：`git_available()` 启动探测一次，结果存 `VcsState.available`；不可用时上层隐藏 UI，其余功能不受影响。
- **自动提交**：每次保存且文件有变动时 `snapshot_path`（仅暂存并提交指定 pathspec，无变更时 `committed=false` 不产生空提交）。提交失败**只告警，绝不阻断写入**（配置保存是首要功能，版本控制是附加价值）。
- 模型：**只自动提交，无手动快照**。vcs 命令先查 `available`，不可用时降级返回空（不报错弹窗）。

### 6.7 安全要点（`src-tauri/src/tools.rs`，深度审查后的防护）

- **路径穿越**：`commands.rs: validate_tool_id` 拒绝空串、`/`、`\`、`..`、NUL。
- **敏感文件守卫**：`sensitive_path_reason` 拒绝 `.ssh`/`.aws`/`.kube`/`.gnupg`/`Library/Keychains` 等目录，以及凭据文件名模式（`id_*`/`.env*`/`*.key`/`*.pem`/`.zshrc`/`passwd` 等）。本地 mdUrl 还有**扩展名白名单**（仅 `.md`/`.markdown`/`.txt`），防止把 fetch 当任意文件读取器。
- **SSRF**：`is_internal_host` 拒绝环回/私有/链路本地/元数据地址（含 `169.254.169.254`、`metadata.google.internal`、`.local`/`.internal`）。`extract_host` 对 scheme **大小写不敏感**（旧实现 `strip_prefix` 区分大小写，大写 scheme 绕过整个守卫——已修）。`is_internal_ipv4` 拒绝八进制(`0177`)/十六进制(`0x7f`)/前导零/溢出段等**等价写法**（resolver 会内网化）。IPv6 涵盖 ULA/链路本地/IPv4-mapped。
- **禁重定向**（防 http→file 或重定向到内网）+ **2 MiB 响应上限**（防 OOM）+ **8s 超时** + **浏览器 UA**（CDN/Cloudflare 会拒 reqwest 默认 UA）。
- **HTTP_UA** 必须像浏览器，**不能**是 "TermStep" 等自定义名。
- **导入预检**：`scan_tool_risk` 在落盘前让用户确认 initCommands（导入后打开工具即执行，最高风险）/ 自定义 shell / mdUrl / env。
- **危险命令**：`shared/dangerous.ts: isDangerousCommand` 拦截 `rm -rf` 根/家目录、mkfs、dd 到设备、fork bomb、shutdown、`curl|sh` 等，按钮注入与快捷命令执行前弹 confirm。常规 `rm -rf ./build` 不拦截。

---

## 7. 存储位置

- 用户数据：`app.path().config_dir().join("TermStep")` = `~/Library/Application Support/TermStep`。
  - **故意用 productName（"TermStep"）而非 identifier（"local.termstep"）派生**，以与 Electron 时代 userData 路径完全一致——老用户零迁移。`app_data_dir()` 会给 `.../local.termstep`，是**错的**。
  - 项目根的 `ln_library_data` 软链指向这里，方便直接查看用户数据。
- 工具：`.../TermStep/configs/tools/<UUID>/`（configs/ 是 git 仓库根）。
- 快捷命令：`.../TermStep/configs/quick-commands.md`。
- 更新状态缓存：`.../TermStep/update-state.json`。

---

## 8. 历史坑点 / Gotchas（非显而易见，吃过亏）

1. **Tauri v2 clipboard 是插件**（`tauri-plugin-clipboard-manager`）；本项目用 `arboard` 直接操作（更简单，无需 capability）。
2. **notify 6.x API 变了**：`recommended_watcher` 接单回调，不是 `(callback, Config)`。用 mpsc channel 包闭包（§6.4）。
3. **绝不在 `display:none` 容器创建 xterm** —— 不画提示符。显示后 `requestAnimationFrame` + `fit()`（§6.2）。
4. **portable-pty 生命周期竞态** —— generation guard（§6.3）。读线程用 `try_state`。不清 desired。
5. **PTY 必须 `-l` 登录 shell** —— 否则打包后 PATH 缺 homebrew（§6.3 行为 1）。
6. **portable-pty 无 `name` 字段** —— `TERM` 等必须 `cmd.env(...)`；locale 仅 unset 时设（§6.3 行为 2）。
7. **`take_writer` 只能调一次**；early return 路径必须 `killer.kill()` 已 spawn 的 child 防孤儿（§6.3）。
8. **打包未签名、host-arch** —— 收方需 `xattr -cr` 或右键打开。签名+公证需 Apple Developer ID。
9. **dev 端口 1420 固定**（`tauri.conf.json` devUrl / `vite.config.ts` `strictPort` 必须一致）。
10. **icons/ 是 gitignored** —— `npm run icon` 从 `assets/icon.png`（tracked）生成，别提交生成的多尺寸集。
11. **Cargo.lock 是 tracked**（Tauri 是二进制项目）。
12. **多个 `Mutex<PathBuf>` State 要 newtype** —— `ToolsDir`/`ConfigsDir`/`UpdateStateFile`，否则 Tauri 按类型查找冲突（§5.1）。
13. **所有取锁用 `lock_or_recover!`** —— 跳过中毒锁，避免一处 panic 永久瘫痪子系统。
14. **SSRF 守卫 scheme 大小写不敏感**（旧 bug：大写 scheme 绕过）；IPv4 等价写法（八进制/十六进制/前导零）一律拒（§6.7）。
15. **迁移幂等判断用标志文件**，不靠目录是否存在（§6.5）。
16. **listen 是异步的**，`useTauriEvent` 包装，别把返回值直接当 effect cleanup。
17. **scan 仅在 `useRemote:true` 才读 mdUrl** —— 否则指向 `~/Downloads` 等受 TCC 保护目录的 mdUrl 会每次扫描触发 macOS「想访问下载文件夹」弹窗（回归测试覆盖）。

---

## 9. 每次会话初始化检查清单

开始工作前，建议：
1. **确认分支与状态**：`git status` + `git log --oneline -5`。主分支 `main`，git 用户 sunknight。
2. **当前版本**：`package.json` 的 `version`（现 0.9.2）。升版本用 `npm run version:set`，**完整发版用 `changelog-gen` skill**（说「用 changelog-gen 发版」），见 §2「发布新版本」。
3. **类型/测试基线**：改动前先 `npm run typecheck` + `npm run test` + `cargo test --manifest-path src-tauri/Cargo.toml` 确认全绿，再动。
4. **改 IPC**：遵循四步（§5.1），三端都要改，否则类型断裂。
5. **改用户数据格式**：考虑迁移（§6.5），迁移要幂等、同步、在 scan/seed/pty 之前、用标志文件。
6. **涉及远程/文件读取**：检查 SSRF/敏感路径/扩展名白名单/禁重定向/大小上限（§6.7）。
7. **涉及 pty**：回顾 6 个微妙行为 + generation guard（§6.3）。
8. **提交**：仅在被要求时提交/推送；在 `main` 上先开分支。本项目提交信息多为中文，前缀 `feat:`/`fix:`/`ui:`/`docs:`/`chore:`，常带版本号 `(0.9.x)`。

---

## 10. 相关文档

- `CLAUDE.md`：架构精简版（与本文有重叠，本文更全且含 VCS/迁移/安全细节）。
- `README.md`：用户向介绍（**部分仍残留 Electron 表述**——node-pty/electron-vite/chokidar 等已过时，以本文为准）。
- `docs/superpowers/specs/`：各特性设计文档（Tauri 迁移、按钮参数、折叠面板、更新检查、cmd-click 复制等）。
- `docs/superpowers/plans/`：实现计划与进度（含 `tauri-migration-progress.md`、`todo.md`）。
