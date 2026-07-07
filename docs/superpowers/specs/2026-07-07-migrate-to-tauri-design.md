# TermStep: Electron → Tauri v2 迁移设计

**日期**: 2026-07-07
**状态**: 设计
**分支**: `migrate-to-tauri`（worktree `.worktrees/migrate-to-tauri`）

## 背景与目标

TermStep 当前是 macOS Electron 应用（安装包 94MB），把 CLI 命令变成可点击的菜单/按钮。每个"工具"有自己的持久终端（node-pty + xterm.js）和一个 markdown 帮助页，其 ` ```buttons ` 围栏渲染成一键按钮。

迁移到 Tauri v2 的目标：**把安装包从 94MB 降到 ~12-15MB（降幅 ~85%）**，用系统 WebView（WKWebView）替代自带 Chromium，运行内存与启动时间同步下降。代价是主进程（1335 行 TS）全部用 Rust 重写，核心风险在 PTY 服务的几个 macOS 特定行为。

## 决策摘要（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 迁移策略 | **全量替换**——最终形态无 Electron 残留；中间态不在 Electron 下可运行，但靠分模块 + 每模块独立测试渐进验证 |
| PTY 方案 | **portable-pty**（wezterm 出品） |
| 自动更新 | **保持现状**——reqwest 拉清单 + 浏览器打开 DMG，不引入签名/公证 |
| userData | **一次性迁移脚本**——兼容旧应用名（gui_anything/cmd_gui/cmd-gui）的 carry-forward |

## 非目标（YAGNI）

- 不引入 Apple 开发者证书 / 自动安装更新
- 不支持 Windows / Linux（沿用 macOS-only 现状）
- 不重写 renderer 的 UI 组件 / hooks / lib 逻辑（仅换 IPC 数据层）
- 不改 `src/shared/` 的纯逻辑（types/bundle/toolConfig/tmux/buttonBlock/toolJson）

---

## 一、整体架构

最终形态：标准 Tauri v2 工程，Rust 后端 + 现有 React renderer。Electron 主进程 / preload / electron-vite / electron-builder 全部移除。

### 工程结构（worktree 内）

```
termstep/
├── src-tauri/                    # 新增：Tauri 工程根
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/             # Tauri v2 权限声明
│   ├── icons/                    # 从 build/icon.png 迁移（含 .icns）
│   └── src/
│       ├── main.rs               # tauri::Builder、插件注册、setup、State 初始化
│       ├── pty.rs                # portable-pty 池（核心，对应 ptyService.ts）
│       ├── tools.rs              # scanTools + fetchRemoteMarkdown（对应 toolsScanner.ts）
│       ├── tool_io.rs            # tool CRUD/save/create/delete/reorder/import/export（对应 ipc.ts 中 tool 相关）
│       ├── watcher.rs            # notify 监听 toolsDir（替代 chokidar 的 ToolManager）
│       ├── updater.rs            # reqwest 拉清单（对应 updater.ts）
│       ├── cwd.rs                # lsof（macOS）/ readlink /proc（对应 cwd.ts）
│       ├── menu.rs               # tauri::menu 原生菜单（对应 menu.ts）
│       ├── migrate.rs            # userData 一次性迁移（对应 index.ts migrateOldUserData）
│       └── commands.rs           # #[tauri::command] 注册（薄封装，连前端与上述模块）
├── src/                          # 保留：renderer + shared
│   ├── renderer/                 # React 18，UI 组件/hooks/lib 非 IPC 逻辑零改动
│   │   ├── lib/api.ts            # 新增：Tauri IPC 适配层（同构 window.api）
│   │   ├── hooks/useTauriEvent.ts# 新增：统一事件订阅 hook
│   │   └── ...（组件/hooks 原样保留）
│   └── shared/                   # 纯 TS 逻辑，原样保留（types.ts 的 IPC 常量改名）
├── package.json                  # 精简：去 electron 全家桶，加 @tauri-apps/api/cli
├── vite.config.ts                # 替代 electron.vite.config.ts（普通 Vite，仅 renderer）
└── (移除) electron-builder.yml / electron.vite.config.ts / src/main/ / src/preload/
```

### 关键取舍

- **renderer 保留 React 18 + Vite**：UI 组件/hooks/lib 的非 IPC 逻辑零改动，只换 IPC 数据层。
- **`src/shared/` 原样保留**：types.ts / bundle.ts / toolConfig.ts / tmux.ts / buttonBlock.ts / toolJson.ts / peekController.ts / dangerous.ts 全是纯 TS 逻辑，前后端共用。`types.ts` 的 `IPC` 常量改为 Tauri command/event 名字常量（语义不变）。
- **Rust 后端模块划分 1:1 对应现有 TS 主进程模块**（pty/tools/updater/cwd/menu），降低对照测试成本。

### 依赖变更

**移除（package.json devDependencies/dependencies）**：`electron`、`electron-builder`、`electron-vite`、`node-pty`、`chokidar`、`@types/node`（renderer 不再需要）。

**新增**：
- `package.json` devDep：`@tauri-apps/cli`、`@tauri-apps/api`（renderer 调用 invoke/listen）。
- `src-tauri/Cargo.toml`：`tauri`（v2）、`portable-pty`、`notify`（文件监听）、`reqwest`（HTTP）、`serde`/`serde_json`、`rfd`（原生对话框）、`tauri-plugin-opener`、`tauri-plugin-clipboard-manager`、`dirs`（home 路径）、`regex`（敏感路径）。

**保留**：react / react-dom / @vitejs/plugin-react / vite / typescript / vitest / @xterm/xterm / @xterm/addon-fit / markdown-it / @uiw/react-codemirror / @codemirror/lang-markdown / @types/markdown-it / @types/react / @types/react-dom。

### scripts（package.json）

```jsonc
{
  "scripts": {
    "dev": "tauri dev",
    "build": "vite build",                    // renderer 构建供 tauri 嵌入（typecheck 独立）
    "tauri:build": "tauri build",             // 产出 dmg
    "typecheck": "tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "icon": "node scripts/render-icon.cjs"    // 保留，图标源仍是 SVG→PNG
  }
}
```

---

## 二、IPC 契约迁移（24 channel → 21 Rust commands + 3 events）

现有契约见 `src/shared/types.ts` 的 `IPC` 常量与 `src/preload/index.ts` 的 `api` 对象。renderer 共 34 处 `window.api.*` 调用（3 处事件订阅 + 31 处 invoke），分布在 11 个文件。

### invoke 型（21 个 channel → `#[tauri::command]`）

