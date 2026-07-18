# 工具主目录占位符（`@/`）设计

- **日期**：2026-07-18
- **目标**：在 buttons 命令按钮里增加一个表示「工具主目录」的语法 `@/`，让作者写 `cd @/a` 即可从任意当前目录切到工具主目录下的 `a` 子目录。语义对标家目录 `~`，但锚点是工具的「工具根目录」而非用户家目录。
- **范围**：①新增可选 `ToolMeta.rootDir` 字段（`@/` 的锚点）；②渲染端 `substituteCwd` 文本替换。`@/` 优先级 = `rootDir > cwd > ~`。后端不涉及执行期命令文本（`@/` 是纯渲染期概念），但需要存储/透传新字段。

---

## 1. 决策摘要

| 主题 | 决策 |
|---|---|
| 语法 | `@/` —— 后跟 `/` 或行尾时触发替换（前缀形态）。对标 `~/`，记忆负担为零：`~`=家，`@`=工具根 |
| 锚点来源 | 新增可选 `ToolMeta.rootDir` 字段。**优先级 `rootDir > cwd > ~`**：配了 rootDir 用它，否则用 cwd，都空则吐 `~` |
| 字段命名 | `rootDir`（明确语义：「工具根」，区别于「启动目录 cwd」） |
| 替换层 | 渲染端 `shared/buttonBlock.ts` 新增 `substituteCwd()`；在点击执行链路上调用一次。后端**不新增 IPC** |
| 触发条件 | **严格 `@/` 前缀形态**：`@/` 紧跟 `/`，或 `@/` 在命令末尾。孤立 `@`（如 `git show @`、`git rebase @`、`echo @file`）不替换 |
| 空 rootDir + 空 cwd | 吐 `~`，让 shell 自己展开家目录（远程工具时为远端家目录） |
| 引号内 `@/` | 无脑替换（与 `{{name}}` 参数占位符行为一致）。作者要打印字面 `@/` 就避开此写法 |
| 替换顺序 | `substituteParams`（参数）→ 危险命令检测 → `substituteCwd`（工具根）。避免参数值里的 `@/` 被二次处理 |
| 调用点 | `HelpPane.tsx`（2 处）+ `QuickCommands.tsx`（2 处），共 4 个 `runCommandChecked` 调用前 |
| 后端改动 | `types.rs` + `pure.rs`（merge/serialize/parse/scan_tool_risk）加 `rootDir` 字段透传。**不涉及执行期**：pty spawn 仍用 cwd，rootDir 只给渲染端替换用 |
| 编辑器 UI | `EditorPane` 终端 fieldset 加一个「工具根目录 (@/)」输入框，placeholder 提示「留空同 cwd」 |

### 为什么选 `@/`

1. **与 `~` 对称**：家目录是 `~/`，工具根是 `@/`。一句话能讲完，记忆负担为零。
2. **前端生态已有约定**：Vite/npm/Hugo/JetBrains 都用 `@/` 表示「项目根」，应用外读者（GitHub、`cat`、编辑器）一眼能猜到语义。
3. **避开 shell 元字符**：`@` 在 bash/zsh 里不是元字符；`git` 的 `@` 是 HEAD 简写，但那只在**孤立 `@`**（空格后独立成词）时出现。我们只在 `@/` 形态触发，不会误伤。

### 为什么新增独立的 `rootDir` 而非直接用 cwd

用户决策：**把「工具根锚点」和「启动目录」解耦**。优先级 `rootDir > cwd > ~`。

关键场景：**远端工具**。工具可能 ssh 到远端服务器，cwd 配的是远端启动目录（如 `~`），但用户希望 `@/` 指向一个固定的远端项目根（如 `~/projects/api`）。若 `@/` 锚定 cwd，二者无法分离；新增独立字段后：

| 配置 | `@/` 展开为 | 适用场景 |
|---|---|---|
| 不配 rootDir，cwd = `/p` | `/p`（同 cwd） | 本地单项目工具，最常见，零配置 |
| rootDir = `/srv/api`，cwd = `~` | `/srv/api` | 远端工具：shell 启动在家目录，但 `@/` 锁定项目根 |
| rootDir = `~/proj`，cwd = `~/proj` | `~/proj` | 冗余但合法；不配 rootDir 效果相同 |
| 都不配 | `~` | 启动即家目录，`@/` 也退化家 |

默认行为（不配 rootDir）完全等同「`@/` = cwd」，老用户零感知。

### 为什么不用 `{{cwd}}` 参数语法

- 太长太重，用户要的是一个字符（像 `~`）。
- 语义混淆：`{{name}}` = 「弹表单问用户」，`{{cwd}}` = 「自动填工具路径」。两套语义塞同一语法会让作者/读者都困惑。

### 为什么不在远程服务器上 export 环境变量

