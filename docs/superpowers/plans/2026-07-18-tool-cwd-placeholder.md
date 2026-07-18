# 工具主目录占位符（`@/`）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 buttons 命令按钮里支持 `@/` 占位符，点击时替换成工具锚点（优先级 `rootDir > cwd > ~`），让作者写 `cd @/a` 即可从任意目录切到工具根下的 `a`。

**Architecture:** ①数据层：`ToolMeta` 新增可选 `rootDir` 字段（前后端对偶，与 `cwd` 完全对称的 trim/prune/serialize/parse 处理，不进风险扫描，不参与 pty spawn）。②替换层：`shared/buttonBlock.ts` 新增纯函数 `substituteCwd`，正则匹配 `@/` 词首前缀，替换成锚点。③接入层：4 个 `runCommandChecked` 调用点 + 1 个编辑器输入框。④文档：帮助页补说明。

**Tech Stack:** TypeScript（渲染端 + shared）、Rust（后端对偶类型与纯函数）、Vitest（node 测试）、Cargo test（Rust 测试）。

**Spec:** `docs/superpowers/specs/2026-07-18-tool-cwd-placeholder-design.md`

---

## 文件结构

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/shared/buttonBlock.ts` | 新增 `substituteCwd` + `resolveAnchor` 纯函数 | 新增 |
| `src/shared/types.ts` | `ToolMeta` 加 `rootDir?` 字段 | 修改 |
| `src/shared/toolJson.ts` | `PRUNE_WHEN_EMPTY_STRING` 数组加 `rootDir` | 修改（1 行） |
| `src/shared/toolConfig.ts` | `parseToolMeta` 读 `rootDir` | 修改（2 行） |
| `src/renderer/components/HelpPane.tsx` | 2 处 `runCommandChecked` 前包 `substituteCwd` | 修改 |
| `src/renderer/components/QuickCommands.tsx` | 2 处 `runCommandChecked` 前包 `substituteCwd` | 修改 |
| `src/renderer/components/EditorPane.tsx` | 终端 fieldset 加「工具根目录 (@/)」输入框 | 修改 |
| `src-tauri/src/types.rs` | `ToolMeta` struct 加 `root_dir: Option<String>` | 修改 |
| `src-tauri/src/pure.rs` | merge/parse 加 `rootDir`；`scan_tool_risk` 不动 | 修改 |
| `tests/buttonBlock.test.ts` | `substituteCwd` 测试组 | 新增 |
| `tests/toolJson.test.ts` | `rootDir` prune 测试 | 新增 |
| `tests/toolConfig.test.ts` | `rootDir` parse 测试 | 新增 |
| `src-tauri/src/pure.rs`（`#[cfg(test)]`） | Rust 对偶测试 | 新增 |

---

## Task 1：`substituteCwd` + `resolveAnchor` 纯函数（TDD）

**Files:**
- Modify: `src/shared/buttonBlock.ts`（文件末尾追加）
- Test: `tests/buttonBlock.test.ts`

- [ ] **Step 1：写失败的测试**

在 `tests/buttonBlock.test.ts` 文件末尾追加新测试组。先把 import 行更新（在现有 import 末尾加 `substituteCwd`）：

```ts
import { parseButtonLine, renderButtonsBlock, parseButtonsFromMarkdown, escapeHtml, escapeAttr, parseButtonsJson, renderButtonsJsonBlock, buildMdAppend, substituteCwd } from '../src/shared/buttonBlock';
```

在文件末尾追加：

