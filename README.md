# TermStep

> 把任意 CLI 命令变成可点击的菜单按钮，也能作为团队文档入口 —— 一个本地 macOS Tauri 应用。

为每个「工具」分配一个**持久终端**和一个 **markdown 帮助页**；帮助页里的 ```` ```buttons ```` 代码块会渲染成一键执行的命令按钮。终端基于 portable-pty + xterm.js，跑的是真实 shell。终端可以隐藏（只看文档）、文档可以折叠为浮动小窗，布局方向可选左右或上下——既适合在终端里干活，也适合给不用 CLI 的同事当文档入口。

---

## ✨ 特色

- **命令即按钮**：在 markdown 里写一行命令，就得到一个可点击按钮。复杂带参数的命令用 JSON 描述，点击后弹出参数表单，填完安全转义后执行。
- **每个工具一个持久终端**：基于 portable-pty 的真实 shell（zsh/bash），在真实 xterm.js 终端里运行；切换工具只切换可见性，终端进程常驻、历史不丢。
- **灵活布局**：终端和文档可左右排，也可上下排；终端可一键隐藏（只看文档，pty 仍在后台保持会话），文档可折叠成浮动小窗。给不用 CLI 的同事把终端藏起来当纯文档入口。
- **工具就是磁盘上的数据**：每个工具是一个目录（`tool.json` + `help.md`），不是代码。整个 UI 从扫描这些目录派生而来，可用任意编辑器改，也可在应用内编辑。
- **磁盘改动自动刷新**：文件监听监视工具目录，新建 / 编辑 / 删除 / 重排工具后 UI 自动更新，无需手动刷新状态。
- **零配置即可用**：首次启动自动生成一个示例 Git 工具。
- **纯本地、无后端**：所有数据在本机 `~/.config/TermStep/` 下；不联网、不上传（仅「检查更新」按需拉取版本清单）。

---

## 🧩 主要功能

### 工具管理
- 侧边栏**新建 / 删除 / 拖拽排序**工具。
- **工具分组**：编辑工具时选择已有分组或新建分组，侧栏按分组分区展示，分组可点击折叠/展开；同一分组内可拖动排序，也支持跨分组拖拽移动。
- 应用内编辑器修改工具元数据（名称、图标、布局方向、终端初始显隐、分组、工作目录、工具根目录、shell、环境变量、tmux 会话、启动命令）和帮助 markdown。编辑以**弹窗（modal）**形式打开，不再占用右栏，可与工具列表和帮助页同时查看。
- **导入 / 导出**工具（JSON bundle），可单个或全部导出，方便备份与分享。同一 bundle 重复导入会更新已有工具而非重复创建（按 `sourceId` 去重）。

### 布局：文档 + 可选终端

每个工具都是「文档区 + 终端区」的组合，两个维度可配（编辑工具时设置）：

- **布局方向**：`LR`（文档在左、终端在右，默认）或 `TB`（文档在上、终端在下）。
- **终端初始状态**：可设为默认隐藏——打开工具时只看文档，顶栏一键 toggle 显示终端。隐藏时 pty 仍在后台保持会话，重新显示立即可见完整历史。

文档区可折叠成浮动小窗（点文档区右上角 ⤢），让终端独占主区；折叠后点小窗的 ▾ 展开。终端隐藏 + 文档折叠两种状态独立切换。

终端隐藏时，帮助页里的命令按钮点击会提示「请先打开终端」（不会静默失败）；`⌘/Ctrl + 点击` 复制命令到剪贴板照常工作。

### 终端
- 每个工具有独立、**懒加载且持久**的 xterm 终端：首次打开才创建，之后跨工具切换保持存活。隐藏终端时实例和会话都保留，重新显示输出不丢。
- 顶栏实时显示当前 shell 的工作目录（由后端 `lsof` 解析自 shell pid，跟随你的 `cd`）。
- 顶栏「▾ 终端 / ▸ 终端」按钮：一键隐藏 / 显示终端（不影响 pty 会话）。
- 「↻ 重启终端」按钮：shell 退出或卡住时一键拉起新 shell。
- 支持 **tmux 会话**：配置会话名后，shell 以 `tmux new -A -s <name>` 启动（已存在则 attach）。
- 支持 **initCommands**：工具打开时自动注入的启动命令。
- 打开新工具时提示符立即可见（已处理 xterm v5 首帧渲染时序）。

### 命令按钮（核心特色）

帮助 markdown 里用围栏块定义按钮：

**简单按钮** —— ```` ```buttons ```` 围栏，每行一个，语法 `命令 [# 标签] [// edit]`；行首 `//` 开头的行渲染为普通文本（不渲染成按钮）：