用户已排除：远程服务器上根本没有这个变量，且 export 时机不对（命令已发到远端 shell，环境变量来不及注入）。替换**必须在 TermStep 渲染端完成**，把绝对路径喂给 pty。

---

## 2. 触发规则（精确）

用一个正则定义「需要替换的 `@/`」：

```
@/   且左侧非 [A-Za-z0-9_]   且   右侧是 / 或 字符串结尾
```

等价于：`@/` 出现在「词首」位置（前一个字符是空白、命令起始、或无前缀），且紧跟斜杠或位于末尾。

**替换例**（设锚点 = `/Users/x/proj`，即 rootDir 或 cwd 解析后的值）：

| 输入 | 替换后 |
|---|---|
| `cd @/a` | `cd /Users/x/proj/a` |
| `ls @/src @/test` | `ls /Users/x/proj/src /Users/x/proj/test` |
| `cd @/` | `cd /Users/x/proj/`（行尾 `@/` 触发，末尾 `/` 来自原文） |
| `cd @/.` | `cd /Users/x/proj/.`（表达「工具根本身」的推荐写法） |

**不替换例**：

| 输入 | 原因 |
|---|---|
| `git show @` | `@` 不跟 `/` → 不替换（避免与 git HEAD 简写冲突） |
| `git rebase @~1` | `@~1` 不是 `@/` 形态 → 不替换 |
| `npm --prefix @ run build` | `@` 不跟 `/` → 不替换 |
| `echo @file` | `@file` 不是 `@/` → 不替换 |
| `foo@/bar`（如 email 或 ssh host） | `@` 左侧是 `o`（词中）→ 不替换 |
| `email me@/x` | `me@/x` 中 `@` 左侧是 `e` → 不替换 |

### 边界澄清：`@` 单独成词

为避免与 git 的 `@`（HEAD 简写）冲突，**仅当 `@` 后紧跟 `/` 时触发**。孤立 `@`（如 `git show @`、`npm --prefix @`）**一律不替换**——即便它在行尾。

要表达「工具根本身（不带子路径）」，作者应写 `@/`（带尾斜杠，如 `cd @/`）或 `@/.`（如 `cd @/.`）。

### 行尾 `@/` 的行为

`@/` 后无任何字符（命令以 `@/` 结尾，如 `cd @/`）→ 替换成锚点本身，末尾斜杠由原命令的 `/` 提供。行为一致、可预测。

---

## 3. 锚点解析：交给 shell，不自己展开

关键洞察：`@/` 替换后的命令是**粘进终端**的（`runCommand` → `term.paste()`），不是 `CommandBuilder::cwd()`。因此 shell（zsh/bash）自己会展开 `~`，渲染端**不需要也不应该**自己展开家目录。

### 3.1 锚点优先级

`@/` 的展开值按优先级 `rootDir > cwd > ~` 选取：

```ts
function resolveAnchor(rootDir?: string, cwd?: string): string {
  const r = rootDir?.trim();
  if (r) return r.replace(/\/+$/, '');
  const c = cwd?.trim();
  if (c) return c.replace(/\/+$/, '');
  return '~';
}
```

替换规则表：

| `rootDir` | `cwd` | `@/` 替换为 | 例（`cd @/a`） |
|---|---|---|---|
| `/srv/api` | （任意） | `/srv/api` | `cd /srv/api/a` |
| 空 / 缺失 | `/Users/x/proj` | `/Users/x/proj` | `cd /Users/x/proj/a` |
| 空 / 缺失 | `~/proj` | `~/proj`（原样） | `cd ~/proj/a`（shell 展开） |
| 空 / 缺失 | 空 / 缺失 | `~` | `cd ~/a`（shell 展开家） |

**为什么空锚点直接吐 `~` 而非展开成绝对路径**：

1. **零 IPC**：渲染端不需要知道家目录是什么，直接吐 `~` 字面量。无需新增 `env:home` 或复用 `pty_cwd`。
2. **远程场景天然正确**：对 ssh 到远端的工具，`~/` 会被**远端 shell** 展开成远端家目录——这恰是用户想要的（`@/` 在远程工具上表示远端家）。若渲染端硬展开成本地 `/Users/x`，粘到远端就是错路径。
3. **与 pty spawn 同源**：pty spawn 时 cwd 空也 fallback 到 home（`pty.rs:122-125`）；`~` 进了 shell 也是 home。两路一致。
4. **配置的锚点可能含 `~`**：用户本来就常把路径配成 `~/proj`。原样吐回 `~/proj`，让 shell 统一展开，避免渲染端再实现一份 `expand_home`（后端 `pty.rs:19-31` 已有对偶实现，渲染端不必重复）。

### 3.2 为什么 rootDir 只参与 `@/` 替换，不影响 pty spawn