```ts
describe('substituteCwd', () => {
  it('replaces @/ with cwd when rootDir absent', () => {
    expect(substituteCwd('cd @/a', undefined, '/p')).toBe('cd /p/a');
  });

  it('replaces multiple @/ occurrences', () => {
    expect(substituteCwd('ls @/x @/y', undefined, '/p')).toBe('ls /p/x /p/y');
  });

  it('trailing @/ keeps the slash from original', () => {
    expect(substituteCwd('cd @/', undefined, '/p')).toBe('cd /p/');
  });

  it('does not replace standalone @ (git HEAD shorthand)', () => {
    expect(substituteCwd('git show @', undefined, '/p')).toBe('git show @');
  });

  it('does not replace @~1 (git rebase)', () => {
    expect(substituteCwd('git rebase @~1', undefined, '/p')).toBe('git rebase @~1');
  });

  it('does not replace @ not followed by /', () => {
    expect(substituteCwd('npm --prefix @ run build', undefined, '/p')).toBe('npm --prefix @ run build');
  });

  it('does not replace @/ in the middle of a word', () => {
    expect(substituteCwd('echo me@/x', undefined, '/p')).toBe('echo me@/x');
  });

  it('rootDir takes priority over cwd', () => {
    expect(substituteCwd('cd @/a', '/srv/api', '/p')).toBe('cd /srv/api/a');
  });

  it('empty string rootDir falls back to cwd', () => {
    expect(substituteCwd('cd @/a', '', '/p')).toBe('cd /p/a');
  });

  it('whitespace-only rootDir falls back to cwd', () => {
    expect(substituteCwd('cd @/a', '  ', '/p')).toBe('cd /p/a');
  });

  it('both empty -> ~', () => {
    expect(substituteCwd('cd @/a', undefined, undefined)).toBe('cd ~/a');
  });

  it('both empty string -> ~', () => {
    expect(substituteCwd('cd @/a', '', '')).toBe('cd ~/a');
  });

  it('cwd with ~ kept verbatim for shell to expand', () => {
    expect(substituteCwd('cd @/a', undefined, '~/proj')).toBe('cd ~/proj/a');
  });

  it('rootDir with ~ kept verbatim', () => {
    expect(substituteCwd('cd @/a', '~/api', '/p')).toBe('cd ~/api/a');
  });

  it('trailing slash on anchor is trimmed', () => {
    expect(substituteCwd('cd @/a', '/srv/', undefined)).toBe('cd /srv/a');
  });
});
```

- [ ] **Step 2：运行测试，确认失败**

Run: `npx vitest run tests/buttonBlock.test.ts`
Expected: FAIL — `substituteCwd is not exported from '../src/shared/buttonBlock'`

- [ ] **Step 3：实现 `substituteCwd` + `resolveAnchor`**

在 `src/shared/buttonBlock.ts` 文件**末尾**追加（`renderButtonsJsonBlock` 函数之后）：

```ts
// 解析 @/ 占位符的锚点：优先级 rootDir > cwd > ~。
// 返回不含尾斜杠的锚点（或 ~）；@/ 自带一个 /，拼接不重复。
// 不展开 ~：锚点可能是 ~/proj，原样交给目标 shell 展开（远端工具时为远端家目录）。
function resolveAnchor(rootDir?: string, cwd?: string): string {
  const r = rootDir?.trim();
  if (r) return r.replace(/\/+$/, '');
  const c = cwd?.trim();
  if (c) return c.replace(/\/+$/, '');
  return '~';
}

// 把命令里的「工具根」占位符 @/ 替换成工具锚点（rootDir > cwd > ~）。
// 触发规则：@/ 紧跟斜杠或位于字符串末尾，且 @ 左侧非字母/数字/下划线。
// 锚点为空时吐 ~，让 shell 自己展开家目录（远程工具时为远端家目录）。
export function substituteCwd(command: string, rootDir?: string, cwd?: string): string {
  const base = resolveAnchor(rootDir, cwd);
  return command.replace(/(?<![A-Za-z0-9_])@\/(?=\/|$)/g, base);
}
```

- [ ] **Step 4：运行测试，确认通过**

Run: `npx vitest run tests/buttonBlock.test.ts`
Expected: PASS（所有 substituteCwd 用例 + 原有用例不回归）

- [ ] **Step 5：提交**

```bash
git add src/shared/buttonBlock.ts tests/buttonBlock.test.ts
git commit -m "feat(buttons): 新增 substituteCwd 替换 @/ 占位符

@/ 锚点优先级 rootDir > cwd > ~。纯渲染端文本替换，
不展开 ~，交给目标 shell 展开（远端工具天然正确）。"
```

---

## Task 2：`ToolMeta.rootDir` 字段（前端类型 + 解析 + merge）

**Files:**
- Modify: `src/shared/types.ts:38`（cwd 字段下方加 rootDir）
- Modify: `src/shared/toolConfig.ts:29`（parseToolMeta 读 rootDir）
- Modify: `src/shared/toolJson.ts:6`（PRUNE 数组加 rootDir）
- Test: `tests/toolConfig.test.ts`、`tests/toolJson.test.ts`

- [ ] **Step 1：写失败的 toolConfig 测试**

先看 `tests/toolConfig.test.ts` 现有 import 行（把 `parseToolMeta` 加入 if 缺失）。在文件末尾追加：