````markdown
```buttons
// 查看状态
git status # 查看状态
git log --oneline -20

// 改完再提交
git commit -m "" // edit
git push # 推送
```
````

- `命令` 是要执行的字面命令。
- ` # 标签`（空格-井号-空格）覆盖按钮显示文字。
- ` // edit` 后缀表示「粘贴不回车」（编辑模式：贴进终端后不自动按回车，方便你改完再执行）。
- 行首 `//`（trim 后）表示该行是**普通文本**，渲染为标签/说明，与按钮交织排列；不可点击，也不进快捷命令下拉。`//` 靠位置区分：行首 = 文本，行尾 = edit 模式。

**`@/` 工具主目录占位符** —— 命令里写 `@/`，点击执行时自动替换为工具的「工具根目录」（编辑工具时设置），未设置时依次回退到终端当前工作目录、用户主目录。方便写跨项目通用的按钮。

**参数化按钮** —— ```` ```buttons-json ```` 围栏，JSON 描述，命令里用 `{{name}}` 占位，点击后弹表单：

````markdown
```buttons-json
[
  {
    "label": "提交",
    "command": "git commit -m {{message}} {{flags}}",
    "edit": true,
    "params": [
      { "name": "message", "hint": "提交信息", "required": true },
      { "name": "flags", "hint": "附加参数（可空）", "options": ["--no-verify", "--amend"], "default": "" }
    ]
  },
  {
    "label": "切分支",
    "command": "git checkout {{branch}}",
    "params": [
      { "name": "branch", "hint": "目标分支", "options": ["main", "develop"], "required": true }
    ]
  }
]
```
````

- 占位符 `{{name}}`：表单填的值会**自动做 POSIX shell 转义**后替换（含空格 / 引号也安全），所以占位符外面**不要**再包引号。
- 每个参数可配：`hint`（说明）、`options`（建议项，可手输任意值）、`default`（默认值）、`required`（必填校验）。
- 表单顶部有命令**实时预览**；提交前若替换后的命令形似危险操作（`rm -rf` 等），会弹二次确认。
- JSON 语法错误时，帮助页会显示醒目的红色提示，而不是整块消失。

**仅复制按钮** —— 在 `buttons` / `buttons-json` 后加一个空格和 `copy`（如 ```` ```buttons copy ````），整块按钮就变成**仅复制**：点击只把命令复制到剪贴板（弹「已复制到剪贴板」提示），**不粘进终端**。按钮前会显示 📋 图标做区分。适合要在别处（远程服务器、另一台机器）粘贴执行的命令：

````markdown
```buttons copy
ssh deploy@prod.example.com  # 连接生产
kubectl get pods -A          # 查看 pod 列表
```
````

### 全局快捷命令
- 顶部 ⚡「快捷命令」下拉：一份独立 markdown 里的按钮，在整个应用范围可用，点击后在**当前激活工具**的终端里执行（终端隐藏时提示「请先打开终端」）。同样支持参数化按钮和 `@/` 占位符。

### 帮助页 / 文档
- markdown 渲染（基于 markdown-it），长内容自动分节折叠 + 配目录跳转。
- **应用内预览**：markdown 链接 `[文字](href)` 点击后不离开当前工具，在弹层里直接预览——
  - 网页链接（`http(s)://`）走 iframe 弹层；站点拒绝内嵌（GitHub/Google 等）时用弹层上的「↗ 在浏览器打开」走系统浏览器。
  - 本地 / 远程文档（`.md` / `.markdown` / `.txt`）渲染成 markdown；本地相对路径基于工具工作目录解析，`~/path` 开头也能识别。
  - `mailto:` 走系统邮件客户端。