channel 名 `:` → `_`，参数用具名 struct（Tauri v2 command 参数从前端按 camelCase 传，Rust 侧 snake_case）：

| Electron channel | Rust command | 实现模块 | 现有 TS handler |
|---|---|---|---|
| `tools:list` | `tools_list` | watcher | toolManager.scan |
| `pty:write` | `pty_write` | pty | ptyService.write |
| `pty:open` | `pty_open` | pty | ptyService.open |
| `pty:restart` | `pty_restart` | pty | ptyService.restart |
| `pty:resize` | `pty_resize` | pty | ptyService.resize |
| `pty:kill` | `pty_kill` | pty | ptyService.kill |
| `pty:cwd` | `pty_cwd` | cwd + pty | liveCwd(pidOf) |
| `tool:save` | `tool_save` | tool_io | merge tool.json + 写 help.md |
| `tool:appendButtons` | `tool_append_buttons` | tool_io | buildButtonsAppend |
| `tool:create` | `tool_create` | tool_io | slugify + 建 dir + starter md |
| `tool:delete` | `tool_delete` | tool_io + pty | kill pty + rm -r |
| `tool:reorder` | `tool_reorder` | tool_io | 写各 tool.json order |
| `tools:export` | `tools_export` | tool_io + rfd | serialize + 保存对话框 |
| `tool:exportOne` | `export_one` | tool_io + rfd | serialize 单个 + 保存对话框 |
| `tools:import` | `tools_import` | tool_io + rfd | 打开对话框 + parseToolsBundle |
| `tool:refreshMd` | `refresh_md` | watcher | toolManager.refresh |
| `md:fetchPreview` | `fetch_md_preview` | tools | fetchRemoteMarkdown（不落盘） |
| `md:pickFile` | `pick_md_file` | rfd | 原生文件选择器 |
| `quick:get` | `quick_get` | tool_io | 读 quick-commands.md |
| `quick:save` | `quick_save` | tool_io | 写 quick-commands.md |
| `shell:openExternal` | `open_external` | opener 插件 | 校验 http(s)/mailto + openExternal |
| `clipboard:read` | `clipboard_read` | clipboard 插件 | clipboard.readText |
| `clipboard:write` | `clipboard_write` | clipboard 插件 | clipboard.writeText |
| `update:check` | `update_check` | updater | checkForUpdates(manual) |

