# 为项目生成 TermStep 帮助页（buttons 语法权威说明）

> 这是一份给 AI agent / 人阅读的**生成说明**：在你**正在工作的任意项目**里，按本文件的规则，为该项目生成一个 TermStep 帮助页片段（一个 `.md` 文件），用户把它粘进 TermStep 已有工具的 `help.md` 即可在右侧查阅文档 + 一键执行命令按钮。
>
> 产物是 **help.md 片段**，不涉及 tool.json / bundle / UUID / 目录结构。只关心两件事：**怎么写 markdown 文档** + **怎么用 buttons 语法做命令按钮**。

---

## 0. 一分钟速览（TL;DR）

在任意项目的根目录（或 `docs/`）生成一个 `termstep-help.md`，长这样：

````markdown
# <项目名> 速查

## 构建

```buttons
// 安装依赖
npm install
npm run build # 构建（生产）
npm run dev   # 启动 dev server
```

## 测试

```buttons
npm test           # 跑全部单测
npm run typecheck  # 类型检查
```

## 常用 Git

```buttons-json
[
  { "label": "提交", "command": "git commit -m {{message}}", "edit": true,
    "params": [ { "name": "message", "hint": "提交信息", "required": true } ] }
]
```
````

用户把整段粘进 TermStep 某个工具的 `help.md`，右侧立即出现可点击的按钮。**就这两件事：写文档 + 用 buttons 围栏。**

---

## 1. TermStep 帮助页是什么

TermStep 是个 macOS 工具：每个「工具」有一个持久终端 + 一个 markdown 帮助页（右侧显示）。帮助页用 `markdown-it` 渲染，额外支持两种自定义围栏：

| 围栏 | 语法 | 适用场景 |
|------|------|---------|
| ` ```buttons ` | 每行一个按钮，轻量文本语法 | 固定命令、无参数、快速罗列 |
| ` ```buttons-json ` | JSON 数组，支持参数表单 | 需要用户填参数（分支名、commit 信息等） |

点击按钮 → 命令被粘进当前激活的工具终端并回车执行（`edit` 模式则只粘贴不回车，让用户改完再回车）。

**渲染器只认这两种围栏语言字符串，且必须精确匹配**（不能写 ` ```buttons ` 后面再跟别的，info 字段会被 `trim()`，所以 ` ```buttons ` 和 ` ```buttons  ` 等价，但 ` ```buttons-foo ` 不识别）。

---

## 2. `buttons` 围栏语法（重点）

围栏体每行被独立解析。四种行类型：

### 2.1 普通按钮（最常见）

```
命令 # 标签
```

- ` # `（空格-井号-空格）是**命令与标签的分隔符**。分隔后左侧是真正执行的命令，右侧是按钮上显示的文字。
- **没有** ` # ` 时，整行既是命令也是标签（按钮文字 = 命令本身）。

````markdown
```buttons
git status              # 按钮显示「git status」，点击执行 git status
git log --oneline -20   # 按钮显示「git log --oneline -20」
git push                # 推送
```
````

### 2.2 编辑模式（` // edit` 后缀）

行尾加 ` // edit`（空格-双斜杠-空格-edit）→ 命令粘进终端**但不自动回车**，让用户改完再按回车。

````markdown
```buttons
git commit -m ""  // edit    # 粘贴后光标停在引号里，用户填信息
git rebase -i HEAD~3 // edit  # 让用户改完再执行
```
````

适合：模板命令（`-m ""`、`--filter=...`）、危险/需复核的命令（rebase、force push 前）。

### 2.3 纯文本标签（行首 `//`）

**行首（trim 后）以 `//` 开头** → 渲染成不可点击的文本（`<div class="cmd-text">`），用来在按钮组里插入说明/分组标题。

````markdown
```buttons
// 日常提交流程
git add -A
git commit -m "wip"
git push

// 紧急回滚（慎用）
git reset --hard HEAD~1 // edit
```
````

