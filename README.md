# gui_anything

> 把任意 CLI 命令变成可点击的菜单按钮 —— 一个本地 macOS Electron 应用。

为每个「工具」分配一个**持久终端**和一个 **markdown 帮助页**；帮助页里的 ```` ```buttons ```` 代码块会渲染成一键执行的命令按钮。终端基于 node-pty + xterm.js，跑的是真实 shell。

---

## ✨ 特色

- **命令即按钮**：在 markdown 里写一行命令，就得到一个可点击按钮。复杂带参数的命令用 JSON 描述，点击后弹出参数表单，填完安全转义后执行。
- **每个工具一个持久终端**：基于 node-pty 的真实 shell（zsh/bash），在真实 xterm.js 终端里运行；切换工具只切换可见性，终端进程常驻、历史不丢。
- **工具就是磁盘上的数据**：每个工具是一个目录（`tool.json` + `help.md`），不是代码。整个 UI 从扫描这些目录派生而来，可用任意编辑器改，也可在应用内编辑。
- **磁盘改动自动刷新**：chokidar 监视工具目录，新建 / 编辑 / 删除 / 重排工具后 UI 自动更新，无需手动刷新状态。
- **零配置即可用**：首次启动自动生成一个示例 Git 工具。
- **纯本地、无后端**：所有数据在本机 `userData/tools` 下；不联网、不上传。

---

## 🧩 主要功能

### 工具管理
- 侧边栏**新建 / 删除 / 拖拽排序**工具。
- 应用内编辑器修改工具元数据（名称、图标、工作目录、shell、环境变量、tmux 会话、启动命令）和帮助 markdown。
- **导入 / 导出**工具（JSON bundle），可单个导出或全部导出，方便备份与分享。

### 终端
- 每个工具有独立、**懒加载且持久**的 xterm 终端：首次打开才创建，之后跨工具切换保持存活。
- 顶栏实时显示当前 shell 的工作目录（解析自 OS pid，跟随你的 `cd`）。
- 「↻ 重启终端」按钮：shell 退出或卡住时一键拉起新 shell。
- 支持 **tmux 会话**：配置会话名后，shell 以 `tmux new -A -s <name>` 启动（已存在则 attach）。
- 支持 **initCommands**：工具打开时自动注入的启动命令。
- 打开新工具时提示符立即可见（已处理 xterm v5 首帧渲染时序）。

### 命令按钮（核心特色）

帮助 markdown 里用围栏块定义按钮：

**简单按钮** —— ```` ```buttons ```` 围栏，每行一个，语法 `命令 [# 标签] [// edit]`：

````markdown
```buttons
git status # 查看状态
git log --oneline -20
git commit -m "" // edit
git push # 推送
```
````

- `命令` 是要执行的字面命令。
- ` # 标签`（空格-井号-空格）覆盖按钮显示文字。
- ` // edit` 后缀表示「粘贴不回车」（编辑模式：贴进终端后不自动按回车，方便你改完再执行）。

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

### 全局快捷命令
- 顶部 ⚡「快捷命令」下拉：一份独立 markdown 里的按钮，在整个应用范围可用，点击后在**当前激活工具**的终端里执行。同样支持参数化按钮。

### 帮助页
- markdown 渲染（基于 markdown-it）；http(s) / mailto 链接在系统浏览器打开。
- **远程 markdown**：工具可配置 `mdUrl` 订阅远程帮助页（只读），支持定时自动刷新与手动「重新读取」。

---

## 🚀 安装与运行

```bash
npm install        # 安装依赖（postinstall 会给 node-pty 的 spawn-helper 加可执行权限）
npm run dev        # 启动开发模式（electron-vite dev，带 HMR）
```

