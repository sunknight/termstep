# 工具主目录占位符（`@/`）设计

- **日期**：2026-07-18
- **目标**：在 buttons 命令按钮里增加一个表示「工具主目录」的语法 `@/`，让作者写 `cd @/a` 即可从任意当前目录切到工具主目录下的 `a` 子目录。语义对标家目录 `~`，但锚点是工具的 `meta.cwd` 而非用户家目录。
- **范围**：纯渲染端文本替换。不碰后端、不碰 pty。仅在点击按钮执行/粘贴命令的瞬间做替换。

---

## 1. 决策摘要

| 主题 | 决策 |
|---|---|
| 语法 | `@/` —— 后跟 `/` 或行尾时触发替换（前缀形态）。对标 `~/`，记忆负担为零：`~`=家，`@`=工具根 |
| 替换层 | 渲染端 `shared/buttonBlock.ts` 新增 `substituteCwd()`；在点击执行链路上调用一次。后端 `pure.rs` 不需要改动（不影响执行） |
| 触发条件 | **严格 `@/` 前缀形态**：`@/` 紧跟 `/`，或 `@/` 在命令末尾。孤立 `@`（如 `git show @`、`git rebase @`、`echo @file`）不替换 |
| 空 cwd 行为 | 退化为家目录 `~/`（与 pty spawn 时 `unwrap_or_else(home)` 行为一致）。不在按钮上报错 |
| 引号内 `@/` | 无脑替换（与 `{{name}}` 参数占位符行为一致）。作者要打印字面 `@/` 就避开此写法 |
| 替换顺序 | `substituteParams`（参数）→ `substituteCwd`（工具根）。避免参数值里的 `@/` 被二次处理 |
| 调用点 | `HelpPane.tsx`（2 处）+ `QuickCommands.tsx`（2 处），共 4 个 `runCommandChecked` 调用前 |
| 后端对偶 | **不需要**。`pure.rs` 的 `merge/serialize/parse/scan_tool_risk` 都不涉及执行期命令文本；`@/` 是纯渲染期概念 |

### 为什么选 `@/`

1. **与 `~` 对称**：家目录是 `~/`，工具根是 `@/`。一句话能讲完，记忆负担为零。
2. **前端生态已有约定**：Vite/npm/Hugo/JetBrains 都用 `@/` 表示「项目根」，应用外读者（GitHub、`cat`、编辑器）一眼能猜到语义。
3. **避开 shell 元字符**：`@` 在 bash/zsh 里不是元字符；`git` 的 `@` 是 HEAD 简写，但那只在**孤立 `@`**（空格后独立成词）时出现。我们只在 `@/` 形态触发，不会误伤。

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

**替换例**：

| 输入 | 替换后（cwd = `/Users/x/proj`） |
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

`@/` 后无任何字符（命令以 `@/` 结尾，如 `cd @/`）→ 替换成 cwd 本身，末尾斜杠由原命令的 `/` 提供 → 结果 `/Users/x/proj/`。行为一致、可预测。

---

## 3. cwd 解析

替换用的 cwd 值来自 `meta.cwd`，需要做 `~` 展开（与后端 `pty.rs: expand_home` 对齐）：

```ts
function expandHome(p: string | undefined): string {
  if (!p) return homedir();          // 空 cwd → 家目录
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}
```

`homedir()` 在渲染端取 `api` 暴露的值，或直接用现有路径（见 §4 落地点）。**空 cwd 退化为家目录**——与 `pty.rs:118-126` 的 spawn 行为一致：pty spawn 时 cwd 空也是 fallback 到 home，按钮替换保持同一来源真相，避免「按钮跑了家目录，但新 shell 在别处」的错位。

---

## 4. 落地点

### 4.1 新增 `substituteCwd`（`src/shared/buttonBlock.ts`）

```ts
// 把命令里的「工具根」占位符 @/ 替换成展开后的 cwd 绝对路径。
// 触发规则：@/ 紧跟斜杠或位于字符串末尾，且 @ 左侧非 [A-Za-z0-9_]。
// 空 cwd 退化为家目录（与 pty spawn 行为一致）。
export function substituteCwd(command: string, cwd: string | undefined): string {
  const base = expandHome(cwd).replace(/\/+$/, ''); // 去尾斜杠，@/ 自带 /
  return command.replace(/(?<![A-Za-z0-9_])@\/(?=\/|$)/g, base);
}
```

正则解释：
- `(?<![A-Za-z0-9_])` —— `@` 左侧不能是字母/数字/下划线（排除 `foo@/x`）
- `@\/` —— 字面 `@/`
- `(?=\/|$)` —— 右侧必须是 `/` 或字符串结尾（即 `@/` 后要么紧跟路径分隔符，要么命令结束）

注意：`@/` 自带一个 `/`，所以 `base` 去尾斜杠后拼接结果 = `base + / + ...`，不会重复。