注意 `//` 的位置语义：
- **行首** `//` = 纯文本（不可点击）
- **行尾** ` // edit` = 编辑模式按钮

二者不冲突，靠位置区分。

### 2.4 注释行（行首 `#`）

**行首（trim 后）以 `#` 开头** → shell 风格注释，**完全不渲染**（连文本都不显示），只留在 md 源码里给作者看。

````markdown
```buttons
# 这行不会出现在渲染结果里，仅供作者备注
git status # 这行会显示，# 后是标签
```
````

行首 `#` = 注释（不渲染）；行中 ` # ` = 标签分隔符。靠位置区分。

### 2.5 空行

围栏体内的空行被忽略（不产生任何输出），可以用来在源码里视觉分组。**不要**指望空行在渲染结果里产生间隔——渲染结果是一个连续的按钮容器。

### 2.6 ⚠️ 易错点（必须记住）

1. **` # ` 用 `indexOf` 首次匹配**：如果命令本身含 ` # `（极少见，比如某些 sed/awk 表达式），会被误切。规避：用 `buttons-json`，或把命令重写得不含 ` # `。
2. **标签里的 ` # ` 不需要转义**：标签是 ` # ` 之后的所有内容（trim 后），可以有任意字符。
3. **`//` 只看行首**：命令中间出现 `//`（如 URL `https://...`）没问题，不会被当文本行。但**行首**如果是 `//`，整行就是文本——所以不要把 `//` 开头的真命令放行首（几乎不会遇到，shell 里 `//` 也不是合法命令开头）。
4. **` # ` 分隔符前后都要空格**：`git status# 查状态` 不会识别（缺前导空格），整行会被当命令+标签=整行。
5. **围栏语言字符串精确**：只能写 `buttons` 或 `buttons-json`，不能是 `button`、`cmd` 等。

---

## 3. `buttons-json` 围栏语法

JSON 格式，支持参数表单。围栏体是一个 JSON **对象或数组**（推荐数组）。

### 3.1 最小示例

````markdown
```buttons-json
[
  { "label": "提交", "command": "git commit -m {{message}}", "edit": true,
    "params": [ { "name": "message", "hint": "提交信息", "required": true } ] }
]
```
````

点击「提交」→ 弹一个表单让用户填 `message` → 填的值**自动 POSIX shell 转义**后替换 `{{message}}` → 执行。

### 3.2 字段定义

**按钮对象**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | ✅ | 命令模板，可含 `{{name}}` 占位符 |
| `label` | string | | 按钮显示文字；缺省 = `command` |
| `edit` | boolean | | `true` = 粘贴不回车；缺省 `false` |
| `params` | array | | 参数定义数组；无占位符时省略 |

**参数对象**（`params[]` 的元素）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 参数名，对应 `command` 里的 `{{name}}` |
| `hint` | string | | 输入框提示文字 |
| `options` | string[] | | 下拉选项；提供时渲染为下拉框而非文本框 |
| `default` | string | | 默认值 |
| `required` | boolean | | `true` = 必填（空值阻断执行） |

类型严格：`edit`/`required` 只认 `=== true`，字符串 `"false"` 或数字都会被当 falsy 丢弃。所以必须写 `true`，不能写 `"true"`。

### 3.3 ⚠️ 占位符转义规则（最关键的坑）

`{{name}}` 的值会经过 **POSIX 单引号转义**后替换。意思是：**系统自动加引号，你不要再手动加引号**。

```json
// ✅ 正确：占位符裸写
{ "command": "git commit -m {{message}}" }
// 用户填 修复 bug  → 执行 git commit -m '修复 bug'
// 用户填 it's      → 执行 git commit -m 'it'\''s'   （安全）

// ❌ 错误：占位符外面又包了引号
{ "command": "git commit -m \"{{message}}\"" }
// 用户填 修复 bug  → 执行 git commit -m "'修复 bug'"   （多了一层引号）

// ❌ 错误：占位符在已有引号里
{ "command": "echo \"hello {{name}}\"" }
// 会产生双重转义，命令坏掉
```

