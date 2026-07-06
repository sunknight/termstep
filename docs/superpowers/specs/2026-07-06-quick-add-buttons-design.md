# 快速添加命令：「+」按钮（本地模式，append）

## 背景

`TermStep` 的每个工具有一份本地 `help.md`，其 ` ```buttons ` 围栏渲染成一键命令按钮。当前加按钮的唯一入口是「编辑」打开整页编辑器 —— 对「只想把刚跑过 / 复制到的一条命令先记下来，日后再整理」的场景太重。

远程模式（`meta.useRemote`）下 help 是只读的拉取内容，不适用本地追加。本功能只在**本地模式**（`!meta.useRemote`）出现。

## 目标 / 非目标

**目标**

- 本地模式的 help 工具栏，「编辑」旁新增一个 `+` 按钮，点开一个轻量表单。
- 表单自动预填系统剪贴板内容并全选；可改可手输；**每行一条命令**。
- 提交后在 `help.md` **末尾追加一个新的 ` ```buttons ` 围栏**（不合并进已有块），包裹输入内容；UI 由现有 chokidar 机制自动刷新。
- 不触碰 `tool.json`（meta 不变）。

**非目标（YAGNI）**

- 不在表单里设 label / 参数 / edit 模式 —— 后续在编辑器里整理。
- 不合并进已存在的尾部围栏 —— 每次追加独立成块，便于事后整理。
- 不在远程模式下出现 —— 远程 help 只读。

## 方案选型

追加落点在 main 进程（读盘 → 规范化 → 写回），渲染端只发 `(toolId, body)`：

- **采用：新增 `tool:appendButtons` IPC**。main 读 help.md 现值、调纯函数 `buildButtonsAppend`、写回；不动 tool.json。原子、无脏读、无 meta 风险，符合现有 IPC contract 模式。
- 否决「复用 TOOL_SAVE 传全文 + `{}` meta」：渲染端 read-modify-write 与磁盘有竞争，且"追加"意图含糊。
- 否决「main 直接 `fs.appendFile` 不读」：无法规范尾部换行，围栏可能粘在原内容同一行末尾。

## 改动点

### 1. 纯函数 `buildButtonsAppend(currentMd, body)`（`src/shared/buttonBlock.ts`）

```
trimmedMd = currentMd 去掉尾部空白
trimmedBody = body.trim()
if trimmedBody === '' → 返回 currentMd（无内容可追加，原样返回）
否则 → trimmedMd + "\n\n```buttons\n" + trimmedBody + "\n```\n"
```

放 shared 以便单测（符合「pure logic in src/shared」的测试边界）；main handler 调它保持轻薄。

### 2. IPC `tool:appendButtons`

- `src/shared/types.ts`：`IPC.TOOL_APPEND_BUTTONS = 'tool:appendButtons'`。
- `src/preload/index.ts`：`tool.appendButtons(toolId, body) => invoke(IPC.TOOL_APPEND_BUTTONS, toolId, body)`。
- `src/main/ipc.ts`：
  ```
  读 toolsDir/<id>/help.md（缺失视为 ''）
  next = buildButtonsAppend(cur, body)
  若 next !== cur 才写回（避免空 body 触发无谓写盘 + 扫描）
  不写 tool.json
  ```
  chokidar 捕获 change → 广播 `tools:changed` → UI 自动出现新按钮块。

### 3. 触发按钮（`src/renderer/App.tsx`）

`help-toolbar` 中「编辑」**左侧**加：

```tsx
{!active.meta.useRemote && (
  <button title="快速添加命令（追加到末尾）" onClick={() => setQuickAddOpen(true)}>+</button>
)}
```

- 仅本地模式渲染；工具栏本就只在非 floating、非编辑态显示，继承即可。
- App 增加 `const [quickAddOpen, setQuickAddOpen] = useState(false)`；modal 在**应用根渲染一次**（不进 `renderHelp`，避免 docked / peek 双份）。

### 4. Modal 组件 — 新文件 `src/renderer/components/QuickAddModal.tsx`

镜像 `ParamPromptModal`（overlay + `.modal` + autofocus + Esc）：

- props：`{ toolId: string; onSubmit: (body: string) => Promise<void>; onClose: () => void }`。
- 一个 `<textarea>`，挂载时 `window.api.clipboard.readText()` 预填（非空才填），随即 `focus()` + `select()`（全选：打字即覆盖；剪贴板空时正常聚焦）。
- **⌘Enter 提交**（textarea 中 Enter 保留为换行，支持多行）；**Esc 取消**。
- 「添加」primary 按钮：body 为空 / 纯空白时 disabled。
- 提示文字：「每行一条命令，将作为新的 buttons 块追加到文档末尾。」
- 提交调 `onSubmit(body)`；App 内 `appendButtons` 成功后 `onClose()`，失败在 modal 内显示 error（同 `EditorPane` 风格，不关闭）。

## 数据流

1. 本地模式点 `+` → `setQuickAddOpen(true)`。
2. modal 预填剪贴板 + 全选。
3. 用户（可选地修改）→ ⌘Enter 或点「添加」。
4. App 调 `window.api.tool.appendButtons(toolId, body)`。
5. main 读 help.md → `buildButtonsAppend` → 写回（不动 tool.json）。
6. chokidar → `tools:changed` → help 底部出现新按钮块；modal 关闭。

## 边界与错误

- body 空 / 纯空白：禁用「添加」，不发 IPC；`buildButtonsAppend` 也原样返回、handler 不写盘。
- body 内含 ` ``` `：会让围栏提前闭合，剩余内容泄漏为普通 markdown（已知小限制；「快速添加命令」场景极少触发，后续如需兜底再转义）。
- help.md 不存在：视为空串正常追加（等价于首次写入）。
- 写盘失败：modal 内显 error，不关闭，可重试。

## 测试

- `buildButtonsAppend` 纯函数单测（`tests/buttonBlock.test.ts`，vitest node env）：
  - 空 body → 返回原 `currentMd` 不变；
  - 正常追加 → 末尾为 `\n\n```buttons\n<body>\n```\n`；
  - `currentMd` 尾部多换行 → 归一为单个空行分隔；
  - 对空文档首次追加 → 头部无多余空行。
- 端到端（GUI + 文件系统 + 剪贴板）无法在 vitest 内覆盖，手动 `npm run dev`：本地模式点 `+` → 预填剪贴板 → ⌘Enter → help 底部出现新按钮块；远程模式无 `+`；空 body 时「添加」禁用。

## 风险

- **围栏提前闭合**：body 含 ` ``` ` 时解析错位。已记为已知限制，当前不处理。
- **预填意外**：剪贴板里是与命令无关的内容时会被预填。靠挂载即全选缓解（一眼可见，打字即覆盖）；不做内容启发式判断。