`rootDir` 是**给按钮作者用的锚点**，不是 shell 启动目录。pty spawn 仍用 `cwd`（`pty.rs:118-126`），`rootDir` 不传给后端 spawn 逻辑。理由：

- **职责分离**：cwd = shell 落地目录；rootDir = 按钮里的「工具根」语义锚。二者本就可以不同（远端工具：shell 落在家，按钮锁项目根）。
- **避免破坏现有行为**：spawn 逻辑、live cwd 轮询、vcs 快照都基于 cwd，rootDir 不掺和。
- **rootDir 为空时完全等同 cwd**：老用户零感知，零迁移。

> 注：`meta.cwd` 在 spawn 时由后端 `expand_home` 展开（`pty.rs:121`）；`@/` 粘进终端后 shell 再展一次 `~`。rootDir 若是绝对路径则原样，若是 `~/...` 同样交给 shell。

---

## 4. 落地点

### 4.1 数据模型：新增 `ToolMeta.rootDir`

**`src/shared/types.ts`**（渲染端 + 共享）：

```ts
export interface ToolMeta {
  // ... 现有字段
  cwd?: string;
  /** `@/` 占位符的锚点（工具根目录）。优先级 rootDir > cwd > ~。
   *  为空/缺失时 @/ 退化为 cwd，再退化为 ~（shell 展开）。
   *  不影响 pty spawn（spawn 仍用 cwd）。 */
  rootDir?: string;
  // ...
}
```

**`src-tauri/src/types.rs`**（后端对偶）：`ToolMeta` struct 加 `pub root_dir: Option<String>`。

### 4.2 后端透传（`src-tauri/src/pure.rs`）

四个函数各加一处 `rootDir` 处理，与现有 `cwd` 完全对称：

- `merge_tool_json`：patch 里若 `rootDir` 键存在，按 cwd 同款 trim/prune 逻辑写入（空串 → 删键）。
- `serialize_meta`：`root_dir` 非空时序列化成 `"rootDir"`（camelCase，与 cwd/mdUrl/group 一致）。
- `parse_tool_meta`：读 `rootDir` 键，trim 后赋给 `root_dir`。
- `scan_tool_risk`：**不**把 rootDir 列入风险字段（它只是路径配置，不执行，不像 initCommands/mdUrl/shell 那样有注入风险）。

`pty.rs` **不改**：rootDir 不参与 spawn。

### 4.3 新增 `substituteCwd`（`src/shared/buttonBlock.ts`）

```ts
// 把命令里的「工具根」占位符 @/ 替换成工具锚点（rootDir > cwd > ~）。
// 触发规则：@/ 紧跟斜杠或位于字符串末尾，且 @ 左侧非 [A-Za-z0-9_]。
// 锚点为空时吐 ~，让 shell 自己展开家目录（远程工具时为远端家目录）。
export function substituteCwd(command: string, rootDir?: string, cwd?: string): string {
  const base = resolveAnchor(rootDir, cwd);
  return command.replace(/(?<![A-Za-z0-9_])@\/(?=\/|$)/g, base);
}

function resolveAnchor(rootDir?: string, cwd?: string): string {
  const r = rootDir?.trim();
  if (r) return r.replace(/\/+$/, '');
  const c = cwd?.trim();
  if (c) return c.replace(/\/+$/, '');
  return '~';
}
```

正则解释：
- `(?<![A-Za-z0-9_])` —— `@` 左侧不能是字母/数字/下划线（排除 `foo@/x`）
- `@\/` —— 字面 `@/`
- `(?=\/|$)` —— 右侧必须是 `/` 或字符串结尾（即 `@/` 后要么紧跟路径分隔符，要么命令结束）

注意：`@/` 自带一个 `/`，所以 `base` 去尾斜杠后拼接结果 = `base + / + ...`，不会重复。

**不展开 `~`**：锚点可能是 `~/proj`，原样吐回让 shell 展开。渲染端不实现 `expand_home`（后端 `pty.rs:19` 已有对偶，无需重复）。`substituteCwd` 是纯字符串替换，不依赖任何 IPC。

### 4.4 调用点（4 处）

在 `substituteParams` 之后、`runCommandChecked` 之前包一层。传 `rootDir` 和 `cwd` 两个参数：

**`src/renderer/components/HelpPane.tsx`**：
- 第 193 行（参数按钮）：外层包 `substituteCwd(cmd, props.tool.meta.rootDir, props.tool.meta.cwd)`
- 第 197 行（普通按钮）：包 `substituteCwd(command, props.tool.meta.rootDir, props.tool.meta.cwd)`

**`src/renderer/components/QuickCommands.tsx`**：
- 第 70 行（参数按钮）、第 74 行（普通按钮）：同理，用 `a.meta.rootDir` + `a.meta.cwd`。

### 4.5 编辑器 UI（`src/renderer/components/EditorPane.tsx`）

