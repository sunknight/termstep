# 仅文档型工具（Document-only Tools）

## 背景

TermStep 现有模型是「每个工具 = 一个持久终端 + 一份 markdown 帮助页 + 按钮命令」。这套模型服务于会用 CLI 的用户——把命令变成可点击按钮。

实际用户中有一部分是**产品 / 运营角色**，他们：

- 几乎不用终端，打开 app 看到终端反而困惑；
- 真正需要的是「项目文档与流程信息的统一入口」——查看 PRD、SOP、操作手册、外部系统链接。

并且当前右栏按钮**只能向终端输入**（`HelpPane.tsx` → `runCommandChecked` → `termRegistry.runCommand` → `pty_write`），没有终端的产品/运营场景下，按钮对他们没有意义。

## 目标

让 TermStep 也能作为「文档与信息入口」使用：除现有「终端型」工具外，新增**「仅文档型」工具**——只渲染一份 markdown 文档，不创建终端，按钮点击无动作（保留 ⌘/Ctrl+点击复制命令）。

## 核心决定

1. **工具分两种类型**：`tool.json` 加一个可选 `type` 字段，值为 `"terminal"`（默认，向后兼容）或 `"document"`。
2. **仅文档型工具的布局**：取消中/右两栏划分，**整个右侧（原中栏 + 右栏的位置）合并为一个文档区**，渲染该工具的 markdown 文档；左栏侧栏不变。
3. **不创建终端**：仅文档型工具不 spawn PTY、不创建 xterm 实例。
4. **按钮在文档里仍可渲染**（`buttons` / `buttons-json` 围栏照常解析），但**点击无动作**；唯一保留的行为是 ⌘/Ctrl + 点击复制命令（现有 `copyOnModifier`）。
5. **链接、预览、modal 等现有功能完全不变**：文档里的链接点击仍走现有 `PreviewOverlay`，对外部 http/https 仍走 `api.shell.openExternal`。
6. **编辑器加「模式」选项**：编辑工具时新增一个单选——**终端 / 仅文档**，写回 `tool.json` 的 `type` 字段。

## 文档来源

仅文档型工具在中+右栏渲染的内容来源：

- **优先用本地 `help.md`**（即现有工具目录里的那份，可编辑）。
- **可选 `mdUrl`**：如果 `tool.json` 配了 `mdUrl`（本地 `.md`/`.markdown`/`.txt` 或远程 URL），按现有 `fetch_remote_markdown` 拉取，作为主体内容渲染；现有的扩展名白名单、SSRF 守卫、敏感路径守卫全部复用。
- 两者都存在时 **help.md 优先**（与现有渲染逻辑一致——右栏 help.md 也是优先本地、mdUrl 作为远程订阅补充）。

## 设计细节

### 工具类型字段

- `tool.json` 新增 `type` 字段，类型 `"terminal" | "document"`，**可选**。
- 不写或值为 `"terminal"` → 终端型，完全保持现状。
- 值为 `"document"` → 仅文档型，按下文规则渲染。
- **零迁移**：所有现有 `tool.json` 没有 `type` 字段，默认 terminal；`scan_tools` 解析时缺失即视为 `"terminal"`。

### 布局分发

`App.tsx` 的布局按 `activeTool.meta.type` 分发：

- **terminal 型**（默认）：维持现有三栏——侧栏 / 终端中栏 / 帮助右栏，所有现有逻辑、折叠、Peek 完全不变。
- **document 型**：
  - 不渲染 `.terminal-area`（中栏终端容器）；
  - 不渲染右侧 `.help-pane`（独立右栏）；
  - 在原「中栏 + 右栏」位置渲染一个新的 `<DocumentPane>`，占满右侧空间；
  - 左栏侧栏不变，工具切换逻辑不变。

### `<DocumentPane>` 组件

