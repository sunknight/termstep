# cmd_gui 设计文档

> 本地 macOS 应用：用界面菜单/按钮驱动一堆命令行命令，免去手敲。
> 状态：设计已审定（2026-06-30）。下一步：writing-plans 出实现计划。

## 1. 概述

用户有大量命令行命令（git / docker / k8s 等），不想手动敲。本应用提供一个图形界面：左侧菜单选择"工具"，每个工具界面包含一个真实交互式终端和一份 Markdown 帮助文档，帮助文档里内嵌快捷按钮，点击即可把命令送入终端执行。

### 核心诉求
- 点按钮 → 命令进入终端执行，免去手敲。
- 每个工具有独立终端，互不影响；切换工具不清空已打开的工具。
- 帮助文档支持 Markdown；按钮内嵌其中。
- App 内可直接管理（增删改）工具和帮助文档。

### 非目标（v1 明确不做）
- 跨设备/云端：纯本地。
- 会话持久化（tmux 可重连）：退出即清空。
- 命令参数占位符（`{{input}}`）：用 `?edit` 应付；不够再加。
- 工具导入/分享：只信本地手写工具。
- 跨平台：仅 macOS。

## 2. 关键决策（决策日志）

| 议题 | 决策 | 理由 |
|---|---|---|
| 终端模型 | 真实交互式 PTY（node-pty + xterm.js），每工具一个，运行期内常驻 | 要保留 shell 状态、支持交互程序 |
| 布局 | 菜单（最左）→ 终端（左）→ 帮助（右） | 用户审定 |
| 技术栈 | Electron + electron-vite + React | 终端是核心，xterm.js+node-pty 最成熟；本地应用不计体积 |
| 按钮点击默认行为 | 即运行（`term.paste` + `\r`），盲注入 | 便捷优先；真终端无法可靠判断 shell 空闲，接受此副作用 |
| 按钮语法 | 标准 Markdown 链接 `[标签](cmd:命令)` + `?edit` 后缀 | 零学习成本、随处可写；放弃自造方言 |
| 会话生命周期 | 退出即清空（不挂 tmux） | YAGNI；切换不清空只在运行期内成立 |
| 配置字段 | v1 保留 `name`/`icon`/`order`/`cwd`；`shell`/`env` 仅解析、不进编辑器 | YAGNI 预留 |
| 信任边界 | 只信任本地手写工具 | 无导入即无外部木马风险 |

## 3. 架构

### 3.1 技术栈
- **Electron + electron-vite + React**（主进程 + 渲染进程）
- 终端：`xterm.js`（渲染 + `FitAddon`/`WebLinksAddon` 等）+ `node-pty`（主进程拉起 shell）
- Markdown：`markdown-it`（含自定义 `cmd:` 链接渲染器）
- 编辑器：`CodeMirror 6`
- 文件监听：`chokidar`
- 打包：`electron-builder`

### 3.2 主进程（main）
- **`ToolManager`**
  - 扫描 `tools/`，逐个解析 `tool.json`（元数据 + 默认值 + 校验）与 `help.md`。
  - 用 chokidar 监听 `tools/`，变化时重新扫描并通过 IPC `tools:changed` 推送给渲染进程。
- **`PtyService`**
  - 按工具懒启动 PTY：首次打开某工具才 spawn（启动时不开）。
  - 接口：`write(toolId, data)` / `resize(toolId, cols, rows)` / `kill(toolId)`。
  - PTY 输出按 `toolId` 打标签，经 IPC `pty:data` 流给渲染进程。
  - 运行期内不因切换工具而 kill；仅在 App 退出时杀全部（退出即清空）。

### 3.3 渲染进程（renderer）
- **`Sidebar`**（菜单）：工具列表（图标 + 名称）+「+ 新建工具」+ 每个工具的 编辑 / 删除 / 上移 / 下移。当前工具高亮。
- **`TerminalPane`**：所有已打开工具的 xterm 实例**常驻 DOM、靠显隐切换**（不卸载）→ 输出与滚动历史天然保留；切换显示时重新 fit 尺寸。
- **`HelpPane`**：渲染当前工具 Markdown；`cmd:` 链接渲染成按钮；右上「编辑」按钮进入编辑模式。
- **`EditorPane`**（编辑模式）：CodeMirror Markdown 编辑器（编辑/预览切换）+ 元数据小表单（名称/图标/cwd/排序）。保存 = 写回 `tool.json`+`help.md` → ToolManager 热重载 → HelpPane 即时刷新。

### 3.4 IPC 通道
| 通道 | 方向 | 载荷 |
|---|---|---|
| `tools:list` | main→renderer | 工具列表（含解析后的元数据与 Markdown） |
| `tools:changed` | main→renderer 事件 | 重扫后的工具列表 |
| `pty:data` | main→renderer 事件 | `{ toolId, data }` |
| `pty:write` | renderer→main | `{ toolId, data }` |
| `pty:resize` | renderer→main | `{ toolId, cols, rows }` |
| `pty:kill` | renderer→main | `{ toolId }` |
| `tool:save` | renderer→main | `{ toolId, markdown, metadata }` → 写文件 |
| `tool:create` / `tool:delete` / `tool:reorder` | renderer→main | 增删改工具目录 |