终端 fieldset 里，在「起始目录 (cwd)」下方加一个输入框：

```tsx
<label className="field">
  <span className="field-label">
    工具根目录 (@/) <em>留空同 cwd；按钮里 @/ 锚定此目录</em>
  </span>
  <input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="留空同 cwd" />
</label>
```

state：`const [rootDir, setRootDir] = useState(meta.rootDir ?? '');`
保存：`rootDir: rootDir.trim()`（空串由后端 prune）。

### 4.6 不需要改的地方

- `buttonBlock.ts` 的 `parseButtonLine` / `renderButtonsBlock`：`@/` 是执行期概念，按钮 label/tooltip 显示原样 `cd @/a` 即可（短、可读）。
- `pty.rs`：拿到的是已替换好的绝对路径，无感知；spawn 仍用 cwd。
- `dangerous.ts` 的危险命令检测：**替换前**检测原文。理由：危险模式（`rm -rf @/`）在替换前后风险一致；若替换后检测，`rm -rf @/` 变成 `rm -rf /srv/api/` 反而可能误判为「删项目目录」触发不必要的 confirm。保持替换前检测，作者写什么就检测什么。

> 顺序：`substituteParams` → `isDangerousCommand` 检测 → `substituteCwd` → `runCommand`。

---

## 5. 测试

### 5.1 `tests/buttonBlock.test.ts` 新增 `substituteCwd` 测试组

1. 基本：`substituteCwd('cd @/a', undefined, '/p')` → `'cd /p/a'`
2. 多次：`substituteCwd('ls @/x @/y', undefined, '/p')` → `'ls /p/x /p/y'`
3. 行尾 `@/`：`substituteCwd('cd @/', undefined, '/p')` → `'cd /p/'`
4. 不替换孤立 `@`：`substituteCwd('git show @', undefined, '/p')` → `'git show @'`
5. 不替换 `@~`：`substituteCwd('git rebase @~1', undefined, '/p')` → `'git rebase @~1'`
6. 不替换词中：`substituteCwd('echo me@/x', undefined, '/p')` → `'echo me@/x'`
7. **rootDir 优先**：`substituteCwd('cd @/a', '/srv/api', '/p')` → `'cd /srv/api/a'`
8. **rootDir 空退 cwd**：`substituteCwd('cd @/a', undefined, '/p')` → `'cd /p/a'`
9. **rootDir 空串退 cwd**：`substituteCwd('cd @/a', '  ', '/p')` → `'cd /p/a'`
10. **都空吐 ~**：`substituteCwd('cd @/a', undefined, undefined)` → `'cd ~/a'`
11. **都空串吐 ~**：`substituteCwd('cd @/a', '', '')` → `'cd ~/a'`
12. **锚点带 ~**：`substituteCwd('cd @/a', undefined, '~/proj')` → `'cd ~/proj/a'`
13. **锚点带 ~（rootDir）**：`substituteCwd('cd @/a', '~/api', '/p')` → `'cd ~/api/a'`
14. 去尾斜杠：`substituteCwd('cd @/a', '/srv/', undefined)` → `'cd /srv/a'`

### 5.2 Rust 测试（`src-tauri/src/pure.rs`）

- `parse_tool_meta` 读到 `rootDir` 字段 → `meta.root_dir == Some(...)`
- `serialize_meta` 把 `root_dir` 写成 `rootDir`（camelCase）
- `merge_tool_json`：patch 含 `rootDir` → 写入；patch `rootDir: ""` → 删键
- `scan_tool_risk`：配置了 rootDir **不**增加风险字段

---

## 6. 文档

buttons 帮助页（`seed.rs` 默认工具的帮助或用户手册）补一段：

> **`@/` = 工具根目录**。类似家目录 `~`，但锚点是工具的「工具根目录」（编辑器可配，留空同 cwd）。例：`cd @/src` 从任意目录切到工具根下的 `src`。远端工具可把 rootDir 配成项目根、cwd 配成家目录，实现「shell 落地在家，按钮锁定项目」。

---

## 7. 不在范围

- **多命名锚点**（如 `@api/`、`@web/` 指向不同目录）—— YAGNI。本设计仅单一 `@/` 锚点，通过 rootDir/cwd 选取。多锚点等真实需求出现再加。
- 其他占位符（如 `@@` 表示别的资源根、`@group/` 跨工具引用）—— YAGNI。
- `@/` 在 markdown 正文/链接里的替换 —— 本设计仅限 buttons 命令。文档链接已用 `resolveDocPath` 基于相对路径解析，不需要 `@/`。
- 后端命令记录 / vcs 快照里的 `@/` 保留原样（记录的是作者写的文本，不是替换后）。
- rootDir 影响 pty spawn —— 明确不做。rootDir 只参与 `@/` 替换，spawn/live-cwd/vcs 一律用 cwd。