`expandHome` 复用 `previewLink.ts: resolveDocPath` 里同款的 `~` 展开逻辑——但那里是原样返回，这里需要真正展开。需要在渲染端拿到家目录路径。

**家目录来源**：渲染端没有直接的 `os.homedir()`。两个选项：
- (a) 新增 IPC `env:home` 暴露后端 `dirs::home_dir()`
- (b) 复用 `meta.cwd` 未配置时已有的 fallback——但渲染端不知道 home

**决策：走 (a)**，新增一个极轻量的 IPC `env:home` 返回家目录字符串。理由：`@/` 替换、未来的路径展示都可能用；后端 `dirs::home_dir()` 已是依赖，零成本。但**仅当确实需要时才调**（即 cwd 为空或 `~/` 开头时）——多数情况 cwd 已配置，不需要查 home。

> **简化**：若想避免新增 IPC，可以让 `substituteCwd` 接收「已展开的 cwd 绝对路径」而非 `meta.cwd` 原值，由调用方负责展开。但调用方（HelpPane/QuickCommands）同样拿不到 home，问题没消失。所以仍需 IPC。这是本设计唯一的后端改动（一行命令）。

### 4.2 调用点（4 处）

在 `substituteParams` 之后、`runCommandChecked` 之前包一层：

**`src/renderer/components/HelpPane.tsx`**：
- 第 193 行（参数按钮）：`runCommandChecked(id, substituteParams(command, values), edit, opts)` → 外层包 `substituteCwd(..., props.tool.meta.cwd)`
- 第 197 行（普通按钮）：`runCommandChecked(id, command, edit, opts)` → 包 `substituteCwd(command, props.tool.meta.cwd)`

**`src/renderer/components/QuickCommands.tsx`**：
- 第 70 行（参数按钮）、第 74 行（普通按钮）：同理，cwd 用 `a.meta.cwd`。

### 4.3 不需要改的地方

- `buttonBlock.ts` 的 `parseButtonLine` / `renderButtonsBlock`：`@/` 是执行期概念，按钮 label/tooltip 显示原样 `cd @/a` 即可（短、可读）。
- 后端 `pure.rs`：不涉及执行期命令文本。
- `pty.rs`：拿到的是已替换好的绝对路径，无感知。
- `dangerous.ts` 的危险命令检测：替换**前**检测还是**后**检测？**替换前**——即检测 `cd @/a` 原文。理由：危险模式（`rm -rf @/`）在替换前后风险一致；若在替换后检测，`rm -rf @/` 会变成 `rm -rf /Users/x/proj/`，反而可能误判为「删家目录子目录」触发不必要的 confirm。保持替换前检测，作者写什么就检测什么。

> 注：当前 `runCommandChecked` 在 `substituteParams` 之后调用，检测的是参数替换后的命令。为一致，`substituteCwd` 也放在检测**之后**（即检测参数替换后、cwd 替换前的文本）。调整后顺序：`substituteParams` → `isDangerousCommand` 检测 → `substituteCwd` → `runCommand`。

---

## 5. 测试

`tests/buttonBlock.test.ts` 新增 `substituteCwd` 测试组：

1. 基本：`substituteCwd('cd @/a', '/p')` → `'cd /p/a'`
2. 多次：`substituteCwd('ls @/x @/y', '/p')` → `'ls /p/x /p/y'`
3. 行尾 `@/`：`substituteCwd('cd @/', '/p')` → `'cd /p/'`
4. 不替换孤立 `@`：`substituteCwd('git show @', '/p')` → `'git show @'`
5. 不替换 `@~`：`substituteCwd('git rebase @~1', '/p')` → `'git rebase @~1'`
6. 不替换词中：`substituteCwd('echo me@/x', '/p')` → `'echo me@/x'`
7. 空 cwd 退化家目录：`substituteCwd('cd @/a', undefined)` → `'cd <home>/a'`
8. cwd 带 `~`：`substituteCwd('cd @/a', '~/proj')` → `'cd <home>/proj/a'`
9. cwd 去尾斜杠：`substituteCwd('cd @/a', '/p/')` → `'cd /p/a'`（不重复斜杠）

---

## 6. 文档

buttons 帮助页（`seed.rs` 默认工具的帮助或用户手册）补一段：

> **`@/` = 工具主目录**。类似家目录 `~`，但锚点是工具的「工作目录」配置。例：`cd @/src` 从任意目录切到工具主目录下的 `src`。空工作目录时退化为家目录。

---

## 7. 不在范围

- 其他占位符（如 `@@` 表示别的资源根、`@group/` 跨工具引用）—— YAGNI。
- `@/` 在 markdown 正文/链接里的替换 —— 本设计仅限 buttons 命令。文档链接已用 `resolveDocPath` 基于相对路径解析，不需要 `@/`。
- 后端命令记录 / vcs 快照里的 `@/` 保留原样（记录的是作者写的文本，不是替换后）。