```ts
describe('parseToolMeta rootDir', () => {
  it('parses rootDir when present', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '/srv/api' }, 'x');
    expect(m.rootDir).toBe('/srv/api');
  });

  it('trims rootDir whitespace', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '  /srv/api  ' }, 'x');
    expect(m.rootDir).toBe('/srv/api');
  });

  it('drops blank rootDir', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '   ' }, 'x');
    expect(m.rootDir).toBeUndefined();
  });

  it('rootDir absent -> undefined', () => {
    const m = parseToolMeta({ name: 'A' }, 'x');
    expect(m.rootDir).toBeUndefined();
  });

  it('rootDir with ~ kept verbatim', () => {
    const m = parseToolMeta({ name: 'A', rootDir: '~/api' }, 'x');
    expect(m.rootDir).toBe('~/api');
  });
});
```

- [ ] **Step 2：写失败的 toolJson 测试**

在 `tests/toolJson.test.ts` 末尾追加（先确认 import 含 `mergeToolJson`）：

```ts
describe('mergeToolJson rootDir', () => {
  it('prunes cleared rootDir (empty string)', () => {
    const merged = mergeToolJson({ rootDir: '/srv/api' }, { rootDir: '' });
    expect(merged.rootDir).toBeUndefined();
  });

  it('keeps rootDir when set', () => {
    const merged = mergeToolJson({ name: 'A' }, { rootDir: '/srv/api' });
    expect(merged.rootDir).toBe('/srv/api');
  });

  it('keeps existing rootDir when patch does not touch it', () => {
    const merged = mergeToolJson({ name: 'A', rootDir: '/srv/api' }, { name: 'B' });
    expect(merged.rootDir).toBe('/srv/api');
  });
});
```

- [ ] **Step 3：运行测试，确认失败**

Run: `npx vitest run tests/toolConfig.test.ts tests/toolJson.test.ts`
Expected: FAIL — `rootDir` 类型未定义 / parse 不读它

- [ ] **Step 4：加 `ToolMeta.rootDir` 类型**

修改 `src/shared/types.ts`，在 `cwd?: string;`（第 38 行）下方加：

```ts
  cwd?: string;
  /** `@/` 占位符的锚点（工具根目录）。优先级 rootDir > cwd > ~。
   *  为空/缺失时 @/ 退化为 cwd，再退化为 ~（shell 展开）。
   *  不影响 pty spawn（spawn 仍用 cwd）。 */
  rootDir?: string;
```

- [ ] **Step 5：加 parseToolMeta 读 rootDir**

修改 `src/shared/toolConfig.ts`，在 `if (typeof o.cwd === 'string' && o.cwd.trim()) meta.cwd = o.cwd.trim();`（第 29 行）下方加一行：

```ts
  if (typeof o.cwd === 'string' && o.cwd.trim()) meta.cwd = o.cwd.trim();
  if (typeof o.rootDir === 'string' && o.rootDir.trim()) meta.rootDir = o.rootDir.trim();
```

- [ ] **Step 6：加 rootDir 到 prune 数组**

修改 `src/shared/toolJson.ts` 第 6 行：

```ts
const PRUNE_WHEN_EMPTY_STRING = ['cwd', 'rootDir', 'tmux', 'mdUrl', 'group'] as const;
```

- [ ] **Step 7：运行测试，确认通过**

Run: `npx vitest run tests/toolConfig.test.ts tests/toolJson.test.ts`
Expected: PASS

- [ ] **Step 8：跑 typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 9：提交**

```bash
git add src/shared/types.ts src/shared/toolConfig.ts src/shared/toolJson.ts tests/toolConfig.test.ts tests/toolJson.test.ts
git commit -m "feat(types): ToolMeta 新增 rootDir 字段

@/ 占位符的锚点，优先级 rootDir > cwd > ~。
parseToolMeta 解析、mergeToolJson prune，均与 cwd 对称。"
```

---

## Task 3：Rust 后端对偶（`types.rs` + `pure.rs`）

**Files:**
- Modify: `src-tauri/src/types.rs:14`（cwd 字段下方加 root_dir）
- Modify: `src-tauri/src/pure.rs:26`（merge prune 列表）
- Modify: `src-tauri/src/pure.rs:199,210`（parse_tool_meta 初始化 + 读取）
- Test: `src-tauri/src/pure.rs`（`#[cfg(test)]` 段）