规则：**占位符两侧不要有任何引号**（单引号双引号都不要）。让转义系统自己加。空字符串占位符会被替换成空（不留 `''` 参数），方便可选参数。

### 3.4 占位符未匹配行为

如果 `command` 里写了 `{{foo}}` 但 `params` 里没声明 `foo`：占位符**原样保留**（字面 `{{foo}}` 出现在命令里），方便你调试时一眼看到漏了哪个。

### 3.5 多参数示例

````markdown
```buttons-json
[
  {
    "label": "新建分支并切换",
    "command": "git checkout -b {{branch}}",
    "params": [
      { "name": "branch", "hint": "分支名，如 feature/x", "required": true }
    ]
  },
  {
    "label": "部署",
    "command": "npm run deploy -- --env {{env}} --region {{region}}",
    "params": [
      { "name": "env", "options": ["staging", "production"], "default": "staging" },
      { "name": "region", "options": ["us", "eu", "asia"], "default": "us" }
    ]
  }
]
```
````

### 3.6 何时用 buttons-json 而非 buttons

- **buttons**：固定命令，无需用户输入。简单、可读。
- **buttons-json**：需要用户填参（分支名、commit 信息、环境名、文件名……）。参数多时必用。

别为了"显得高级"而把无参数命令也塞进 buttons-json——buttons 更易读易维护。

---

## 4. 帮助页整体结构（markdown 主体）

帮助页是普通 markdown，buttons 围栏嵌在其中。建议结构：

````markdown
# <项目名>

> 一句话项目简介（可选）

## 环境要求

- Node 20+、Python 3.11 等（列依赖前提）

## 快速开始

```buttons
npm install
npm run dev
```

## 构建

```buttons
npm run build       # 生产构建
npm run build:web   # 仅构建前端
```

## 测试

```buttons
npm test
npm run test:watch  # 监听模式
```

## 常用 Git

```buttons-json
[
  { "label": "提交", "command": "git commit -m {{message}}", "edit": true,
    "params": [ { "name": "message", "hint": "提交信息", "required": true } ] }
]
```

## 部署

```buttons
npm run deploy
```

## 备注

- 某些需要手动操作的步骤说明
- 环境变量配置说明（`.env` 需要哪些 key）
````

### 4.1 组织原则

1. **按使用频率/职能分节**：构建 / 测试 / 部署 / 数据库 / Git / 调试……每节一个小标题（`##`）。
2. **每节内 buttons 围栏放该类命令**：不要把所有命令堆进一个围栏，分节更清晰，也方便后续局部增删。
3. **`##` 标题会进 TOC**：TermStep 帮助页右侧有目录导航（自动从 H2 生成），分节能直接跳转。
4. **长内容分节折叠**：帮助页会自动折叠长章节，所以多写几节没问题，不会一屏塞满。
5. **命令加标签**：没标签时按钮文字=命令本身（长命令很丑），加 ` # 短标签` 让按钮简洁。短命令（`npm test`）可省标签。
6. **危险命令注释**：destructive 命令（删库、force push、reset --hard）加 `// edit` 或在前面放 `// ⚠️ 危险` 文本提示。
7. **markdown 主体写"为什么"和"怎么选"**：按钮解决"一键执行"，文档解决"该用哪个、什么时候用"。别把所有说明都塞进按钮标签。

### 4.2 链接与外部资源

普通 markdown 链接 `[文档](https://...)` 可用（TermStep 会用系统浏览器打开）。适合放：项目 wiki、API 文档、设计文档、issue tracker 链接。

---

## 5. 命令挖掘规则（Agent 自动生成时执行）

