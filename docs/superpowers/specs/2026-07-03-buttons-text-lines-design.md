# buttons：`//` 文本行（文本与按钮交织）

## 背景

`TermStep` 的 help.md 用 ` ```buttons ` 围栏块把命令渲染成一键按钮。行格式定义在 `src/shared/buttonBlock.ts`：每行一个按钮，语法 `命令 [# 标签] [// edit]`。两个消费者复用同一份解析（`parseButtonLine`）：

- **HelpPane**（`src/renderer/components/HelpPane.tsx`）：markdown-it 把围栏渲染成 `<button class="cmd-btn">`，点击靠事件委托读 `data-cmd` / `data-edit`。
- **QuickCommands**（`src/renderer/components/QuickCommands.tsx`）：全局快捷命令下拉，用 `parseButtonsFromMarkdown` 复用同一解析，按文档顺序收集所有按钮。

现需在按钮列表中插入「普通文本行」，实现文本与按钮的垂直交织（如给一组按钮加小标题 / 说明）。文本行不能被点击、不能进快捷命令下拉。

## 目标 / 非目标

**目标**

- 在 ` ```buttons ` 围栏里，行首（trim 后）以 `//` 开头的行渲染为普通文本，不渲染为按钮。
- 文本行从快捷命令下拉中排除（不当作命令收集）。
- 文本行不可点击（无 `data-cmd`），靠现有事件委托天然忽略。
- 完全向后兼容：现有行格式（`命令 # 标签 // edit`）零改动。

**非目标（YAGNI）**

- 不做「同一行内文本 + 按钮并排」的横向布局 —— 只做按行的垂直交织，复用现有 `.cmd-buttons` 纵向 flex 容器。
- 不对文本行做 markdown / 富文本渲染 —— 纯文本、HTML 转义后输出。
- 不在 ` ```buttons-json ` 里支持文本行 —— 那是 JSON，需要时走独立 schema 字段。

## 语法规则（位置区分，复用已有 `//` 记号）

`//` 这个记号已在行格式里出现（行尾 ` // edit` = edit 模式）。本设计复用它，靠**位置**区分两种含义：

| 位置 | 含义 |
|---|---|
| trim 后**行首**为 `//` | 整行是普通文本（按钮列表里的一段说明 / 小标题） |
| 行尾 ` // edit` | edit 模式按钮（不变） |
| 行中 ` # ` | 命令 / 标签分隔（不变） |

判定顺序：**先判行首 `//`**，再判行尾 ` // edit`。因此 `// note // edit` 被当作文本行（而非 edit 按钮）——文本行优先。

`//` 不是 POSIX shell 的元字符（`//foo` 在 shell 里只是一条冗余路径），满足「CLI 不会作为命令执行」的要求；文本行本就永不送进终端，此处只求解析无歧义、对人直观。

## 改动点

### 1. `parseButtonLine`（`src/shared/buttonBlock.ts`）

在函数最前面加一个判断：若 trim 后的行以 `//` 开头，直接返回 `null`。

- 这一处的副作用正好让 `parseButtonsFromMarkdown`（快捷命令下拉）自动跳过文本行 —— 无需第二条代码路径。
- 必须在 ` // edit` 判断**之前**执行，保证「行首 `//` 优先于行尾 edit」。

### 2. `renderButtonsBlock`（同文件）

逐行扫描围栏内容：

- trim 后行首为 `//` → 文本行：剥掉开头的 `//` 及其后空白，得到正文，`escapeHtml` 后输出 `<div class="cmd-text">{正文}</div>`。剥完后若正文为空，跳过该行。
- 否则照旧 `parseButtonLine` → 命令行输出 `<button>`，空行跳过。

文本行与按钮行共同放进现有的 `<div class="cmd-buttons">` 纵向 flex 容器，从而自上而下交织。

空判定：只要存在任意按钮或文本行就渲染；整块全空才返回 `''`（保持现状语义）。

### 3. CSS（`src/renderer/styles.css`）

`.cmd-text` 不设任何字体/字号/颜色/字重/行高 —— 全部继承外层 `.help` 正文样式，使它和 buttons 围栏之外的普通段落（如「常用命令：」）看起来完全一致，而不是一种特殊「标签」观感。横向无内边距，文字左缘与正文对齐。

### 4. 文档 / 示例

- `src/main/seed.ts`：在示例 ` ```buttons ` 块里加一行 `//` 文本，让首次运行的用户看到效果。
- `CLAUDE.md` 的「`buttons` markdown extension」一节、以及 `README.md` 中描述围栏语法的段落，补一句行首 `//` = 文本行。

## 测试（`tests/buttonBlock.test.ts`）

- `parseButtonLine`：`'// note'` → `null`；`'//note'` → `null`；`'// x // edit'` → `null`（文本优先）；`'git commit -m "" // edit'` 仍是 edit 按钮（回归）。
- `renderButtonsBlock`：文本 + 按钮按行序交织输出；文本被 HTML 转义且无 `data-cmd`；只有文本行的块照常渲染；`parseButtonsFromMarkdown` 跳过 `//` 行，只收真按钮。

## 风险

- **记号复用混淆**：`//` 既做行首文本又做行尾 edit，靠位置区分。已在 seed 示例与文档里明示，判定顺序固定（行首优先），测试覆盖边界。
- **以 `//` 开头的真实命令被误判为文本**：shell 里行首 `//` 本就不是可执行命令（是冗余路径），符合「不是命令」语义；可接受。