- [ ] **Step 1：写失败的 Rust 测试**

在 `src-tauri/src/pure.rs` 的 `mod tests` 段（在 `mod tests {` 开头处 `use super::*;` 之后）追加：

```rust
    // ── rootDir（对偶 src/shared/toolConfig.ts / toolJson.ts）──────────────────
    #[test]
    fn merge_prunes_cleared_rootdir() {
        let existing = json!({"rootDir":"/srv/api"});
        let patch = json!({"rootDir":""});
        let m = merge_tool_json(&existing, &patch);
        assert!(m.get("rootDir").is_none(), "cleared rootDir must be pruned");
    }

    #[test]
    fn merge_keeps_rootdir_when_set() {
        let existing = json!({"name":"A"});
        let patch = json!({"rootDir":"/srv/api"});
        let m = merge_tool_json(&existing, &patch);
        assert_eq!(m["rootDir"], "/srv/api");
    }

    #[test]
    fn meta_parses_rootdir() {
        let m = parse_tool_meta(&json!({"name":"A","rootDir":"/srv/api"}), "x");
        assert_eq!(m.root_dir.as_deref(), Some("/srv/api"));
    }

    #[test]
    fn meta_drops_blank_rootdir() {
        let m = parse_tool_meta(&json!({"name":"A","rootDir":"   "}), "x");
        assert_eq!(m.root_dir, None);
    }

    #[test]
    fn meta_rootdir_defaults_none() {
        let m = parse_tool_meta(&json!({"name":"A"}), "x");
        assert_eq!(m.root_dir, None);
    }

    #[test]
    fn meta_rootdir_with_tilde_kept_verbatim() {
        let m = parse_tool_meta(&json!({"name":"A","rootDir":"~/api"}), "x");
        assert_eq!(m.root_dir.as_deref(), Some("~/api"));
    }

    #[test]
    fn risk_ignores_rootdir() {
        // rootDir 不列入风险字段（只是路径配置，不执行、无注入风险）
        let t = bundle_with(json!({"name":"E","rootDir":"/srv/api"}));
        let r = scan_tool_risk(&t);
        assert!(r.is_empty(), "rootDir must not be a risk field");
    }
```

- [ ] **Step 2：运行 Rust 测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure::tests`
Expected: FAIL — `no field root_dir on type ToolMeta`

- [ ] **Step 3：加 `ToolMeta.root_dir` 字段**

修改 `src-tauri/src/types.rs`，在 `pub cwd: Option<String>,`（第 14 行）下方加：

```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// `@/` 占位符的锚点（工具根目录）。优先级 root_dir > cwd > ~。
    /// 为空/缺失时退化为 cwd，再退化为 ~（shell 展开）。
    /// **不参与 pty spawn**（spawn 仍用 cwd）；仅渲染端 substituteCwd 用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_dir: Option<String>,