当 agent 为一个项目生成帮助页时，按以下顺序扫描并提炼命令。**不要凭空捏造命令**——只写能从项目文件里找到证据的命令。

### 5.1 必扫文件（按优先级）

| 文件 | 提炼什么 | 备注 |
|------|---------|------|
| `package.json` | `scripts` 字段所有 key | 最常见来源。过滤掉 `pre*`/`post*` 钩子脚本（用户不直接跑） |
| `Makefile` / `makefile` | 所有 target（`:` 左边） | 跳过 `.PHONY` 等内置 target |
| `justfile` / `Justfile` | 所有 recipe（`:` 前的 recipe 名） | just 是 make 的现代替代 |
| `Taskfile.yml` / `Taskfile.yaml` | `tasks:` 下的 key | go-task |
| `Cargo.toml` | `[workspace] members`、`[[bin]]` | Rust；命令是 `cargo run --bin <name>`、`cargo test` |
| `pyproject.toml` / `setup.py` | 项目脚本入口、测试框架 | 命令视框架而定（pytest / uv / poetry / pip） |
| `go.mod` | 模块名 → `go run`、`go test ./...` | Go |
| `.github/workflows/*.yml` | CI 里实际跑的命令 | 高价值——这些是"官方认可"的命令 |
| `README.md` / `CONTRIBUTING.md` | 文档里的命令示例（` ```bash `、行首 `$ `） | 用户文档里推荐的命令 |
| `docker-compose.yml` | service 名 | `docker compose up <service>`、`docker compose logs <service>` |

### 5.2 命令分类（决定放哪一节）

把挖掘到的命令按职能归类。常见分类：

- **环境/安装**：`install`、`setup`、`bootstrap`、`pip install -r requirements.txt`
- **开发**：`dev`、`serve`、`start`、`watch`
- **构建**：`build`、`build:prod`、`compile`、`bundle`
- **测试**：`test`、`test:unit`、`test:e2e`、`lint`、`typecheck`、`check`
- **数据库**：`db:migrate`、`db:seed`、`db:reset`
- **部署**：`deploy`、`release`、`publish`
- **清理**：`clean`、`distclean`、`prune`
- **Git/通用**：不依赖项目脚本，但高频（提交、建分支、查日志）

如果某分类没有对应命令，**不要硬编造**——直接省略该节。

### 5.3 从命令到 buttons 的映射规则

| 命令特征 | 用哪种围栏 | 例子 |
|---------|-----------|------|
| 无参数，固定 | `buttons` | `npm run build` |
| 有固定可选值（环境/模式） | `buttons-json` + `options` | `--env staging\|production` |
| 需要用户填自由文本 | `buttons-json` + `required` | commit 信息、分支名 |
| 模板命令（用户要改） | `buttons` + ` // edit` | `git commit -m ""` |
| 危险/不可逆 | `buttons` + ` // edit`，前面加 `// ⚠️` 文本 | `git reset --hard` |

### 5.4 命令标签命名原则

- **动词开头**：「构建」「测试」「启动 dev」「提交」而非「build」「test」。
- **简短**：按钮宽度有限，2-6 字最佳。长命令的标签尤其要短。
- **区分变体**：`build` 和 `build:web` 标签要区分（「构建」「构建前端」），别都叫"构建"。
- **中文优先**：项目用户是中文开发者时用中文标签（TermStep 界面是中文）。

### 5.5 应该避开的命令

- **已废弃/被注释的脚本**：package.json scripts 里若注释或 README 标注 deprecated，跳过。
- **内部钩子**：`pretest`、`postinstall` 之类自动触发的，用户不直接跑。
- **平台特定且当前平台跑不了的**：如项目是 Linux 部署脚本但你在 macOS，仍可收录（TermStep 可能在远程 ssh 工具里用），但标签注明平台。
- **需要交互式输入且无法参数化的**：如裸 `npm login`（需多步交互）——加 `// edit` 或跳过。