### 事件型（3 个 channel → Tauri `emit`/`listen`）

保留原名字符串作为 event 名（renderer 的 `types.ts` 常量沿用），Rust 端 `app_handle.emit(name, payload)`：

| event | 触发点 | payload | renderer 订阅点 |
|---|---|---|---|
| `pty:data` | pty 读线程 emit | `{ toolId: String, data: String }` | TerminalView.tsx:113 |
| `tools:changed` | watcher 检测变化后 emit | `ScanResult` | hooks/useTools.ts:8 |
| `update:state` | updater 状态变更 emit | `UpdateState` | hooks/useUpdateState.ts:10 |

### 跨 command 状态管理

PTY 池、watcher、updater 状态需跨 command 持有 → Tauri v2 `State<T>`：
- `State<Mutex<PtyService>>`（pty 池 + desired 尺寸 + pid 映射）
- `State<Mutex<ToolManager>>`（notify watcher + lastTools/lastFetched）
- `State<Mutex<UpdateState>>`（updater 状态 + checking 标志 + notified version）

在 `setup()` 里初始化，commands 通过 `tauri::State` 参数获取。

### 工具数据共享

`ScanResult`/`Tool`/`ToolMeta`/`UpdateState` 等类型需 Rust↔renderer 双方都能序列化。Rust 侧定义对应 `#[derive(Serialize, Deserialize)]` struct，字段名用 `#[serde(rename_all = "camelCase")]` 对齐 TS。`PtySpawnOpts` 同理。renderer 侧 `types.ts` 不变（仍是 TS 源），Rust struct 作为对偶。

---

## 三、PTY 服务（portable-pty）—— 核心风险模块

对应 `src/main/ptyService.ts`（140 行）。这是终端应用的核心，也是迁移最容易出问题的模块。`src-tauri/src/pty.rs` 重写。

### 数据结构

```rust
struct PtyPair {
    writer: Box<dyn std::io::Write + Send>,   // master writer（写用户输入）
    child: Box<dyn Child + Send>,             // 子进程（取 pid + kill）
    reader_handle: Option<std::thread::JoinHandle<()>>, // 读线程
    generation: u64,                          // identity guard 用
}

pub struct PtyService {
    ptys: Mutex<HashMap<String, PtyPair>>,
    desired: Mutex<HashMap<String, (u16, u16)>>, // cols, rows
    next_gen: AtomicU64,
}
```

### 6 个微妙行为的逐项复现

1. **登录 shell `-l`**（最关键）
   - node-pty: `args = ['-l', ...]`
   - portable-pty: `cmd.arg("-l")`；有 tmux 时再 `.arg("-c").arg(format!("exec tmux new -A -s '{}'", escaped))`
   - 验证点：打包后 `$PATH` 含 `/opt/homebrew/bin`，`which brew` 可用。

2. **`TERM=xterm-256color`**
   - node-pty: 靠 `name: 'xterm-256color'` 字段
   - portable-pty: **无 name 字段**，必须 `cmd.env("TERM", "xterm-256color")`
   - 验证点：`echo $TERM` 输出 `xterm-256color`。

3. **locale 回退 `en_US.UTF-8`**
   - 仅在 unset 时设（不覆盖用户已设）：`if env.get("LANG").is_none() { cmd.env("LANG", "en_US.UTF-8"); }`，LC_CTYPE 同理
   - 验证点：`touch 中文文件名 && ls` 不显示 `?`。

4. **`COLORTERM=truecolor`**
   - 同 3，仅 unset 时设
   - 验证点：彩色命令（如 `ls --color`）正常显色。

5. **initCommands 写入时机**
   - `slave.spawn_command()` 返回 child 后，立即 `master_writer.write_all(batch)`（batch = 各命令 + `\r` 拼接）
   - portable-pty 同样缓冲到 shell 就绪，无需 delay；try/catch 等价 `let _ = writer.write_all(...)` 忽略已关闭
   - 验证点：工具配置的 initCommands 出现在首个 prompt 前。