```

- [ ] **Step 4：加 merge_tool_json prune**

修改 `src-tauri/src/pure.rs` 第 26 行（merge_tool_json 的 prune 数组）：

```rust
    for k in &["cwd", "rootDir", "tmux", "mdUrl", "group"] {
```

- [ ] **Step 5：加 parse_tool_meta 初始化 + 读取**

修改 `src-tauri/src/pure.rs` `parse_tool_meta` 函数。先在 struct 字面量里（约 199 行，`cwd: None,` 之后）加初始化：

```rust
        cwd: None,
        root_dir: None,
        shell: None,
```

然后在读取 cwd 之后（约 212 行，`meta.cwd = Some(cwd);` 之后）加读取：

```rust
    if let Some(cwd) = trim_str_field(o, "cwd") {
        meta.cwd = Some(cwd);
    }
    if let Some(root_dir) = trim_str_field(o, "rootDir") {
        meta.root_dir = Some(root_dir);
    }
```

- [ ] **Step 6：运行 Rust 测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure::tests`
Expected: PASS（含新 rootDir 测试 + 原有用例不回归）

- [ ] **Step 7：cargo check 全量**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 无错误、无警告

- [ ] **Step 8：提交**

```bash
git add src-tauri/src/types.rs src-tauri/src/pure.rs
git commit -m "feat(rust): ToolMeta 后端对偶新增 root_dir 字段

parse_tool_meta 解析、merge_tool_json prune，与 cwd 对称。
scan_tool_risk 不列入 rootDir（无注入风险）。pty spawn 不用 root_dir。"
```

---

## Task 4：接入 HelpPane（2 处调用点）

**Files:**
- Modify: `src/renderer/components/HelpPane.tsx:191-197`

- [ ] **Step 1：加 import**

在 `src/renderer/components/HelpPane.tsx` 顶部，已有 `import { substituteParams } from '../../shared/buttonBlock';` 那一行改成：

```tsx
import { substituteParams, substituteCwd } from '../../shared/buttonBlock';
```

- [ ] **Step 2：包 substituteCwd 到参数按钮（第 193 行）**

定位参数按钮的 prompt.open 回调（约第 191-194 行）：

```tsx
          prompt.open({ command, edit, params }, (values) => {
            if (!values) return;
            void runCommandChecked(props.activeToolId, substituteParams(command, values), edit, opts);
          });
```

改成（外层包 substituteCwd）：

```tsx
          prompt.open({ command, edit, params }, (values) => {
            if (!values) return;
            const cmd = substituteParams(command, values);
            void runCommandChecked(
              props.activeToolId,
              substituteCwd(cmd, props.tool.meta.rootDir, props.tool.meta.cwd),
              edit,
              opts,
            );
          });
```

- [ ] **Step 3：包 substituteCwd 到普通按钮（第 197 行）**

定位普通按钮调用（约第 197 行）：

```tsx
        void runCommandChecked(props.activeToolId, command, edit, opts);
        return;
```

改成：

```tsx
        void runCommandChecked(
          props.activeToolId,
          substituteCwd(command, props.tool.meta.rootDir, props.tool.meta.cwd),
          edit,
          opts,
        );
        return;
```

- [ ] **Step 4：跑 typecheck + 测试**

Run: `npm run typecheck && npx vitest run`
Expected: 无错误

- [ ] **Step 5：提交**

```bash
git add src/renderer/components/HelpPane.tsx
git commit -m "feat(HelpPane): 按钮点击时替换 @/ 占位符

参数按钮和普通按钮在 runCommandChecked 前包 substituteCwd。
锚点取 tool.meta.rootDir ?? tool.meta.cwd ?? ~。"
```

---

## Task 5：接入 QuickCommands（2 处调用点）

**Files:**
- Modify: `src/renderer/components/QuickCommands.tsx:67-74`

- [ ] **Step 1：加 import**

在 `src/renderer/components/QuickCommands.tsx` 顶部，已有 `import { substituteParams } from ...` 那一行改成（确认当前 import 来源；若已 import 自 `'../../shared/buttonBlock'` 则加 `substituteCwd`）：

```tsx
import { substituteParams, substituteCwd } from '../../shared/buttonBlock';
```

> 注：执行时先 `grep "substituteParams" src/renderer/components/QuickCommands.tsx` 确认 import 路径，若与 HelpPane 一致则同款改。

- [ ] **Step 2：包 substituteCwd 到参数按钮（第 70 行）**

定位（约第 67-72 行）：

```tsx
    if (params && params.length > 0) {
      prompt.open({ command, edit, params }, (values) => {
        if (!values) return;
        void runCommandChecked(a.meta.id, substituteParams(command, values), edit, opts);
      });
      return;
    }
```

改成：

```tsx
    if (params && params.length > 0) {
      prompt.open({ command, edit, params }, (values) => {
        if (!values) return;
        const cmd = substituteParams(command, values);
        void runCommandChecked(a.meta.id, substituteCwd(cmd, a.meta.rootDir, a.meta.cwd), edit, opts);
      });
      return;
    }
```

- [ ] **Step 3：包 substituteCwd 到普通按钮（第 74 行）**

定位（约第 74 行）：

```tsx
    void runCommandChecked(a.meta.id, command, edit, opts);
```

改成：

```tsx
    void runCommandChecked(a.meta.id, substituteCwd(command, a.meta.rootDir, a.meta.cwd), edit, opts);
```

- [ ] **Step 4：跑 typecheck + 测试**

Run: `npm run typecheck && npx vitest run`
Expected: 无错误

- [ ] **Step 5：提交**

```bash
git add src/renderer/components/QuickCommands.tsx
git commit -m "feat(QuickCommands): 全局快捷命令点击时替换 @/ 占位符"
```

---

## Task 6：编辑器 UI 加「工具根目录 (@/)」输入框

**Files:**
- Modify: `src/renderer/components/EditorPane.tsx`（state + UI + 保存）

- [ ] **Step 1：加 state**

定位 `src/renderer/components/EditorPane.tsx:40`（`const [cwd, setCwd] = useState(meta.cwd ?? '');`）下方加：

```tsx
  const [cwd, setCwd] = useState(meta.cwd ?? '');
  const [rootDir, setRootDir] = useState(meta.rootDir ?? '');
```

- [ ] **Step 2：保存时带 rootDir**

定位保存逻辑里的 `cwd: cwd.trim(),`（约第 114 行，meta patch 对象）下方加：

```tsx
      cwd: cwd.trim(),
      rootDir: rootDir.trim(),
```

- [ ] **Step 3：加 UI 输入框**

定位「起始目录 (cwd)」的 `<label>`（约第 206-209 行）：

```tsx
          <label className="field">
            <span className="field-label">起始目录 (cwd)</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </label>
```

在这个 `</label>` 之后、tmux label 之前插入：

```tsx
          <label className="field">
            <span className="field-label">
              工具根目录 (@/) <em>留空同 cwd；按钮里 @/ 锚定此目录</em>
            </span>
            <input value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="留空同 cwd" />
          </label>
```

- [ ] **Step 4：跑 typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 5：提交**

```bash
git add src/renderer/components/EditorPane.tsx
git commit -m "ui(EditorPane): 终端配置加「工具根目录 (@/)」输入框

留空同 cwd；远端工具可配成项目根，实现 shell 落地与按钮锁定分离。"
```

---

## Task 7：全量回归 + typecheck + 文档

**Files:**
- 仅验证，不改代码（除非发现回归）

- [ ] **Step 1：前端 typecheck + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全绿

- [ ] **Step 2：Rust 全量测试 + check**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 全绿、无警告

- [ ] **Step 3：检查 git status 干净**

Run: `git status`
Expected: working tree clean（所有改动已分 task 提交）

- [ ] **Step 4：合并 squash 或保留分 task 历史**

本特性改动分散在 7 个文件、6 个 task，建议**保留分 task 提交**（每个 task 一个提交，便于回溯）。不需要 squash。

---

## Self-Review

**1. Spec 覆盖**：
- §1 决策（@/ 语法 + rootDir 优先级）→ Task 1（替换）+ Task 2/3（字段）✓
- §2 触发规则（正则）→ Task 1 Step 3（实现）✓
- §3 锚点解析（rootDir > cwd > ~，不展开 ~）→ Task 1 Step 3（resolveAnchor）✓
- §4.1 数据模型（ToolMeta.rootDir）→ Task 2 Step 4 ✓
- §4.2 后端透传（merge/serialize/parse/scan_risk）→ Task 3 ✓（serialize 由 serde `rename_all = "camelCase"` 自动处理，无需手写）
- §4.3 substituteCwd → Task 1 ✓
- §4.4 调用点（4 处）→ Task 4（HelpPane 2 处）+ Task 5（QuickCommands 2 处）✓
- §4.5 编辑器 UI → Task 6 ✓
- §4.6 不需改的地方（parseButtonLine/renderButtonsBlock 不动、pty 不动、dangerous 替换前检测）→ 当前 `runCommandChecked` 已在 `substituteParams` 之后、`substituteCwd` 之前检测，符合设计 ✓
- §5 测试 → Task 1（15 用例）+ Task 2（5+3 用例）+ Task 3（7 用例）✓

**2. 占位符扫描**：无 TBD/TODO，所有代码块完整。

**3. 类型一致性**：
- `substituteCwd(command, rootDir?, cwd?)` —— Task 1 定义，Task 4/5 调用签名一致 ✓
- `meta.rootDir` —— Task 2 类型、Task 4/5/6 调用一致 ✓
- `meta.root_dir`（Rust）—— Task 3 字段名与测试断言一致 ✓

**4. 顺序一致性**：`substituteParams` → `runCommandChecked`（内部含 isDangerousCommand 检测）→ 包 substituteCwd 在**外层**，即替换在检测之后。符合 §4.6「替换前检测」中「检测参数替换后、cwd 替换前的文本」的决策。✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-tool-cwd-placeholder.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 task 派一个新 subagent，task 之间我审阅，迭代快、上下文干净

**2. Inline Execution** — 在本会话里按 executing-plans 批量执行，带 checkpoint 审阅

Which approach?
