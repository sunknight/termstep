---
name: termstep-tool-gen
description: "Generate TermStep artifacts for the current project: a help page (.md with buttons/buttons-json fenced blocks) AND/OR an importable tool bundle JSON (TermStep 导入格式) that can be one-click imported. Triggers when user asks to create TermStep tool config, generate command buttons for a project, write a clickable command cheatsheet, or '为这个项目生成 TermStep 工具/帮助页/命令按钮'. 两类产物：(a) termstep-help.md 帮助页片段；(b) termstep-tool.json 可直接导入 TermStep 的工具 bundle（默认走远程配置模式，mdUrl 指向 help.md 绝对路径）。必须把项目的主要脚本（package.json scripts / Makefile targets 等）及其使用方法写进帮助文档主体。"
---

# TermStep 工具生成器

为**当前工作的项目**生成两类产物（默认都生成）：

1. **`termstep-help.md`** —— 帮助页片段（markdown 主体 + buttons/button-json 围栏）。可粘进 TermStep 已有工具，也可被 bundle JSON 通过远程配置引用。
2. **`termstep-tool.json`** —— TermStep **导入格式**的工具 bundle。一条「导入」即装好「工具 + 帮助页」，无需手粘。

**核心原则**：帮助页不只是命令按钮清单，还要把**项目主要脚本/命令的用途、参数、调用方法**写成 markdown 主体——让用户看完文档就知道什么时候用哪条命令、怎么传参、有哪些坑，按钮只解决"一键执行"。

## 何时触发

- 用户说「为这个项目生成 TermStep 工具/帮助页/命令按钮/速查表」→ 默认两类都生成。
- 用户说「生成可导入的 TermStep 工具 / bundle / JSON」→ 重点生成 `termstep-tool.json`。
- 用户说「只生成帮助页片段」→ 只生成 `termstep-help.md`。
- 用户提到 buttons / buttons-json 语法并想生成。

## 产物

- `termstep-help.md`（放项目根或 `docs/`）：markdown 主体写文档 + buttons/button-json 围栏做按钮。
- `termstep-tool.json`（放项目根或 `docs/`）：TermStep 导入 bundle。**默认走远程配置模式**：`meta.mdUrl` 指向 `termstep-help.md` 的**绝对路径**、`meta.useRemote = true`、`meta.cwd` = 项目根绝对路径。导入后帮助页只读、单一来源是这个 md 文件，**改 md 即时生效，无需进 TermStep 编辑**。

## 工作流

1. **确定项目根的绝对路径**（`pwd` / `git rev-parse --show-toplevel`）。bundle 里 cwd 和 mdUrl 都用绝对路径。
2. **扫描项目**，按下面「命令挖掘规则」找命令、提炼脚本说明。**绝不编造没有证据的命令，也不编造脚本不存在的参数/行为。**
3. **分类**命令（构建/测试/部署/数据库/Git...），缺失的分类直接省略。
4. **生成 `termstep-help.md`**：每个分类一节，markdown 主体写脚本说明 + buttons/button-json 围栏做按钮。
5. **生成 `termstep-tool.json`**，按下文「Bundle 格式」。**关键：必须写 `sourceId`**（步骤见下「sourceId 生成与复用」）——没有它，同一 bundle 每次导入都会新建重复工具。
6. 告诉用户两种落地方式（见「落地提示」）。

### sourceId 生成与复用（每次生成 bundle 必做）

`sourceId` 是跨导入去重的稳定匹配键（TermStep 后端按它判定「同一个工具」：命中已有 → 覆盖更新；未命中 → 新建）。**每个 bundle 必须带一个，且 UUID 格式**（后端校验）。

**首次生成**（项目里还没有 `termstep-tool.json`）：
```bash
uuidgen    # macOS 生成 UUID，如 E1B2C3D4-5678-90AB-CDEF-1234567890AB
```
把输出原样填进 `meta.sourceId`（大小写不限，但必须是标准 UUID 8-4-4-4-12 格式）。**不要**手写短字符串如 `"my-app"` 或 `"src-1"`——那是测试用的占位符，生产 bundle 必须是 UUID。