6. **restart 竞态（identity guard）**
   - node-pty: `if this.ptys.get(id) === p { delete }`
   - Rust: 读线程退出时 `if ptys.get(id).map(|p| p.generation) == Some(old_gen) { ptys.remove(id); }`
   - `restart` 先 kill 旧 child（触发读线程退出），spawn 新的 generation+1，旧线程的延迟退出因 generation 不匹配而 no-op
   - **不在退出时清 desired**（与现有一致：terminal 尺寸跨 shell 存活）
   - 验证点：快速连点 restart 按钮不丢尺寸、新 shell 不被旧 onExit 误删。

### 数据流（主进程 → renderer）

- 每个 pty spawn 后 `std::thread::spawn` 一个读线程，循环 `reader.read_to_string` 小块（如 4KB）→ `app_handle.emit("pty:data", PtyDataPayload{ toolId, data })`
- 读线程持有 `app_handle: AppHandle` 的克隆（Tauri 的 AppHandle 是 `Clone`）
- child 退出 → 读到 EOF → 触发 identity guard 清理

### tmux argv

`src/shared/tmux.ts` 的 `sanitizeTmuxName`（正则 + 去掉 `.:`）和 `tmuxArgv`（`exec tmux new -A -s 'NAME'` 含单引号转义）移植到 Rust 纯函数，带 `#[test]` 覆盖原 `tests/tmux.test.ts` 用例。

### cwd / pid

- `Box<dyn Child>::process_id()` 返回 `Option<u32>`（portable-pty 提供）
- 喂给 `cwd.rs`：macOS 走 `lsof -a -p PID -d cwd -Fn`，Linux 走 `readlink("/proc/PID/cwd")`，逻辑对应 `src/main/cwd.ts`

### 关键 API 对应

| ptyService.ts | pty.rs |
|---|---|
| `pty.spawn(shell, args, {name,cwd,env,cols,rows})` | `pty_system.openpty(opts)` → `slave.spawn_command(cmd)` |
| `p.onData(cb)` | 读线程 emit "pty:data" |
| `p.onExit(cb)` | 读线程 EOF / child.wait → identity guard |
| `p.write(data)` | `master_writer.write_all(data.as_bytes())` |
| `p.resize(c,r)` | `master.resize(PtySize{rows,cols})`（portable-pty Master::resize） |
| `p.kill()` | `child.kill()` + 清 map |
| `p.pid` | `child.process_id()` |

---

## 四、renderer IPC 适配层（改动最小化）

新增 `src/renderer/lib/api.ts`，**导出一个与现有 `window.api` 同构的对象**，让 34 处调用点的改动统一为「`window.api.X` → `api.X`」。

### 核心实现

```ts
// src/renderer/lib/api.ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ScanResult, ToolMeta, PtySpawnOpts, UpdateState } from '../../shared/types';

export const api = {
  pty: {
    write: (toolId: string, data: string, opts?: PtySpawnOpts) =>
      invoke('pty_write', { toolId, data, opts }),
    open: (toolId: string, opts?: PtySpawnOpts) => invoke('pty_open', { toolId, opts }),
    restart: (toolId: string, opts?: PtySpawnOpts) => invoke('pty_restart', { toolId, opts }),
    resize: (toolId: string, cols: number, rows: number) => invoke('pty_resize', { toolId, cols, rows }),
    cwd: (toolId: string) => invoke<string>('pty_cwd', { toolId }),
    kill: (toolId: string) => invoke('pty_kill', { toolId }),
    onData: (cb: (toolId: string, data: string) => void) =>
      listen<{ toolId: string; data: string }>('pty:data', e => cb(e.payload.toolId, e.payload.data)),
  },
  tools: {
    list: () => invoke<ScanResult>('tools_list'),
    onChanged: (cb: (r: ScanResult) => void) =>
      listen<ScanResult>('tools:changed', e => cb(e.payload)),
  },
  tool: { /* save/appendButtons/create/del/reorder — invoke 包装 */ },
  shell: { openExternal: (url: string) => invoke('open_external', { url }) },
  clipboard: {
    readText: () => invoke<string>('clipboard_read'),
    writeText: (text: string) => invoke('clipboard_write', { text }),
  },
  update: {
    onState: (cb: (s: UpdateState) => void) => listen<UpdateState>('update:state', e => cb(e.payload)),
    check: () => invoke('update_check'),
  },
  bundle: { export, exportOne, import },
  refreshMd: () => invoke('refresh_md'),
  fetchMdPreview: (url: string) => invoke<{ markdown: string; error: string | null }>('fetch_md_preview', { url }),
  pickMdFile: () => invoke<{ canceled: true } | { canceled: false; path: string }>('pick_md_file'),
  quick: { get, save },
};
```