## 4. 配置格式（文件为唯一真相源）

```
cmd_gui/
├── package.json
├── src/                 # 应用代码（main / renderer）
└── tools/               # 用户维护；每个子文件夹 = 一个菜单工具（文件夹名即工具 id，如 "git"）
    ├── git/
    │   ├── tool.json
    │   └── help.md
    ├── docker/
    │   ├── tool.json
    │   └── help.md
    └── k8s/…
```

### `tool.json`（字段均可省略，用默认值）
```json
{
  "name": "Git",
  "icon": "🌿",
  "cwd": "~/repos",      // 默认 ~
  "order": 1,            // 菜单排序
  "shell": "/bin/zsh",   // v1 仅解析、不进编辑器；默认用户登录 shell
  "env": {}              // v1 仅解析、不进编辑器；默认继承
}
```

### `help.md` 的按钮语法（`cmd:` 链接）
标准 Markdown 链接，`href` 以 `cmd:` 开头即渲染为按钮；末尾 `?edit` 表示"只填入不回车"。
````markdown
# Git 常用命令

点击按钮直接在终端运行：

- 查看状态：[git status](cmd:git status)
- 最近提交：[git log --oneline -20](cmd:git log --oneline -20)
- 提交（只填入，自己补消息再回车）：[commit](cmd:git commit -m ""?edit)
- 推送：[git push](cmd:git push)

命令里可含空格、引号；交互式程序（vim/less 等）请在 shell 空闲时再点。

> 限制：命令内不能含未转义的 `)`（会截断 Markdown 链接）；需要时用全角括号或 `&#41;`。
````

## 5. 关键行为

### 5.1 点按钮（盲注入的安全解法）
1. `HelpPane` 解析 `cmd:` 链接 → 得到命令文本与 `edit` 标志。
2. 调 `term.paste(命令)`（**非裸 `pty.write`**）：xterm.js 会按当前 shell 是否开启 bracketed-paste 自动决定是否包裹转义序列——现代 zsh/bash 开了就当"粘贴"安全插入，没开就当普通打字。
3. 非 edit 模式补一个 `\r`（回车）→ 执行；`?edit` 不补，命令停在行上供编辑。
4. 焦点回到终端。

> 已知不可根治的副作用：shell 正忙（跑命令中 / 停在 vi/less/sudo 等交互程序）时点按钮，字节会喂给那个程序而非 shell。这是真实终端的本质，所有 snippet 工具皆然，用户已接受。

### 5.2 切工具
仅切换 xterm 实例的显隐；PTY 进程不停、xterm 不卸载 → 满足"切换不清空"。后台工具若还在跑命令，输出继续累积，切回可见。

### 5.3 配置热重载
文件是唯一真相源；App 内编辑器只是写文件的 UI。
- 改 `help.md` → 仅刷新帮助，**不动终端**（避免误杀运行中的活）。
- 改 `cwd`/`shell` → 也不自动重启 PTY；提供「重启终端」按钮手动触发。

### 5.4 新建/删除/排序工具
编辑器「新建」→ 写入新 `tools/<id>/`（默认 `tool.json`+`help.md`）→ chokidar 捕获 → 菜单出现。删除即删目录；排序写回各 `tool.json` 的 `order`。

## 6. 错误处理
- `tool.json` 解析失败 → 跳过该工具，UI 报错，不崩。
- PTY 启动失败（shell 路径错等）→ 终端区显示错误信息。
- 缺 `help.md` → 帮助区显示"无帮助文档"。
- 编辑器保存失败 → toast 提示且不丢编辑器内容。

## 7. 打包与运行
- 开发：`electron-vite dev`。
- 打包：`electron-builder` 出 macOS `.app` / `.dmg`，本地使用、不做公证。

## 8. 测试策略
- **纯逻辑单元测试（TDD）**：
  - `cmd:` 链接解析器（markdown-it 插件）：给定 Markdown，正确提取命令与 `?edit` 标志。
  - 工具配置加载器：解析 `tool.json`、填默认值、校验非法值。
  - 按钮命令构造：`命令 + (\r | "")`。
- **终端/UI（集成）**：本质难单测；用人工验证清单 + 轻量冒烟（spawn `echo`，断言输出回流）。

## 9. 未来可扩展（v1 不做）
- tmux 后端：跨重启保活、普通终端可 `tmux attach` 接回。
- 命令参数占位符：`{{input:提示}}` 弹框填参。
- 工具包导入/分享（需引入信任/校验机制）。
- 每工具 shell/env 的编辑器 UI。