**重新生成**（项目里已有旧的 `termstep-tool.json`）：
1. 先读出旧 bundle 的 `meta.sourceId`。
2. 新 bundle **原样写回同一个值**，绝不重新 `uuidgen`。
3. 为什么：sourceId 一变，下次导入就匹配不上旧工具 → 又新建一个重复的，违背去重初衷。

**编造 sourceId 的典型错误**（自查时盯住）：
- ❌ `"sourceId": "my-app"` / `"src-1"` / `"fixed"` —— 不是 UUID。
- ❌ `"sourceId": "<UUID>"` —— 占位符原样没替换。
- ❌ 重新生成时换了新 UUID —— 丢了去重能力。
- ✅ `"sourceId": "e1b2c3d4-5678-90ab-cdef-1234567890ab"` —— 标准 UUID，跨生成稳定。

## buttons 语法（核心）

围栏语言**必须精确**是 `buttons` 或 `buttons-json`（trim 后等价，但不能有后缀）。

### `buttons` 围栏（每行一个按钮）

```
// 纯文本说明（行首 //，不可点击）       ← 分组标题/提示
# 注释（行首 #，完全不渲染）             ← 作者备注
命令                                     ← 按钮文字 = 命令
命令 # 标签                              ← 按钮显示「标签」
命令 # 标签 // edit                      ← 粘贴不回车，用户改完再执行
```

规则：
- ` # `（空格-井号-空格）分隔命令与标签，`indexOf` 首次匹配。
- 行首 `//` = 文本；行首 `#` = 注释（都不渲染成按钮）。
- 行尾 ` // edit`（前导空格）= 编辑模式。
- 空行被忽略。

### `buttons-json` 围栏（JSON 数组，支持参数表单）

```json
[
  {
    "label": "提交",
    "command": "git commit -m {{message}}",
    "edit": true,
    "params": [
      { "name": "message", "hint": "提交信息", "required": true }
    ]
  }
]
```

- `command` 必填；`label` 缺省=command；`edit`/`required` **必须是 `true`**（不是 `"true"`）。
- 参数：`name`（必填）/ `hint` / `options`（数组→下拉框）/ `default` / `required`。
- **占位符 `{{name}}` 自动 POSIX 转义 → 两侧不要再加引号**。`"cmd -m {{x}}"` ✅；`"cmd -m \"{{x}}\""` ❌。
- 占位符必须在 `params` 里声明，否则原样保留（调试时可见）。

### 何时用哪个

- **buttons**：固定命令、无参数。
- **buttons-json**：需用户填参（分支名、commit 信息、环境、文件名）。

## Bundle 格式（生成 `termstep-tool.json`）

TermStep 导入格式（`src/shared/bundle.ts` 的 `ToolsBundle`）。导入后在 `configs/tools/<新UUID>/` 落地成一个完整工具。

### 结构

```json
{
  "version": 1,
  "app": "TermStep",
  "exportedAt": "<ISO8601 时间，可选>",
  "tools": [
    {
      "meta": {
        "name": "<工具名>",
        "icon": "<emoji>",
        "cwd": "<项目根绝对路径>",
        "mdUrl": "<termstep-help.md 的绝对路径>",
        "useRemote": true,
        "autoUpdateMinutes": 0,
        "sourceId": "<固定 UUID，生成后永不改>"
      },
      "helpMarkdown": ""
    }
  ]
}
```

### meta 字段（远程配置模式必填）