**注意**：`onData`/`onChanged`/`onState` 现在返回 `Promise<UnlistenFn>`（Tauri listen 异步），而非 Electron 时代的同步 unsubscribe 函数。需统一 hook 收敛。

### 统一事件订阅 hook

新增 `src/renderer/hooks/useTauriEvent.ts`：

```ts
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export function useTauriEvent<T>(name: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let active = true;
    listen<T>(name, e => ref.current(e.payload)).then(u => {
      if (active) un = u; else u();
    });
    return () => { active = false; un?.(); };
  }, [name]);
}
```

改造点：
- `hooks/useTools.ts:8` `window.api.tools.onChanged` → `useTauriEvent('tools:changed', setResult)`
- `hooks/useUpdateState.ts:10` `window.api.update.onState` → `useTauriEvent('update:state', setState)`
- `TerminalView.tsx:113` `window.api.pty.onData` → `useTauriEvent('pty:data', ...)`（注意该文件 onData 需按 toolId 过滤，handler 内判断）

### 34 处调用点的改法

- **事件订阅（3 处）**：改用 `useTauriEvent`（见上）。
- **invoke 型（31 处）**：`window.api.NS.method(args)` → `import { api } from './lib/api'; api.NS.method(args)`。参数从位置参数改为具名对象（Tauri command 接收 struct）。
- **类型**：保留 `src/shared/types.ts` 的 `Api` 类型导出，让 `api.ts` 的对象 `satisfies Api`（或重新定义）。`src/preload/global.d.ts` 删除（不再有 window.api）。

---

## 五、低风险模块移植（updater / tools / tool_io / cwd / watcher / migrate）

### updater.rs（对应 updater.ts，191 行）

- 纯函数 `compare_versions`/`parse_manifest` 直接移植，带 `#[test]`（对偶 `tests/updater.test.ts` 用例）
- `fetch_manifest`：`reqwest::blocking` 或 async（Tauri command 默认在异步上下文）+ 10s 超时
- 状态机 `UpdateState`（idle/checking/upToDate/available/error）用 `Mutex<UpdateState>` + listeners 改为 `emit("update:state", ...)`（替代 Set 回调）
- 去重文件 `update-state.json`：读写 `app_data_dir`
- `MANIFEST_URL` 环境变量 `TERMSTEP_UPDATE_URL` 保留
- 启动后 5s 静默检查（沿用现有延迟）

### tools.rs（对应 toolsScanner.ts，187 行）