- **远程 markdown**：工具可配置 `mdUrl` 订阅远程帮助页 / 文档（只读），支持定时自动刷新与手动「重新读取」。文档来源优先用本地 `help.md`，配了 `mdUrl` 时作为补充。
- `⌘/Ctrl + 点击` 命令按钮可复制命令到剪贴板（不执行）。也可以用 ```` ```buttons copy ```` 围栏让整块按钮默认就是「仅复制」（见上文「命令按钮」节）。

### 配置版本控制
- 工具数据目录是本地 **git 仓库**：每次保存自动快照提交，每个工具都有独立的配置记录历史，可在「配置记录」弹窗里查看。

---

## 📥 下载与安装（普通用户）

> TermStep 目前仅支持 **macOS**（Intel + Apple Silicon 通用），应用**未做代码签名**，首次打开需多走一步解除 Gatekeeper 拦截。任选下面一种方式安装。

### 方式一：Homebrew（推荐）

```bash
# 1. 添加 tap 并信任（首次安装时需要）
brew tap sunknight/termstep
brew trust sunknight/termstep

# 2. 安装
brew install --cask termstep

# 3. 解除 Gatekeeper 拦截（应用未签名，首次必做一次）
xattr -cr /Applications/TermStep.app

# 4. 打开
open -a TermStep
```

之后升级只需：

```bash
brew upgrade --cask termstep
# 若升级后仍提示「已损坏」，再跑一次：xattr -cr /Applications/TermStep.app
```

### 方式二：直接下载 dmg

1. 前往 [Releases 页面](https://github.com/sunknight/termstep/releases)，下载最新版 `TermStep_<版本>_universal.dmg`。
2. 双击打开 dmg，把 **TermStep.app** 拖入 `/Applications`。
3. 解除 Gatekeeper 拦截（**首次打开前必做**，否则会提示「已损坏 / 无法验证开发者」）：
   ```bash
   xattr -cr /Applications/TermStep.app
   ```
4. 在启动台或 `/Applications` 双击 TermStep 打开。

> 也可以不执行命令：在 `/Applications` 里**右键**点 TermStep.app →「打开」→ 弹窗选「打开」，同样能放行。

### 关于「未签名」提示

TermStep 是个人开发、免费分发，暂未购买 Apple Developer ID 做签名公证，所以 macOS 会拦截它。这**不是应用损坏**，执行一次 `xattr -cr` 或右键打开即可永久放行，之后正常使用不会再提示。

---

## 🚀 安装与运行（开发者）

```bash
npm install        # 安装依赖
npm run dev        # 启动开发模式（Tauri dev：Vite dev server + Rust 窗口 + HMR）
```

其它命令：

| 命令 | 说明 |
|---|---|
| `npm run dev:web` | 仅 Vite 渲染端 dev server（无原生窗口，调 UI 时用） |
| `npm run typecheck` | TypeScript 类型检查（渲染端 + shared） |
| `npm run test` | 运行 vitest 单测（node 环境） |
| `npm run test:watch` | 单测监听模式 |
| `npm run build` | 生产构建（tauri build） |
| `npm run build:web` | 仅 Vite 构建 → `dist/`（被 tauri 消费） |
| `npm run icon` | 从 `assets/icon.png` 重新生成 `src-tauri/icons/`（改图标后必须） |
| `npm run version:set -- <x.y.z>` | 一键同步四处版本号（`package.json` / `Cargo.toml` / `tauri.conf.json` / `Cargo.lock`） |
| `npm run release` | 构建 universal dmg 并拷到 `release/` |

---

## 📦 打包须知

- 打包**默认未签名、仅主机架构**。分发给别人时，接收方会撞到 macOS Gatekeeper（「已损坏 / 无法验证开发者」），需右键→打开，或执行：
  ```bash
  xattr -cr "/Applications/TermStep.app"
  ```
- 要同时支持 Intel + Apple Silicon Mac，用 `npm run release`（构建 universal dmg）。
- 正式签名 + 公证需要 Apple Developer ID。
- PTY 是 Rust 原生实现（portable-pty），无需像 Node 原生模块那样 `rebuild`/`asarUnpack`——Tauri 打包会随应用一并编译。

---

## 🗂 工具数据格式

每个工具是 `~/.config/TermStep/configs/tools/<UUID>/` 下的一个目录：

**`tool.json`** —— 工具元数据：

```json
{
  "name": "Git",
  "icon": "🌿",
  "layout": "LR",
  "group": "版本控制",
  "cwd": "~/projects/myapp",
  "rootDir": "~/projects/myapp",
  "shell": "/bin/zsh",
  "env": { "RAILS_ENV": "development" },
  "tmux": "myapp",
  "initCommands": ["nvm use 20", "direnv allow"],
  "mdUrl": "",
  "useRemote": false,
  "autoUpdateMinutes": 0,
  "sourceId": "a1b2c3d4-5678-90ab-cdef-1234567890ab"
}
```

| 字段 | 说明 |
|---|---|
| `name` / `icon` | 侧边栏显示名 / emoji 图标 |
| `layout` | 布局方向：`"LR"`（文档左/终端右，默认）或 `"TB"`（文档上/终端下） |
| `terminalHidden` | 终端初始是否隐藏（可选；默认不隐藏）。运行时顶栏可随时 toggle，不写回配置 |
| `group` | 分组名（可选）；同分组工具在侧栏分区展示 |
| `cwd` | shell 启动目录（支持 `~`）；仅终端型工具使用 |
| `rootDir` | 工具根目录，供 `@/` 占位符引用（可选；未设时回退到 cwd 再到 `~`） |
| `shell` | shell 路径，默认 `$SHELL` 再退回 `/bin/zsh`；**以登录 shell `-l` 启动**（让打包后能读到 homebrew PATH） |
| `env` | 额外环境变量 |
| `tmux` | tmux 会话名；设置后以 `tmux new -A -s <name>` 启动 |
| `initCommands` | 启动时自动注入的命令 |
| `mdUrl` | 远程帮助 markdown 的 URL 或本地路径（扩展名限 `.md`/`.markdown`/`.txt`） |
| `useRemote` | 是否启用远程订阅模式（`true` 才读 `mdUrl`） |
| `autoUpdateMinutes` | 远程模式自动刷新间隔（分钟），本地文件用 0 |
| `sourceId` | 导入去重的稳定键（UUID）；同一 `sourceId` 的 bundle 重复导入会更新而非新建 |

**`help.md`** —— 帮助页 / 文档 markdown，其中 ```` ```buttons ```` / ```` ```buttons-json ```` 围栏渲染为命令按钮。

> 数据目录刻意按 productName（`TermStep`）派生，与更早的 Electron 时代路径一致，老用户零迁移。工具排序存在单独的 `configs/order.json`（不是每个 `tool.json` 里的 `order` 字段）。整个 `configs/` 是本地 git 仓库（配置版本控制）。

---

## 🏛 架构

**Tauri v2**（Rust 后端）+ **React 18 / TypeScript**（渲染端，WKWebView）+ **Vite**。

- **后端**（`src-tauri/src/`）：`lib.rs`（Builder / setup / State 注入 / 命令注册）、`commands.rs`（所有 `#[tauri::command]`，薄封装）、`pty.rs`（portable-pty 池，按 toolId 缓存，含 generation guard 解决重启竞态）、`tools.rs`（扫描 + 远程 markdown + SSRF/敏感路径守卫）、`tool_io.rs`（CRUD / 排序索引 / 迁移）、`watcher.rs`（notify 文件监听）、`vcs.rs`（配置版本控制，调系统 git）、`updater.rs`（版本清单检查）。
- **渲染端**（`src/renderer/`）：React 18。`App.tsx` 用统一的双面板布局——主区始终是「文档区 + 终端区」，`layout` 决定左右或上下排，`terminalHidden` 控制终端显隐（隐藏时 pty 保持活着）。
- **共享**（`src/shared/`）：`types.ts`（类型 + `IPC` 通道名常量，三端共用）、`buttonBlock.ts`（buttons 围栏解析与渲染）、`toolJson.ts`（与后端对偶的合并逻辑）、`bundle.ts`（导入/导出 bundle）、`dangerous.ts`（危险命令检测）等。

**IPC 契约**：`shared/types.ts` 定义一个含全部通道名的 `IPC` 常量对象，三端共用。新增一个 IPC 调用 = 加通道常量 → 在后端加 `#[tauri::command]`（命令名 = 通道名把 `:` → `_`）→ 在 `lib.rs` `generate_handler!` 注册 → 在渲染端 `lib/api.ts` 加方法。

---

## 🛠 技术栈

Tauri v2（Rust）· React 18 · TypeScript · portable-pty · xterm.js · markdown-it · notify · Vite · vitest