| 字段 | 值 | 说明 |
|------|-----|------|
| `name` | 工具显示名 | 侧栏名，中文/英文均可 |
| `icon` | emoji | 侧栏图标，如 `🧪`/`📦`/`🚀`；缺省 `▣` |
| `cwd` | 项目根**绝对路径** | 终端启动目录，相对路径命令才能跑 |
| `mdUrl` | `termstep-help.md` 的**绝对路径** | 远程/本地帮助页来源 |
| `useRemote` | `true` | 启用远程配置：帮助页只读，来源是 mdUrl |
| `autoUpdateMinutes` | `0` | 远程模式扫描间隔；本地文件用 0（每次打开重读）|
| `sourceId` | **固定 UUID**（必填） | 跨导入去重的稳定匹配键。**生成 bundle 时生成一个 UUID 写进去，之后永远不改**。同一 `sourceId` 的 bundle 多次导入 → 更新而非重复新建。见下方「去重」 |
| `shell` / `env` / `tmux` / `initCommands` | 可选 | 按需加，但**会触发导入风险确认** |

**`sourceId` 去重约定**（关键，详细操作见「工作流 · sourceId 生成与复用」）：
- 首次生成用 `uuidgen` 产生一个标准 UUID 写进 `meta`；**重新生成时复用旧值，绝不重新生成**。
- 同一 bundle 多次导入：TermStep 后端按 `sourceId` 匹配已有工具 → 命中则**更新**（覆盖 tool.json + help.md），未命中才新建。没有 `sourceId` 的 bundle 即使后端兜底补了，**文件本身不变 → 下次仍匹配不上** → 重复新建。所以生成时必须带上。
- `sourceId` 与物理目录名（`id`）解耦：目录可因迁移/重命名换名，`sourceId` 不变。

**关键约定**（来自 TermStep 源码）：
- **`mdUrl` 是本地路径时**（非 http(s)/data scheme）→ TermStep 视为本地文件读取。**扩展名必须在白名单 `.md`/`.markdown`/`.txt`**，且不能落在敏感目录（`.ssh`/`.aws`/`.kube` 等），否则被守卫拒绝。放项目根或 `docs/` 下最安全。
- **`useRemote:false` 或缺省时**：即使配了 mdUrl，扫描也**不读它**（避免每次扫描触发 TCC 权限弹窗）。要用远程模式必须 `useRemote:true`。
- `helpMarkdown` 在 `useRemote:true` 时不被显示（显示 mdUrl 内容），可留空 `""`。
- **`id`/`order` 不要写**：导入时生成新 UUID 目录名，排序追加到末尾。

### 导入时的风险确认（正常现象）

含 `mdUrl` + `cwd` 的 bundle 导入时会弹「风险确认」（TermStep `scan_tool_risk`：远程订阅 + 工作目录）。这是**正常的**——告诉用户确认即可，不是错误。

### 完整 bundle 示例

````json
{
  "version": 1,
  "app": "TermStep",
  "exportedAt": "2026-07-18T00:00:00Z",
  "tools": [
    {
      "meta": {
        "name": "my-app",
        "icon": "🚀",
        "cwd": "/Users/me/projects/my-app",
        "mdUrl": "/Users/me/projects/my-app/termstep-help.md",
        "useRemote": true,
        "autoUpdateMinutes": 0,
        "sourceId": "a1b2c3d4-5678-90ab-cdef-1234567890ab"
      },
      "helpMarkdown": ""
    }
  ]
}
````

## 命令挖掘规则

**只写能从项目文件找到证据的命令。** 按优先级扫描：

