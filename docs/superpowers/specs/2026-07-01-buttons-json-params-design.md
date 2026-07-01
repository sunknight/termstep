# buttons-json：参数化命令按钮

## 背景

`gui_anything` 的 help.md 用 ` ```buttons ` 围栏块把命令渲染成一键按钮。现有格式定义在 `src/shared/buttonBlock.ts`：每行一个按钮，语法 `命令 [# 标签] [// edit]`。两个消费者复用同一份解析：

- **HelpPane**（`src/renderer/components/HelpPane.tsx`）：markdown-it 把 ` ```buttons ` 渲染成 `<button class="cmd-btn">`，点击靠事件委托，读 `data-cmd` / `data-edit` 后调用 `runCommandChecked` → `runCommand`（粘贴进终端，非 edit 模式补回车）。
- **QuickCommands**（`src/renderer/components/QuickCommands.tsx`）：全局快捷命令下拉，用 `parseButtonsFromMarkdown` 解析同一个 markdown，自己渲染 React `<button>`，点击在当前激活工具的终端执行。

现需支持「带参数的按钮」：命令里有占位符，点击后弹出表单填参数，替换后执行。现有行格式保留。

## 目标 / 非目标

**目标**

- 新增 ` ```buttons-json ` 围栏，用 JSON 描述按钮，支持参数。
- 参数支持：可编辑文本 + 可选建议（datalist）、必填校验、默认值、说明文字。
- 占位符语法 `{{name}}`，表单提交后替换进命令模板再执行。
- HelpPane 和 QuickCommands 两侧都支持参数化按钮。
- 完全向后兼容：现有 ` ```buttons ` 行格式零改动。

**非目标（YAGNI）**

- 不做单独的「开关/标志」参数类型 —— 标志用 `{{flags}}` 占位 + `options` 建议表达。
- 不对参数值做转义 —— 值由用户自己输入、跑在用户自己的终端，「注入」只是自伤而非攻击面；转义反而破坏合法值（如 commit 信息里的引号）。
- 不做参数类型推断（数字 / 布尔等），所有参数统一为文本输入。

## 数据模型

### 围栏

新增 ` ```buttons-json `。` ```buttons `（行格式）完全不动。两种围栏可出现在同一个 help.md 里，按钮按文档顺序合并。一个 `buttons-json` 围栏的顶层既可以是单个对象 `{...}`，也可以是数组 `[{...}, ...]`。

### 按钮对象 schema

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | ✅ | 命令模板，含 `{{name}}` 占位符 |
| `label` | ❌ | 按钮显示文字；省略则用 `command` 模板（建议参数化按钮总是写 `label`） |
| `edit` | ❌ | `true` = 粘贴不回车；默认 `false` |
| `params` | ❌ | 参数数组；默认 `[]`（即普通按钮，走直接执行路径） |

### 参数对象 schema

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 参数名；必须能在 `command` 里找到对应 `{{name}}`，同时作表单字段 id |
| `hint` | ❌ | 字段下方说明文字 |
| `options` | ❌ | 字符串数组；datalist 建议项，用户仍可手输任意值 |
| `default` | ❌ | 预填默认值 |
| `required` | ❌ | `true` = 留空时阻止提交；默认 `false` |

### 占位符规则

- 语法 `{{name}}`（双花括号）—— 不与 shell 的 `$VAR` / `${VAR}` 冲突。
- 替换模板里**所有**出现的 `{{name}}`（同名可多次出现，全部替换）。
- 每个想填值的参数都必须在 `command` 里放一个**裸占位符** `{{name}}`；这是唯一的填值入口。
- **值会被 POSIX 单引号包裹后替换**（`shellQuote`：`1"` → `'1"'`、`hello world` → `'hello world'`、`it's` → `'it'\''s'`），所以即使值里含空格/引号/`$`/`;` 等，也是一条安全的 shell 参数。**因此作者不要在占位符外面包自己的引号**——写 `git commit -m {{message}}`，不要写 `git commit -m "{{message}}"`（否则会出现双重引号）。
- 空值替换为空串（可选参数留空即消失，不会产生空的 `''` 参数）；最后对整条命令做首尾 `trim()`。
- 模板里出现 `{{x}}` 但 `params` 没定义 `x` → 该占位符**原样保留**（用户在终端 / 确认框里会看到 `{{x}}`，便于发现配置错误），不静默吞掉。
- 取舍说明：默认转义意味着「一个参数 = 一条 shell 参数」；若作者需要「一个参数展开成多个参数」（如 `{{args}}` = `--foo --bar`），默认转义会把它引成一个整体——这是有意的安全默认，多参数场景目前需拆成多个占位符。

### 示例（git 工具 help.md 片段）

````markdown
```buttons
git status # 查看状态
git log --oneline -20
```

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

## 解析与渲染管线

### 类型扩展（`src/shared/buttonBlock.ts`）

```ts
export interface ButtonParam {
  name: string;
  hint?: string;
  options?: string[];
  default?: string;
  required?: boolean;
}

export interface ParsedButton {
  command: string;          // JSON 按钮这里是含 {{}} 的模板
  label: string;
  edit: boolean;
  params?: ButtonParam[];   // undefined 或空数组 → 普通按钮，走原直接执行路径
}
```

### `parseButtonsJson(code)`

- `JSON.parse(code)`；接受单个对象或数组；逐个校验 `command` 非空字符串、每个 param 的 `name` 非空字符串，否则丢弃该项。
- 防御性类型归一：`edit` / `required` → `Boolean`、`options` → `string[]`、`default` → `string`。
- JSON 语法错 → 返回 `{ error: message }`，由渲染层显示成红色错误块。

### `parseButtonsFromMarkdown` 扩展

现只扫 ` ```buttons `。改成单个正则同时匹配 `buttons` 和 `buttons-json`（带类型捕获组），按文档顺序合并、分派到对应解析器。这样 HelpPane 和 QuickCommands 共享一份逻辑，参数化按钮在两边都自动可用。

### `markdown.ts` 围栏路由

- `info === 'buttons'` → `renderButtonsBlock`（原样不动）
- `info === 'buttons-json'` → 新的 `renderButtonsJsonBlock`
- 否则 → 默认 fence 渲染

### HelpPane 的 DOM 编码

参数化按钮把整个 `params` 序列化进 `data-params` 属性（HTML 转义），`data-cmd` 存模板（含 `{{}}`）。点击委托处理器据此分叉：

```html
<button class="cmd-btn"
        data-cmd="git commit -m &quot;{{message}}&quot;"
        data-edit="1"
        data-params="[{&quot;name&quot;:&quot;message&quot;,&quot;required&quot;:true},...]">提交</button>
```

点击时 `JSON.parse(btn.dataset.params)` 还原（浏览器读 `dataset` 自动反转义 HTML 实体）。无 `data-params` → 走原直接执行路径。

### 错误反馈

JSON 围栏解析失败时，渲染一个红色提示块（而不是整块消失），作者能立刻看到语法错在哪：

```html
<div class="cmd-error">⚠️ buttons-json 解析失败：Unexpected token ...</div>
```

## 参数表单与执行流程

### 共享 hook `useParamPrompt()`

不引入全局单例，状态就近。HelpPane 和 QuickCommands 各自调用一次、各自在 JSX 末尾渲染 `{node}`（state 为 null 时不渲染任何弹窗）：

```ts
const { open, node } = useParamPrompt();

// 点击委托处理器分叉
if (btn.dataset.params) {
  const params = JSON.parse(btn.dataset.params);
  open({ command: template, edit, params }, (values) => {
    if (!values) return;                                    // 用户取消
    const finalCmd = substituteParams(template, values);
    runCommandChecked(toolId, finalCmd, edit, opts);        // 复用现有危险命令拦截
  });
  return;
}
runCommandChecked(toolId, command, edit, opts);             // 普通按钮，原路径不动
```

危险命令检测作用在**替换后的真实命令**上（顺序：填表 → 替换 → 危险确认 → 执行），天然正确。

### `<ParamPromptModal>` 组件（复用现有 `.modal-overlay` 样式）

- 顶部：命令**实时预览**（只读 monospace，随输入更新）。
- 每个参数一行：`<label>{name}{required && ' *'}</label>` + `<input>`（预填 `default`）+ 有 `options` 时挂 `<datalist>` + `hint` 文字在下方。
- 校验：提交时若有 `required` 字段为空 → 聚焦该字段 + 行内红字提示，不关闭。
- 键盘：输入框回车 = 提交；Esc / 点遮罩 = 取消。
- 底部按钮：`确定` / `取消`。

### `substituteParams(template, values)`

- 对每个参数值先经 `shellQuote`（POSIX 单引号包裹，空值保持空串），再替换模板里所有 `{{name}}`。
- 可选参数留空 → 替换成空串；最后对整条命令做一次首尾 `trim()`（去掉如 `git push ` 的尾随空格）。
- 模板内部空白**不**做折叠（避免破坏引号里有意的空格，如多词 commit message）。
- 约定：把可能为空的参数放在命令末尾，避免中间出现多余空格。
- 模板里出现 `{{x}}` 但 `params` 没定义 `x` → 原样保留。

### QuickCommands 一致性

因 `parseButtonsFromMarkdown` 现在带上 `params`，全局快捷命令下拉里也会出现参数化按钮；点击时关闭下拉、打开同一个表单、填完在当前激活工具的终端执行，无需额外接线。

## 测试与边界情况

### 单元测试（扩展 `tests/buttonBlock.test.ts`，纯函数、node env、不碰 DOM）

- `parseButtonsJson`：单个对象 / 数组 / 缺 `command` 被丢 / `params` 缺 `name` 被丢 / 类型归一 / JSON 语法错返回 error。
- `parseButtonsFromMarkdown`：`buttons` 和 `buttons-json` 混合出现时按文档顺序合并；忽略其它围栏。
- `substituteParams`：多占位、同名多次、可选留空、未定义占位原样保留、首尾 trim。
- `renderButtonsJsonBlock`：`data-cmd` 带模板、`data-params` JSON 正确转义、无参数时不输出 `data-params`、解析失败输出红色 `.cmd-error` 块。

### 手动验证（无 RTL，沿用 `ptyService` 的 live 验证惯例）

`npm run dev`，在 help 页和快捷命令下拉分别点参数化按钮 → 填表（含必填校验、datalist、回车提交、Esc 取消）→ 看实时预览 → 确认后命令正确注入终端；危险命令仍弹二次确认。

### 边界决定

- **参数值默认做 POSIX shell 转义**（`shellQuote` 单引号包裹），所以值里的空格/引号/`$`/`;` 都安全。代价：「一个占位符 = 一条 shell 参数」；需要展开成多个参数的场景要拆成多个占位符。作者写裸占位符，不要在外面包引号。
- JSON 按钮省略 `label` → label 回退为命令模板（带 `{{}}`，较丑）；建议总是写 `label`。
- JSON 按钮无 `params`（或空数组）→ 当普通按钮，不输出 `data-params`，走直接执行路径；两条路径在渲染层合并。
- 参数化按钮的 `data-tip`（hover 提示）显示模板（如 `git commit -m "{{message}}"`），让用户看到命令形状。

## 受影响文件

- `src/shared/buttonBlock.ts` — 新增 `ButtonParam` 类型、`parseButtonsJson`、`renderButtonsJsonBlock`、`substituteParams`；扩展 `ParsedButton` 和 `parseButtonsFromMarkdown`。
- `src/renderer/lib/markdown.ts` — 围栏路由增加 `buttons-json`。
- `src/renderer/lib/paramPrompt.ts` — 新文件，`useParamPrompt` hook。
- `src/renderer/components/ParamPromptModal.tsx` — 新文件，表单弹窗组件。
- `src/renderer/components/HelpPane.tsx` — 点击委托分叉。
- `src/renderer/components/QuickCommands.tsx` — 点击委托分叉。
- `src/renderer/styles.css` — `.cmd-error` 样式 + 表单样式。
- `tests/buttonBlock.test.ts` — 扩展用例。
- `src/main/seed.ts` — （可选）给示例 git 工具加一个参数化按钮做示范。