- `scan_tools(tools_dir)` 读目录 + parse tool.json + 读 help.md + 可选 fetchRemoteMarkdown
- `fetch_remote_markdown`：本地文件用 `fs::read_to_string`（含 `file://` 解析），http(s)/data 用 `reqwest`
- **敏感路径守卫 `sensitive_path_reason`** 移植为 Rust 纯函数，`SENSITIVE_DIR_SEGMENTS`/`SENSITIVE_FILE_PATTERNS` 原样照搬，`#[test]` 覆盖原 `tests/toolsScanner.test.ts` 用例（.ssh/.aws/.kube/.env/id_rsa/credentials/*.key 等）

### tool_io.rs（对应 ipc.ts 中 tool CRUD 部分）

- `tool_save`：`merge_tool_json`（移植 `shared/toolJson.ts` 逻辑）+ 写 tool.json/help.md
- `tool_append_buttons`：`build_buttons_append`（移植 `shared/buttonBlock.ts`）
- `tool_create`：slugify + unique id + starter help.md（含 buttons/buttons-json 语法注释）
- `tool_delete`：先 kill pty，再 `fs::remove_dir_all`
- `tool_reorder`：写各 tool.json 的 order
- `tools_export`/`export_one`/`tools_import`：`serialize_tools`/`parse_tools_bundle`（移植 `shared/bundle.ts`）+ `rfd::FileDialog` 保存/打开
- `quick_get`/`quick_save`：读写 `quick-commands.md`，DEFAULT_QUICK_MD 移植
- slugify / uniqueId 移植为 Rust 函数

### cwd.rs（对应 cwd.ts，28 行）

- `live_cwd(pid)`: macOS `lsof -a -p PID -d cwd -Fn`（用 `std::process::Command`），Linux `readlink("/proc/PID/cwd")`
- 返回 `Option<PathBuf>`

### watcher.rs（对应 toolManager.ts，83 行）

- `notify::recommended_watcher` 监听 toolsDir，debounce 200ms（与 chokidar 的 `awaitWriteFinish` 对齐）
- 变化触发 `scan_tools` → `app_handle.emit("tools:changed", result)`
- 启动时做一次初始 scan（与现有一致）
- auto-refresh 定时器：`tokio::spawn` + `interval(30s)`，检查各 mdUrl 工具的 autoUpdateMinutes 是否到期
- 状态：lastTools / lastFetched 用 `Mutex` 持有

### migrate.rs（对应 index.ts migrateOldUserData，+ 新）

- **关键发现**：Tauri v2 `app.path().app_data_dir()` 在 macOS = `~/Library/Application Support/TermStep`（由 bundle identifier `local.termstep` + productName 派生），**与 Electron 的 userData 路径恰好相同**。所以新旧 TermStep 数据天然连续。
- 迁移逻辑：目标 toolsDir 非空则跳过；否则按 `['gui_anything', 'cmd_gui', 'cmd-gui']` 顺序（最新名优先）检查 `~/Library/Application Support/<oldName>/tools` 和 `quick-commands.md`，有则 `fs::copy` 递归
- 纯 Rust fs 实现，在 `setup()` 里 seed 之前调用

---

## 六、原生体验（菜单 / Dock / About）

### 菜单（对应 menu.ts，70 行）

`tauri::menu::Menu` + `Submenu`。macOS 第一项 label 必须是 app 名（TermStep）。映射：

| Electron role | Tauri v2 |
|---|---|
| about | `PredefinedItem::About` |
| services | `PredefinedItem::Services`（v2 已支持 macOS services 子菜单） |
| hide / hideOthers / unhide | `PredefinedItem::Hide` / `HideOthers` / `ShowAll` |
| quit | `PredefinedItem::Quit` |
| undo/redo/cut/copy/paste/selectAll | `PredefinedItem::*`（均有） |
| reload/toggleDevTools | 自定义 MenuItem（dev only）+ `on_menu_event` |
| resetZoom/zoomIn/zoomOut/togglefullscreen | `PredefinedItem::*` 或自定义 |
| minimize/zoom/close | `PredefinedItem::*` |
| 「检查更新…」 | 自定义 MenuItem + `on_menu_event` → updater |

标签沿用中文（关于/隐藏/退出/编辑/视图/窗口…）。**缺失的非核心 role 省略**（如个别 macOS 特殊项），不影响功能。

### Dock 图标

- 打包版：`tauri.conf.json` 的 `bundle.mac.icon` 指向 `src-tauri/icons/icon.icns`
- dev 版：Tauri dev 用 cargo 二进制，Dock 显示默认。接受 dev 下 Dock 为默认图标（非致命，与现状一致）；若必要用 `set_activation_policy(Regular)`。

### About 面板

macOS About 由菜单 About role + bundle 信息自动呈现；额外字段（applicationName/version/credits）用 Tauri v2 的 `app.set_about_metadata`（对应 Electron `setAboutPanelOptions`）。

---

## 七、测试策略

### 纯逻辑（TS，vitest，原样保留）

`src/shared/` 下的测试继续用 vitest 跑 TS，是迁移全程的回归基准：
- `bundle.test.ts` / `buttonBlock.test.ts` / `toolConfig.test.ts` / `toolJson.test.ts` / `tmux.test.ts` / `peekController.test.ts` / `dangerous.test.ts`

**这些必须在迁移全程保持绿色**——它们验证纯逻辑零回归。

### Rust 单元测试（`#[test]`）

- `updater.rs`：`compare_versions` / `parse_manifest`（对偶 `tests/updater.test.ts`）
- `tools.rs`：`sensitive_path_reason`（对偶 `tests/toolsScanner.test.ts` 的敏感路径用例）
- `pty.rs`：`sanitize_tmux_name` / `tmux_argv`（对偶 `tests/tmux.test.ts`）
- `tool_io.rs`：slugify / unique_id / merge_tool_json

### PTY 集成测试（`#[test]`，需要真实 shell）

逐个对照验证 6 个行为（详见第三节验证点）：
1. 登录 shell：`echo $PATH` 含 `/opt/homebrew/bin`（或至少 `/usr/local/bin`）
2. TERM：`echo $TERM` == `xterm-256color`
3. locale：`echo $LANG` 含 UTF-8
4. COLORTERM：`echo $COLORTERM` == `truecolor`
5. tmux：spawn 带 tmux argv 后能 attach（`tmux ls` 含目标 session）
6. restart 竞态：连续 restart 不丢尺寸、新 shell 存活

**注意**：这些是 live、慢（~1s/个）、依赖真实 `$SHELL`，与现有 `tests/ptyService.test.ts` 性质相同。放在 `#[cfg(test)]` 或单独集成测试 target，CI 可选跳过。

### renderer

UI 逻辑不变，不新增前端测试。IPC 适配层（`lib/api.ts`）靠 TS 类型检查 + 逐功能手测。

### cwd 测试

`tests/cwd.test.ts` 是逻辑测试，Rust 版 `cwd.rs` 的 lsof 调用靠手测（依赖真实进程）。

---

## 八、打包配置

### tauri.conf.json（核心字段）

```jsonc
{
  "productName": "TermStep",
  "version": "0.5.0",                   // 与 package.json 保持同步
  "identifier": "local.termstep",
  "build": {
    "beforeDevCommand": "npm run build", // vite build renderer
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:1420",   // vite dev server（或用静态）
    "frontendDist": "../dist"            // vite 产物
  },
  "app": {
    "windows": [{
      "title": "TermStep",
      "width": 1200, "height": 800
    }],
    "security": { "csp": null }          // 终端 app，沿用现状
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"],
    "icon": ["icons/icon.icns"],
    "mac": { "minimumSystemVersion": "10.15" }
  }
}
```

### 不签名、host arch（与现状一致）

- 产物 `src-tauri/target/release/bundle/dmg/TermStep_<ver>_aarch64.dmg`
- 用户仍需 `xattr -cr "/Applications/TermStep.app"` 解 Gatekeeper（CLAUDE.md gotcha 更新为 Tauri 版）
- 预期 dmg ~12-15MB（vs 当前 94MB）

### package.json 精简

- 移除：electron / electron-builder / electron-vite / node-pty / chokidar / postinstall / rebuild 脚本
- 新增 devDep：`@tauri-apps/cli`
- 新增 dep：`@tauri-apps/api`
- scripts：`dev: tauri dev` / `tauri:build: tauri build` / `build: tsc + vite build`（去掉 electron-vite）

### CLAUDE.md 更新

Gotchas 段更新：
- 移除 node-pty native module rebuild 段
- 移除 preload sandbox clipboard 段（Tauri clipboard 插件无此限制）
- 保留并改写：xterm display:none gotcha（仍然适用）、pty 生命周期竞态（改为 Rust identity guard 表述）、打包未签名 gotcha

---

## 九、风险缓解（全量替换下的安全网）

全量替换中间态不在 Electron 下可运行、不可回退。安全网靠**分模块渐进验证**（非双后端共存）：

1. **PTY 行为先写 Rust 测试再接入**——6 个行为在独立 `#[test]` 通过前，renderer 不接 pty 命令。
2. **shared/ 纯逻辑零改动**——bundle/toolConfig 等既有 vitest 测试在迁移全程必须保持绿色，是回归基准。每个 Rust 模块的纯函数都对偶原 TS 测试用例。
3. **每个 Rust 模块配对应 command 后立即手工验证一条链路**（如 tools_list → 渲染工具列表），不积压到最后。
4. **renderer IPC 适配层一次性写好 + 全量 typecheck**，34 处调用点改完 `npm run typecheck` 必须过，再逐个功能手测。
5. **打包在功能迁移完成后做**，避免早期被签名/图标问题干扰。

---

## 十、实施阶段（顺序）

虽是全量替换，仍按风险从低到高推进，每阶段产出可 `cargo build` 的增量：

### 阶段 1：脚手架（~1天）
- `src-tauri` 骨架（Cargo.toml / tauri.conf.json / build.rs / main.rs 最小 setup）
- `vite.config.ts` 替代 electron.vite.config.ts（普通 Vite，仅 renderer）
- package.json 精简依赖 + scripts
- 验证：`tauri dev` 起空壳，WKWebView 加载现有 React（白屏或最小 UI），验证渲染兼容性（xterm.js Canvas/WebGL、CSS、markdown-it）
- 图标迁移到 `src-tauri/icons/`

### 阶段 2：低风险模块（~2-3天）
- updater.rs（reqwest，带纯函数测试）
- tools.rs（scan + 敏感路径守卫，带测试）
- tool_io.rs（CRUD + bundle + quick，对偶 shared/ 纯逻辑）
- cwd.rs（lsof）
- watcher.rs（notify，替代 chokidar）
- migrate.rs（userData 兼容旧名）
- commands.rs 注册上述命令
- renderer 适配层 `lib/api.ts` + `useTauriEvent`，改造 31 处 invoke 调用点（tools/shell/clipboard/update/bundle/quick/refreshMd/fetchMdPreview/pickMdFile）+ 2 处事件（tools:changed / update:state）
- 验证：工具列表渲染、增删改、导入导出、quick commands、更新检查、剪贴板、外链全部手测通过；`npm run typecheck` + vitest 绿

### 阶段 3：PTY 攻坚（~1-2周）
- pty.rs（portable-pty 池 + 6 行为复现）
- 6 个 `#[test]`/集成测试逐个通过
- tmux.rs（移植 sanitize/tmuxArgv，带测试）
- commands 注册 pty_* 命令
- renderer 适配 pty 调用点（TerminalView / termRegistry / App.tsx 的 restart、pty.cwd）+ 1 处事件（pty:data）
- 验证：各类 shell（zsh/bash）、tmux attach/new、中文路径、locale、restart 竞态、initCommands 全部手测

### 阶段 4：原生体验 + 打包（~1-2天）
- menu.rs（原生菜单，含「检查更新…」）
- Dock 图标（打包版）
- About 面板（set_about_metadata）
- `tauri build` 产出 dmg，验证体积 ~12-15MB
- CLAUDE.md 全面更新（命令、架构、gotchas）
- 删除 `src/main/`、`src/preload/`、`electron-builder.yml`、`electron.vite.config.ts`

---

## 附录：renderer 34 处 window.api 调用点清单

| 文件 | 行 | API | 类型 |
|---|---|---|---|
| App.tsx | 85 | pty.cwd | invoke |
| App.tsx | 103 | tool.create | invoke |
| App.tsx | 109 | tool.del | invoke |
| App.tsx | 114 | tool.reorder | invoke |
| App.tsx | 118 | bundle.export | invoke |
| App.tsx | 124 | bundle.exportOne | invoke |
| App.tsx | 130 | bundle.import | invoke |
| App.tsx | 167 | refreshMd | invoke |
| App.tsx | 224 | pty.restart | invoke |
| App.tsx | 258 | tool.appendButtons | invoke |
| TerminalView.tsx | 53 | clipboard.writeText | invoke |
| TerminalView.tsx | 63 | clipboard.writeText | invoke |
| TerminalView.tsx | 76 | clipboard.readText | invoke |
| TerminalView.tsx | 101 | clipboard.writeText | invoke |
| TerminalView.tsx | 113 | **pty.onData** | **event** |
| TerminalView.tsx | 121 | pty.write | invoke |
| TerminalView.tsx | 122 | pty.resize | invoke |
| TerminalView.tsx | 134 | pty.resize | invoke |
| TerminalView.tsx | 136 | pty.open | invoke |
| HelpPane.tsx | 70 | shell.openExternal | invoke |
| QuickCommands.tsx | 20 | quick.get | invoke |
| QuickCommands.tsx | 24 | quick.get | invoke |
| QuickCommands.tsx | 77 | quick.save | invoke |
| QuickAddModal.tsx | 26 | clipboard.readText | invoke |
| UpdateChecker.tsx | 33 | update.check | invoke |
| UpdateChecker.tsx | 92 | shell.openExternal | invoke |
| EditorPane.tsx | 60 | fetchMdPreview | invoke |
| EditorPane.tsx | 122 | tool.save | invoke |
| EditorPane.tsx | 264 | pickMdFile | invoke |
| useUpdateState.ts | 10 | **update.onState** | **event** |
| useTools.ts | 7 | tools.list | invoke |
| useTools.ts | 8 | **tools.onChanged** | **event** |
| termRegistry.ts | 22 | pty.write | invoke |
| termRegistry.ts | 26 | pty.write | invoke |