| 文件 | 提炼 |
|------|------|
| `package.json` | `scripts` 的 key（过滤 `pre*`/`post*` 钩子）+ 每个主要 script 的**用途、参数、调用方法**（见下「脚本说明提取」） |
| `Makefile` / `justfile` / `Justfile` / `Taskfile.yml` | target / recipe 名 + 注释里的用途说明 |
| `Cargo.toml` | `cargo run --bin <name>`、`cargo test` |
| `pyproject.toml` / `go.mod` | 框架对应命令（pytest / uv / go run） |
| `.github/workflows/*.yml` | CI 实际跑的命令（高价值，官方认可） |
| `README.md` / `CONTRIBUTING.md` / `AGENTS.md` / `CLAUDE.md` | ` ```bash ` 块、行首 `$ ` 的命令示例、脚本用途说明 |
| `scripts/` 目录 | 自定义脚本 → `node scripts/xxx.mjs` / `bash scripts/xxx.sh`，读脚本头部注释提炼用途 |
| `docker-compose.yml` | service 名 → `docker compose up <svc>` |

按职能分类：环境/开发/构建/测试/数据库/部署/清理/Git。没命令的分类**直接省略，不要编造**。

### 脚本说明提取（必须做）

**对每个主要脚本/命令，除了生成按钮，还要提炼一段简短说明写进 markdown 主体**，让用户知道「这条命令是干嘛的、怎么传参、有什么注意点」。信息来源优先级：

1. **`package.json` 里 script 旁边的注释**（JSON 不支持注释，但有些项目用 `//` key 当注释，如 `"//": "下面是构建命令"`）。
2. **`README.md` / `CONTRIBUTING.md` / `AGENTS.md` / `CLAUDE.md`** 里对该脚本的说明段落——这是最权威的来源，直接转述。
3. **脚本本身**（如 `scripts/set-version.mjs`）的头部注释和 `--help` 输出。
4. **`.github/workflows/*.yml`** 里调用该脚本时的上下文注释。
5. **script 值本身**：如 `"release": "tauri build --target universal-apple-darwin && ..."` 能推出「构建 universal dmg 并拷贝」，可据此推断用途，但要标注是推断。

**提取内容模板**（每条脚本至少回答前两项）：
- **用途**：这条命令做什么？
- **调用方法**：怎么跑？有没有必填/可选参数？
- **注意点**（可选）：慢、有副作用、未签名、需前置条件等坑。

**不要**：
- 不要把 script 的原始 shell 值原样复制粘贴（`"tauri build --target universal-apple-darwin && mkdir -p release && cp ..."`）——提炼成一句话说明。
- 不要编造脚本不支持的参数（如 `--force`、`--verbose`）。不确定就不写。
- 不要给每条脚本都写一大段——常用、有坑、有参数的详写，`npm install` 这种不言自明的简写或省略。

## 生成原则

1. **分节**：每个职能一个 `##` 标题（会进 TOC），每节包含「markdown 说明 + 一个 buttons 围栏」。别把所有命令堆一个围栏。
2. **文档 + 按钮配对**：每节的 markdown 主体先解释这组脚本「做什么、怎么选、有哪些坑」，再用 buttons 围栏给出"一键执行"的按钮。**说明放文档、执行放按钮，职责分开**。
3. **标签**：中文、动词开头、2-6 字。长命令必加 ` # 短标签`，短命令（`npm test`）可省。
4. **危险命令**（`reset --hard`、`clean -fd`、force push）：加 ` // edit`，前面放 `// ⚠️ 危险` 文本。
5. **模板命令**（`-m ""`、需改参数）：加 ` // edit`，或用 buttons-json 让用户填参。
6. **顶层一个 `#` 标题**，可跟一句简介（技术栈/项目类型）。

## 完整示例

````markdown
# my-app 速查

> Vite + TypeScript 前端项目。

## 开发

`dev` 是日常开发主入口，同时起 Vite dev server 和 HMR。
只想调 UI 不碰原生层时用 `dev:web` 更轻（无原生窗口）。

```buttons
npm install      # 安装依赖
npm run dev      # 启动 dev server
npm run dev:web  # 仅前端 dev server
```

## 构建与质量

`build` 走生产构建；`typecheck` 改动前必跑确认类型基线。

```buttons
npm run build       # 生产构建
npm run typecheck   # 类型检查
```

## 版本管理

改版本号一律用 `version:set` 脚本，会同步四处（package.json / Cargo.toml / tauri.conf.json / Cargo.lock）。
手动逐个改极易漏 Cargo.lock。支持 `--dry-run` 预览。

```buttons-json
[
  {
    "label": "设置版本号",
    "command": "npm run version:set {{version}}",
    "params": [
      { "name": "version", "hint": "如 0.9.4", "required": true }
    ]
  }
]
```