- 位置：`src/renderer/components/DocumentPane.tsx`（新文件）。
- 渲染：复用 `src/renderer/lib/markdown.ts` 的 `renderMarkdown`，结构与 `<HelpPane>` 的 markdown 渲染基本一致——TOC、长内容分节折叠等都可复用。
- **链接处理**：与 `<HelpPane>` 完全一致——`.cmd-link`（带 `data-href`）走现有 `PreviewOverlay`（本地 `.md`/`.markdown`/`.txt`、远程 URL 都复用现有逻辑），http/https/mailto 走 `api.shell.openExternal`。
- **按钮处理**：
  - `buttons` / `buttons-json` 围栏**照常解析并渲染为 `.cmd-btn`**（视觉一致，让作者可以「展示命令样例」）；
  - 点击事件：**不做任何动作**（不调 `runCommand`、不开表单）；
  - **保留** ⌘/Ctrl + 点击复制命令到剪贴板（复用 `copyOnModifier`）。
- **宽度**：可继承现有 HelpPane 的可拖拽宽度逻辑，或直接撑满文档区——本 spec 选取**撑满文档区**（产品/运营场景以阅读为主，全宽更舒适）。

### PTY 与懒加载

- `pty.rs` 的 `ensure` 在 document 型工具上 **skip**（不 spawn）。
- `TerminalPane` / `TerminalView` 不为 document 型工具挂载（懒创建逻辑天然不会触发，因为中栏根本不渲染）。
- 切换工具从 document → terminal 时，terminal 型工具按现有逻辑首次激活懒创建 PTY，不受影响。
- `pty_cwd`（实时 cwd 查询）在 document 型工具激活时不应报错——后端找不到 entry 时已返回兜底 meta.cwd / home（现有行为），前端顶栏 cwd 在 document 型工具上可隐藏或显示工具名。

### 编辑器「模式」选项

- 在 `EditorPane` / `EditorModal` 的「基本」分组里，新增一个**单选**字段「**模式**」：
  - 选项：**终端** / **仅文档**。
  - 默认值：终端（与不写 `type` 字段一致）。
  - 写回 `tool.json` 的 `type` 字段（`"terminal"` / `"document"`）。
- 切换模式时不立即销毁/创建 PTY——保存后下次激活该工具时按新类型分发（终端型首次激活懒创建，document 型不再使用现有 PTY 实例；旧 PTY 实例可由现有 unmount/dispose 路径清理）。

### 类型与对偶

- `src/shared/types.ts` 的 `ToolMeta` / `Tool` 加 `type?: "terminal" | "document"`（可选）。
- `src-tauri/src/types.rs` 的对偶 `ToolMeta` / `Tool` 加同样字段，serde 用 `#[serde(default)]` 保证旧文件可解析。
- `src-tauri/src/pure.rs` 的 `parse_tool_meta` / `merge_tool_json` 处理新字段（向后兼容：缺省视为 terminal）。
- `scan_tool_risk` 不涉及（document 型无 shell / initCommands / mdUrl 之外的新风险面）。

## 安全

- **不引入任何新的对外能力**：本 spec 不新增 open-url / form / http / clipboard / accessibility 等任何新动作。所有按钮在 document 型工具上都是「无动作」或「⌘+点击复制命令」。
- **链接与远程文档**完全复用现有守卫：
  - 远程 mdUrl 复用 `is_internal_host` / SSRF 守卫 / 禁重定向 / 2 MiB 上限 / 8s 超时 / 浏览器 UA；
  - 本地 mdUrl 复用扩展名白名单（`.md`/`.markdown`/`.txt`）与 `sensitive_path_reason`；
  - 链接预览复用现有 `PreviewOverlay` 的所有检查。
- **`isDangerousCommand`** 在 document 型工具上不会触发，因为按钮根本不执行。

## 不变范围

- 所有现有 terminal 型工具的行为、UI、IPC、PTY 生命周期**完全不变**。
- 左栏侧栏（工具列表、分组、拖拽排序、导入/导出、新建/删除）**完全不变**。
- `PreviewOverlay`、`QuickCommands`、`ConfigRecords`、`ParamPromptModal`、`HelpModal`、`QuickAddModal` 等**完全不变**。
- 现有 buttons / buttons-json 的解析、渲染、参数表单逻辑**完全不变**——document 型只是不绑定 click handler。
- 配置版本控制（vcs.rs）、迁移链（tool_io.rs）**完全不变**（`type` 是可选字段，旧 `tool.json` 不需要迁移）。

## 明确不做（划线）