其它命令：

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查（main/preload/shared + renderer 两份 tsconfig） |
| `npm run test` | 运行 vitest 单测（node 环境） |
| `npm run test:watch` | 单测监听模式 |
| `npm run build` | 生产构建 → `out/{main,preload,renderer}` |
| `npm run rebuild` | 为 Electron 重建 node-pty 原生模块 + chmod spawn-helper |
| `npm run package` | 构建 + 打包 → `release/*.dmg`（未签名，仅当前架构） |

---

## 📦 打包须知

- 打包**默认未签名、仅主机架构**。分发给别人时，接收方会撞到 macOS Gatekeeper（「已损坏 / 无法验证开发者」），需右键→打开，或执行：
  ```bash
  xattr -cr "/Applications/gui_anything.app"
  ```
- 要支持 Intel Mac，把 `electron-builder.yml` 里 `mac.target` 的 arch 改为 `[arm64, x64]`（或 `universal`）。
- 正式签名 + 公证需要 Apple Developer ID。
- node-pty 是原生模块：打包前务必 `npm run rebuild`，并保持 `asarUnpack: '**/node-pty/**'`，否则打包后 shell 静默启动失败。

---

## 🗂 工具数据格式

每个工具是 `userData/tools/<id>/` 下的一个目录：

**`tool.json`** —— 工具元数据：

```json
{
  "name": "Git",
  "icon": "🌿",
  "order": 0,
  "cwd": "~/projects/myapp",
  "shell": "/bin/zsh",
  "env": { "RAILS_ENV": "development" },
  "tmux": "myapp",
  "initCommands": ["nvm use 20", "direnv allow"]
}
```

| 字段 | 说明 |
|---|---|
| `name` / `icon` / `order` | 侧边栏显示名 / emoji 图标 / 排序 |
| `cwd` | shell 启动目录（支持 `~`） |
| `shell` | shell 路径，默认 `$SHELL` 再退回 `/bin/zsh` |
| `env` | 额外环境变量 |
| `tmux` | tmux 会话名；设置后以 `tmux new -A -s <name>` 启动 |
| `initCommands` | 启动时自动注入的命令 |
| `mdUrl` | 远程帮助 markdown 的 URL（设置后可启用远程只读帮助） |

**`help.md`** —— 帮助页 markdown，其中 ```` ```buttons ```` / ```` ```buttons-json ```` 围栏渲染为命令按钮。

> 数据目录随应用名派生。应用曾改名（`cmd_gui` / `cmd-gui` → `gui_anything`）；`index.ts` 会一次性把旧名下的工具迁移过来，改名不会丢数据。若再次改名，扩展那个迁移列表即可。

---

## 🏛 架构

三个 Electron 进程，全 TypeScript，由 electron-vite 串联：

- **main**（`src/main/`）：`index.ts`（生命周期 / 窗口 / 服务装配）、`ptyService.ts`（按 toolId 缓存的 node-pty 池）、`toolManager.ts`（chokidar 监视）、`toolsScanner.ts`（扫描工具目录）、`ipc.ts`（ipcMain 处理器）、`seed.ts`（首次运行示例工具）。
- **preload**（`src/preload/`）：通过 contextBridge 暴露类型化的 `window.api`（contextIsolation 开、nodeIntegration 关）。这个 `api` 对象的形状**就是** IPC 契约。
- **renderer**（`src/renderer/`）：React 18。`App.tsx` 是三栏布局（侧边栏 / 终端 / 帮助或编辑器）。
- **shared**（`src/shared/`）：`types.ts`（类型 + `IPC` 通道名常量）、`buttonBlock.ts`（buttons 围栏解析与渲染）、`toolConfig.ts`、`buttonBlock` 等。

**IPC 契约**：`shared/types.ts` 定义一个含全部通道名的 `IPC` 常量对象，三端共用。新增一个 IPC 调用 = 加通道常量 → 在 `ipc.ts` 加 `ipcMain.handle` → 在 preload `window.api` 加方法。

---

## 🛠 技术栈

Electron · React 18 · TypeScript · node-pty · xterm.js v5 · markdown-it · chokidar · electron-vite · vitest