## 紧急操作

```buttons
// ⚠️ 不可逆，确认后再回车
git reset --hard HEAD~1  // edit  # 撤销最近提交
git clean -fd           // edit   # 删除未跟踪文件
```
````

## 自查清单

**help.md**：
- [ ] 围栏语言精确为 `buttons` / `buttons-json`
- [ ] ` // edit` 有前导空格；行首 `//` 文本 / `#` 注释
- [ ] buttons-json 是合法 JSON，`edit`/`required` 是 `true`
- [ ] `{{name}}` 两侧无引号，且在 `params` 里声明
- [ ] 每条命令有文件证据，未编造
- [ ] **主要脚本（package.json scripts / Makefile targets 等）在 markdown 主体有用途+调用方法说明**，不只是按钮
- [ ] 危险命令有 `// edit` + `// ⚠️`
- [ ] 中文标签、动词开头、简短
- [ ] 按职能分多个 `##` 节

**bundle JSON**：
- [ ] `version: 1`、`app: "TermStep"`、`tools` 是数组
- [ ] `mdUrl` 是 `termstep-help.md` 的**绝对路径**，扩展名 `.md`
- [ ] `useRemote: true`（远程模式必须显式开）
- [ ] `cwd` 是项目根**绝对路径**
- [ ] **`sourceId` 是标准 UUID**（`uuidgen` 生成；非短字符串/占位符），重新生成时复用旧值不改
- [ ] 未写 `id` / `order`（导入时生成）
- [ ] `helpMarkdown` 留空 `""`（远程模式不读）
- [ ] 是合法 JSON（导入前可 `node -e 'JSON.parse(...)'` 或 `jq .` 验证）

## 落地提示（告诉用户）

**方式 A：导入 bundle（推荐，一键装好）**
1. 打开 TermStep → 侧栏底部「导入」
2. 选 `termstep-tool.json` → 确认风险提示（含 mdUrl+cwd，正常）
3. 工具建立，cwd 已设好、帮助页指向 `termstep-help.md`
4. **改命令**：直接编辑 `termstep-help.md`，TermStep 下次打开工具即刷新（或点「重新读取」）

**方式 B：手粘帮助页（适合已有工具）**
1. 在 TermStep 选/建一个工具，cwd 设到项目根
2. 编辑该工具的帮助页
3. 粘贴 `termstep-help.md` 全文，保存

---

## 维护约定（本 skill 的来源与发布）

**本项目 `/Users/sunknight/web/code/sk_ideas/termstep` 是此 skill 的权威来源**：
- 源文件：`skills/termstep-tool-gen/SKILL.md`（纳入 git 版本控制）。
- 发布位置：`~/.zcode/skills/termstep-tool-gen/SKILL.md`（ZCode 用户级 skill 目录，跨项目可用）。

**更新流程**（每次改 skill 都按此走）：
1. **先改项目源** `skills/termstep-tool-gen/SKILL.md`，提交进 git（保留历史）。
2. **再同步发布**：把项目源整份覆盖到 `~/.zcode/skills/termstep-tool-gen/SKILL.md`。
   ```bash
   cp /Users/sunknight/web/code/sk_ideas/termstep/skills/termstep-tool-gen/SKILL.md \
      /Users/sunknight/.zcode/skills/termstep-tool-gen/SKILL.md
   ```
3. 验证 frontmatter 的 `name` 与目录名一致（`termstep-tool-gen`），`description` 简短且包含触发词。

**不要**直接改 `~/.zcode/skills/` 里的副本——会脱离版本控制、丢失历史。

---

**权威语法参考**：`/Users/sunknight/web/code/sk_ideas/termstep/docs/termstep-tool-gen.md`（更详细的规则、易错点、命令挖掘细则）。语法疑问时以 TermStep 源码 `src/shared/buttonBlock.ts` 为准；bundle 格式以 `src/shared/bundle.ts` 的 `ToolsBundle` / `parseToolsBundle` 为准。