---

## 6. 完整生成示例

假设项目是 `package.json` 有这些 scripts：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "deploy": "npm run build && wrangler deploy"
  }
}
```

生成产物 `termstep-help.md`：

````markdown
# my-app 速查

> Vite + TypeScript 前端项目。

## 开发

```buttons
npm install      # 安装依赖
npm run dev      # 启动 dev server（:5173）
```

## 构建与质量

```buttons
npm run build       # 生产构建
npm run typecheck   # 类型检查
npm run lint        # ESLint
```

## 测试

```buttons
npm test            # 跑全部单测
npm run test:watch  # 监听模式
```

## 部署

```buttons
npm run deploy  # 构建 + 部署到 Cloudflare
```

## 常用 Git

```buttons-json
[
  {
    "label": "提交",
    "command": "git commit -m {{message}}",
    "edit": true,
    "params": [ { "name": "message", "hint": "提交信息", "required": true } ]
  },
  {
    "label": "新建分支",
    "command": "git checkout -b {{branch}}",
    "params": [ { "name": "branch", "hint": "分支名，如 feature/x", "required": true } ]
  }
]
```

## 紧急操作

```buttons
// ⚠️ 以下命令不可逆，edit 模式确认后再回车
git reset --hard HEAD~1  // edit  # 撤销最近一次提交（丢改动）
git clean -fd           // edit   # 删除未跟踪文件
```
````

---

## 7. 校验清单（生成后自查）

- [ ] 围栏语言是 `buttons` 或 `buttons-json`（精确，无后缀）
- [ ] buttons 行尾 ` // edit` 有前导空格；行首 `//` 是文本、`#` 是注释
- [ ] buttons-json 是合法 JSON（`edit`/`required` 是 `true` 不是 `"true"`）
- [ ] 占位符 `{{name}}` 两侧无引号；每个占位符都在 `params` 里声明
- [ ] 命令有证据来源（package.json / Makefile / CI / README），不是编造的
- [ ] 危险命令有 `// edit` 或 `// ⚠️` 提示
- [ ] 标签简短、中文、动词开头；长命令有标签
- [ ] 按职能分了多个 `##` 节，每节一个 buttons 围栏
- [ ] 顶层有一个 `# 标题`，开头可有一句话简介

---

## 8. 落地（用户侧）

生成完 `termstep-help.md` 后，用户：

1. 打开 TermStep，选一个已有工具（或新建一个，cwd 设到该项目目录）
2. 点「编辑帮助页」
3. 把 `termstep-help.md` 全文粘进去（可追加到现有内容后）
4. 保存

右侧立即渲染出文档 + 按钮。命令会在该工具的终端（cwd = 项目目录）里执行。

> **cwd 提示**：TermStep 工具有 `cwd` 字段（启动目录）。生成 help.md 时无需关心——但建议告诉用户把工具的 cwd 设到项目根，这样按钮里的相对路径命令（`npm run build`）能正确执行。

---

## 附：语法快速参考卡

````markdown
<!-- 文本/分组标题 -->
// 这是一段说明文字（不可点击）

<!-- 注释（不渲染） -->
# 作者备注，渲染结果里看不到

<!-- 普通按钮 -->
命令
命令 # 标签

<!-- 编辑模式（粘贴不回车） -->
命令 # 标签 // edit

<!-- 参数按钮（弹表单） -->
```buttons-json
[
  { "label": "标签", "command": "cmd {{name}}", "edit": true,
    "params": [
      { "name": "name", "hint": "提示", "required": true },
      { "name": "env", "options": ["a", "b"], "default": "a" }
    ]
  }
]
```
````

---

*本文档与 TermStep `src/shared/buttonBlock.ts` 的解析逻辑严格对齐。语法有疑问时，以该源码的 `parseButtonLine` / `parseButtonsJson` / `substituteParams` 为准。*