1. **系统级 input-to-focus**（accessibility / AppleScript 注入任意 app）——独立 spec 调研。
2. **中栏 tab 系统**（与 `2026-07-17-embedded-browser-tabs-design.md` 合并到后续 spec）。
3. **新按钮动作**（open-url / form / http / clipboard action 等）——本 spec 不引入；document 型按钮仅「无动作 + ⌘复制」。
4. **iframe 网页视图**——本 spec 不做；网页打开仍走现有 `PreviewOverlay` modal 或系统浏览器。
5. **document 型工具的新建向导/模板**——本 spec 只在编辑器里加「模式」单选；新建流程不变（默认 terminal，用户可在编辑器切到 document）。
6. **HTTP / 表单 / 复制等新动作的链式调用**——YAGNI。

## 实施影响

### 新文件

- `src/renderer/components/DocumentPane.tsx`——文档视图组件（复用 `markdown.ts`，结构与 `<HelpPane>` 渲染一致，按钮无 click handler）。

### 改动文件

- `src/renderer/App.tsx`——按 `activeTool.meta.type` 分发布局：terminal 型走原三栏；document 型渲染 `<DocumentPane>` 占据中+右栏位置，不渲染终端与右栏。
- `src/renderer/components/EditorPane.tsx`（或 `EditorModal.tsx`， whichever 当前生效）——「基本」分组加「模式」单选，绑定 `type` 字段。
- `src/renderer/components/HelpPane.tsx`——无需改动（仅 terminal 型工具渲染右栏 help 时使用）。
- `src/shared/types.ts`——`ToolMeta` 加 `type?` 字段。
- `src/shared/toolJson.ts` / `toolConfig.ts`——`mergeToolJson` / `parseToolMeta` 处理 `type` 字段（向后兼容）。
- `src-tauri/src/types.rs`——对偶 `ToolMeta` 加 `#[serde(default)] type` 字段。
- `src-tauri/src/pure.rs`——`parse_tool_meta` / `merge_tool_json` 对偶处理。
- `src-tauri/src/pty.rs`——document 型工具 `ensure` 时 skip（实际上由于前端不渲染终端容器，懒创建根本不会触发；这里加防御性 skip 仅为兜底）。
- `styles.css`——`.document-pane` 样式（全宽文档区、可读行宽上限等）。

### 零迁移

- 默认值 `terminal` 保证所有现有 `tool.json` 不变。
- 新字段完全 opt-in，不需要任何 `tool_io.rs` 迁移。

### 测试

- `tests/`（vitest）：
  - `buttonBlock` 解析在 document 型工具下仍正确（无回归）；
  - `parseToolMeta` / `mergeToolJson` 处理 `type` 字段（缺省 → terminal，显式 document → document）。
- Rust：`cargo test` 覆盖 `parse_tool_meta` / `merge_tool_json` 的对偶行为。

## 验收标准

1. 编辑工具时可在「基本」分组看到「模式」单选（终端 / 仅文档），切换并保存后 `tool.json` 的 `type` 字段正确写入。
2. document 型工具激活时：左栏侧栏不变；中+右栏合并为一个全宽文档区，渲染 help.md（若配了 mdUrl 则渲染 mdUrl 内容）。
3. document 型工具不创建 xterm 实例、不 spawn PTY（活动监视器里看不到对应 shell 进程）。
4. document 型工具文档里的链接点击行为与现有 HelpPane 完全一致（modal 预览 / 系统浏览器）。
5. document 型工具文档里的 `buttons` / `buttons-json` 按钮可见但点击无动作；⌘/Ctrl + 点击复制命令到剪贴板（toast 提示）。
6. 在 terminal 型与 document 型工具之间切换时，布局正确分发，无残留终端实例或异常报错。
7. 所有现有 terminal 型工具的行为、UI、IPC 完全不变；现有按钮、参数表单、危险命令守卫等无回归。
8. 类型检查（`npm run typecheck`）、单测（`npm run test`）、Rust 测试（`cargo test --manifest-path src-tauri/Cargo.toml`）全部通过。

## 后续可探索（不在本范围）

- document 型工具的新建向导与模板（一键创建 PRD/SOP 工具）。
- 中栏 tab 系统（与 embedded-browser-tabs 设计合并：一个工具同时挂终端 tab + 文档 tab + 网页 tab）。
- 系统级 input-to-focus（accessibility 注入）的独立调研。
- document 型工具专属的「目录大纲侧边栏」「全文搜索」「文档内章节跳转」等阅读增强。
