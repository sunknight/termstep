# 统一布局系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除「普通模式/文档模式」二元 fork，统一为「文档区 + 终端区」的可配置布局系统——支持 LR/TB 两种布局方向，终端可隐藏（pty 保持活着），文档可折叠为 Peek。

**Architecture:** 在 ToolMeta 新增 `layout: "LR"|"TB"` 和 `terminalHidden: boolean`，废弃并迁移老的 `type:"terminal"|"document"` 字段。App.tsx 的 `isDocument` 三元 fork 替换为始终渲染「文档 + 终端」双面板，通过 CSS flex-direction 切方向。终端隐藏用 `visibility:hidden + position:absolute`（保留非零尺寸避免 xterm 渲染坑），不 dispose 实例、不 kill pty。

**Tech Stack:** Tauri v2（Rust 后端）+ React 18 / TypeScript（渲染端）+ xterm.js + portable-pty。测试：vitest（TS）+ cargo test（Rust）。

**设计文档:** `docs/superpowers/specs/2026-07-20-unified-layout-design.md`

---

## 文件结构总览

**新建：**
- 无新组件文件（复用现有 TerminalPane/HelpPane，重构 App.tsx 内联布局）

**修改（渲染端 TS）：**
- `src/shared/types.ts` — ToolMeta 加 `layout`/`terminalHidden`，删 `type`；PtySpawnOpts 删 `type`
- `src/shared/toolJson.ts` — prune 规则更新；新增 `migrateMeta` 纯函数
- `src/renderer/App.tsx` — 主区布局重构、顶栏上提、`termHidden` state、双方向拖动条
- `src/renderer/components/TerminalPane.tsx` — spawnOpts 去 `type`
- `src/renderer/components/TerminalView.tsx` — 适配「隐藏但保留实例」
- `src/renderer/components/HelpPane.tsx` — onClick 加 `termHidden` 门控；opts 去 `type`
- `src/renderer/components/QuickCommands.tsx` — 同上门控；opts 去 `type`
- `src/renderer/components/EditorPane.tsx` — 替换模式 radio 为布局方向 + 终端初始状态
- `src/renderer/lib/clipboardToast.ts` — 导出 `showToast` 为通用方法
- `src/renderer/lib/termRegistry.ts` — `runCommand` 去掉隐式 no-term 写入（显式门控前置）
- `src/renderer/styles.css` — 新布局类、双方向 splitter、隐藏态样式

**修改（后端 Rust）：**
- `src-tauri/src/types.rs` — ToolMeta 加 `layout`/`terminal_hidden`，删 `tool_type`；PtySpawnOpts 删 `tool_type`
- `src-tauri/src/pure.rs` — prune 对偶；`parse_tool_meta` 去 type 解析、加 layout/terminalHidden 解析；新增 `migrate_meta` 对偶纯函数
- `src-tauri/src/pty.rs` — 删 `ensure` 的 `tool_type == "document"` 早返回
- `src-tauri/src/tool_io.rs` — 新增 `migrate_layout_fields_blocking`
- `src-tauri/src/lib.rs` — setup() 接入新迁移

**修改（测试）：**
- `tests/toolJson.test.ts` — 更新 prune 测试，加 `migrateMeta` 测试
- `tests/toolConfig.test.ts` — 去 type 测试，加 layout/terminalHidden 测试
- Rust 测试 — `pure.rs` 内联测试更新；`tool_io.rs` 加迁移测试

---

## Task 1: 后端字段层 — ToolMeta 加 layout/terminal_hidden，删 tool_type

**Files:**
- Modify: `src-tauri/src/types.rs:6-44`（ToolMeta struct）、`src-tauri/src/types.rs:74-91`（PtySpawnOpts struct）

- [ ] **Step 1: 修改 ToolMeta struct**

把 `src-tauri/src/types.rs:42-43` 的 `tool_type` 字段替换为两个新字段：

```rust
    /// 布局方向：`"LR"` = 文档左/终端右（默认），`"TB"` = 文档上/终端下。
    /// 对偶 src/shared/types.ts 的 meta.layout。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    /// 终端初始是否隐藏（配置默认值，运行时可被顶栏 toggle 覆盖）。
    /// 对偶 src/shared/types.ts 的 meta.terminalHidden。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_hidden: Option<bool>,
```

（删掉原来的 `#[serde(default, rename = "type", skip_serializing_if = "Option::is_none")] pub tool_type: Option<String>,`）

- [ ] **Step 2: 修改 PtySpawnOpts struct**

把 `src-tauri/src/types.rs:87-90` 的 `tool_type` 字段整段删除（含其上方的 doc 注释 87-88）：

```rust
    /// 工具类型（对偶 ToolMeta.tool_type）。document 型不应 spawn 终端，
    /// pty::ensure 据此防御性早 return。其它值/缺失 = 正常终端工具。
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub tool_type: Option<String>,
```

全部删掉（PtySpawnOpts 不再需要类型字段，后端不再按类型 skip）。

- [ ] **Step 3: cargo check 验证编译失败点**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | head -50`

Expected: 编译错误，集中在 `pure.rs`（parse_tool_meta 还在设置 tool_type）、`pty.rs`（ensure 还在用 opts.tool_type）、`commands.rs`（如果有构造 PtySpawnOpts 的地方引用 tool_type）。记下这些错误的位置，后面 Task 3、Task 4 会逐个修。

- [ ] **Step 4: 暂不提交，继续 Task 2（前端字段）后一起测**

> 说明：本 task 单独无法编译通过（依赖 pure.rs 的解析逻辑）。先做完 Task 2、3、4 再一起 `cargo check` + `npm run typecheck` 验证。保持这批字段层改动在一个提交里。

---

## Task 2: 前端字段层 — ToolMeta 加 layout/terminalHidden，删 type

**Files:**
- Modify: `src/shared/types.ts:67-72`（ToolMeta.type）、`src/shared/types.ts:103-107`（PtySpawnOpts.type）

- [ ] **Step 1: 替换 ToolMeta.type 字段**

把 `src/shared/types.ts:67-72` 整段：

```ts
  /**
   * 工具类型。`"terminal"`（默认）= 持久终端 + 右栏帮助页；
   * `"document"` = 仅文档型：不创建终端，整个右半屏合并为文档区，按钮无动作（保留 ⌘/Ctrl+点击复制）。
   * 缺省视为 `"terminal"`，向后兼容旧 tool.json。
   */
  type?: 'terminal' | 'document';
```

替换为：

```ts
  /**
   * 布局方向。`"LR"` = 文档左/终端右（默认）；`"TB"` = 文档上/终端下。
   * 仅工具配置控制（保存后生效），无运行时 toggle。
   */
  layout?: 'LR' | 'TB';
  /**
   * 终端初始是否隐藏（配置默认值）。运行时顶栏 toggle 可临时覆盖，
   * toggle 状态不写回配置。隐藏时 pty 保持活着，可随时重新显示。
   */
  terminalHidden?: boolean;
```

- [ ] **Step 2: 删 PtySpawnOpts.type 字段**

把 `src/shared/types.ts:103-107` 整段删除：

```ts
  /**
   * 工具类型（对偶 Rust `PtySpawnOpts.tool_type`）。后端 `pty::ensure` 据此
   * 防御性 skip document 型——前端不渲染终端已是主防线，这里是兜底。
   */
  type?: 'terminal' | 'document';
```

- [ ] **Step 3: 暂不提交，继续 Task 3、4 后一起验证**

> 说明：删 type 后，所有引用 `meta.type` / `opts.type` 的地方都会报类型错误（HelpPane、QuickCommands、App.tsx、TerminalPane、EditorPane）。这些在后续 task 逐个修。先做后端 pure.rs 和 pty.rs。

---

## Task 3: 后端 pure.rs — parse_tool_meta 去 type、加 layout/terminalHidden；prune 对偶

**Files:**
- Modify: `src-tauri/src/pure.rs:26`（prune 列表）、`src-tauri/src/pure.rs:194-256`（parse_tool_meta，含 struct 字面量 + type 解析）

- [ ] **Step 1: 更新 prune 列表**

`src-tauri/src/pure.rs:26` 的 prune 数组：

```rust
    for k in &["cwd", "rootDir", "tmux", "mdUrl", "group", "type"] {
```

改为（去 `type`，加 `layout`——`layout` 走空串 prune，与 TS 侧 `PRUNE_WHEN_EMPTY_STRING` 一致）：

```rust
    for k in &["cwd", "rootDir", "tmux", "mdUrl", "group", "layout"] {
```

- [ ] **Step 2: terminalHidden prune（false 即 prune）**

在 `src-tauri/src/pure.rs:38`（`if merged.get("mdUrl").is_none() { ... }` 块之后、`Value::Object(merged)` 之前）插入：

```rust
    // terminalHidden=false 是默认值，prune 掉保持 tool.json 整洁（与 layout 空串同理）。
    if merged.get("terminalHidden").and_then(|v| v.as_bool()) == Some(false) {
        merged.remove("terminalHidden");
    }
```

- [ ] **Step 3: parse_tool_meta struct 字面量去 tool_type**

在 `src-tauri/src/pure.rs` 找到 `parse_tool_meta` 里的 struct 字面量（约 194-211 行），把：

```rust
        tool_type: None,
```

替换为：

```rust
        layout: None,
        terminal_hidden: None,
```

- [ ] **Step 4: parse_tool_meta 去 type 解析，加 layout/terminalHidden 解析**

`src-tauri/src/pure.rs:249-254` 的 type 解析块：

```rust
    if let Some(t) = trim_str_field(o, "type") {
        // 只接受 terminal / document，其它一律视为缺省。
        if t == "terminal" || t == "document" {
            meta.tool_type = Some(t);
        }
    }
```

替换为：

```rust
    if let Some(l) = trim_str_field(o, "layout") {
        // 只接受 LR / TB，其它一律视为缺省。
        if l == "LR" || l == "TB" {
            meta.layout = Some(l);
        }
    }
    if let Some(b) = o.get("terminalHidden").and_then(|v| v.as_bool()) {
        meta.terminal_hidden = Some(b);
    }
```

- [ ] **Step 5: cargo check 验证 pure.rs 编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | head -30`

Expected: pure.rs 不再有编译错误。剩余错误应集中在 `pty.rs::ensure`（Task 4 修）和可能的 `commands.rs`（Task 5 修）。

- [ ] **Step 6: 暂不提交**

---

## Task 4: 后端 pty.rs — 删 ensure 的 document 早返回

**Files:**
- Modify: `src-tauri/src/pty.rs:126-130`（ensure 函数的 tool_type 早返回）

- [ ] **Step 1: 删除 document 早返回**

`src-tauri/src/pty.rs:125-130`：

```rust
    fn ensure(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
        // 防御性：document 型工具不应 spawn 终端。前端分发已避免调用，
        // 这里兜底防止 bug / 残留调用创建无用 shell 进程。
        if opts.tool_type.as_deref() == Some("document") {
            return;
        }
```

改为（只保留函数签名和后续双重检查注释）：

```rust
    fn ensure(&self, handle: &AppHandle, tool_id: &str, opts: &PtySpawnOpts) {
```

（删掉 4 行注释 + 3 行 if 块；让后续 `// 双重检查 + 哨兵` 注释紧接函数签名。）

- [ ] **Step 2: cargo check 验证 pty.rs 编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | head -30`

Expected: pty.rs 不再有错误。如果 `commands.rs` 还有 `tool_type` 引用错误，继续 Task 5。

- [ ] **Step 3: 暂不提交**

---

## Task 5: 后端 commands.rs 等剩余 type 引用清理

**Files:**
- Modify: 任何剩余引用 `tool_type` 的 Rust 文件（commands.rs / 其他）

- [ ] **Step 1: 全局搜索剩余 tool_type 引用**

Run: `grep -rn "tool_type\|\"type\"" src-tauri/src/ | grep -v "tool_type:" | head -30`

Expected: 找出 commands.rs 或其他文件里构造 PtySpawnOpts 时传 `tool_type` 或 `type:` 的地方。

- [ ] **Step 2: 逐个删除这些引用**

对每个找到的位置，删掉 `tool_type: ...` 或 `type: ...` 这一行（PtySpawnOpts 不再有这个字段）。常见位置：
- `commands.rs` 里 `pty_open` / `pty_write` / `pty_restart` 构造 opts 的地方（如果有）

- [ ] **Step 3: cargo check 验证后端全绿**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10`

Expected: `Finished` 无错误。

- [ ] **Step 4: cargo test 验证后端测试基线**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`

Expected: 可能 pure.rs 里有 type 相关测试失败（如 `parse_tool_meta type=document`）。记下失败测试，Task 11 会更新它们。**暂时允许这些已知失败**，但要确认没有其他意外失败。

- [ ] **Step 5: 暂不提交**

---

## Task 6: 迁移纯函数 — migrate_meta（前后端对偶）

**Files:**
- Modify: `src/shared/toolJson.ts`（加 `migrateMeta` 导出）
- Modify: `src-tauri/src/pure.rs`（加 `migrate_meta` 函数）

- [ ] **Step 1: 写 TS 版 migrateMeta 的失败测试**

在 `tests/toolJson.test.ts` 末尾追加新 describe 块：

```ts
import { mergeToolJson, migrateMeta } from '../src/shared/toolJson';

describe('migrateMeta', () => {
  it('converts type=document to layout=TB + terminalHidden=true and drops type', () => {
    const before = { name: 'doc', type: 'document', cwd: '/x' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 'doc', cwd: '/x', layout: 'TB', terminalHidden: true });
    expect('type' in after).toBe(false);
  });

  it('drops type=terminal and leaves layout/terminalHidden unset', () => {
    const before = { name: 't', type: 'terminal', shell: 'zsh' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't', shell: 'zsh' });
    expect('type' in after).toBe(false);
    expect('layout' in after).toBe(false);
    expect('terminalHidden' in after).toBe(false);
  });

  it('drops legacy type field when no value', () => {
    const before = { name: 't', type: '' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't' });
    expect('type' in after).toBe(false);
  });

  it('preserves existing layout/terminalHidden (idempotent re-run)', () => {
    const before = { name: 't', layout: 'TB', terminalHidden: false };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't', layout: 'TB', terminalHidden: false });
  });

  it('ignores unknown type values (treats as default)', () => {
    const before = { name: 't', type: 'weird' };
    const after = migrateMeta({ ...before });
    expect(after).toEqual({ name: 't' });
    expect('type' in after).toBe(false);
  });
});
```

> 注意：顶部 `import { mergeToolJson } from '../src/shared/toolJson';` 改为 `import { mergeToolJson, migrateMeta } from '../src/shared/toolJson';`。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/toolJson.test.ts -t "migrateMeta" 2>&1 | tail -15`

Expected: FAIL，`migrateMeta is not a function` 或 import error。

- [ ] **Step 3: 实现 TS 版 migrateMeta**

在 `src/shared/toolJson.ts` 末尾追加：

```ts
/**
 * 把旧 `type` 字段迁移到新的 `layout` + `terminalHidden` 字段（统一布局系统）。
 * - `type:"document"` → `layout:"TB"` + `terminalHidden:true`（保留原「文档为主」观感）。
 * - `type:"terminal"` / `type:""` / 未知值 / 缺失 → 不设 layout/terminalHidden（走默认 LR + 可见）。
 * - 任何情况都删除 `type` 字段。
 * 幂等：输入已无 `type` 字段则原样返回（layout/terminalHidden 不动）。
 * 对偶 src-tauri/src/pure.rs migrate_meta。
 */
export function migrateMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta)) {
    if (k === 'type') continue; // type 字段一律丢弃
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  if (meta.type === 'document') {
    out.layout = 'TB';
    out.terminalHidden = true;
  }
  return out;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/toolJson.test.ts -t "migrateMeta" 2>&1 | tail -15`

Expected: PASS，5 个 migrateMeta 用例全过。

- [ ] **Step 5: 实现 Rust 对偶 migrate_meta**

在 `src-tauri/src/pure.rs` 末尾追加（`parse_tool_meta` 之后）：

```rust
/// 把旧 `type` 字段迁移到新的 `layout` + `terminalHidden` 字段（统一布局系统）。
/// 对偶 src/shared/toolJson.ts migrateMeta。幂等：输入已无 `type` 则原样返回。
pub fn migrate_meta(meta: &Value) -> Value {
    let Some(o) = meta.as_object() else {
        return meta.clone();
    };
    let mut out = serde_json::Map::new();
    for (k, v) in o {
        if k == "type" {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    if o.get("type").and_then(|v| v.as_str()) == Some("document") {
        out.insert("layout".to_string(), Value::String("TB".to_string()));
        out.insert("terminalHidden".to_string(), Value::Bool(true));
    }
    Value::Object(out)
}

#[cfg(test)]
mod migrate_meta_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn document_becomes_tb_hidden() {
        let before = json!({ "name": "doc", "type": "document", "cwd": "/x" });
        let after = migrate_meta(&before);
        assert_eq!(after, json!({ "name": "doc", "cwd": "/x", "layout": "TB", "terminalHidden": true }));
    }

    #[test]
    fn terminal_drops_type_no_layout() {
        let before = json!({ "name": "t", "type": "terminal", "shell": "zsh" });
        let after = migrate_meta(&before);
        assert_eq!(after, json!({ "name": "t", "shell": "zsh" }));
    }

    #[test]
    fn idempotent_preserves_existing() {
        let before = json!({ "name": "t", "layout": "TB", "terminalHidden": false });
        let after = migrate_meta(&before);
        assert_eq!(after, json!({ "name": "t", "layout": "TB", "terminalHidden": false }));
    }

    #[test]
    fn unknown_type_dropped() {
        let before = json!({ "name": "t", "type": "weird" });
        let after = migrate_meta(&before);
        assert_eq!(after, json!({ "name": "t" }));
    }
}
```

- [ ] **Step 6: cargo test 验证 Rust 对偶**

Run: `cargo test --manifest-path src-tauri/Cargo.toml migrate_meta 2>&1 | tail -15`

Expected: 4 个 migrate_meta 测试全过。

- [ ] **Step 7: 提交（字段层 + 纯函数）**

```bash
git add src/shared/types.ts src/shared/toolJson.ts \
        src-tauri/src/types.rs src-tauri/src/pure.rs src-tauri/src/pty.rs \
        src-tauri/src/commands.rs tests/toolJson.test.ts
git commit -m "feat(layout): 字段层替换 type→layout+terminalHidden，加 migrate_meta 纯函数（前后端对偶）

- ToolMeta: 去掉 type，新增 layout(LR/TB) + terminalHidden
- PtySpawnOpts: 去掉 type（后端不再按类型 skip spawn）
- pty::ensure: 删 document 早返回
- pure.rs/toolJson.ts: prune 对偶更新；新增 migrate_meta 纯函数 + 测试"
```

> 说明：此时前端 App.tsx / HelpPane / QuickCommands / EditorPane / TerminalPane 还有 type 引用，`npm run typecheck` 还会报错。这些在 Task 8-10 修。本提交只保证后端编译/测试 + shared 层 + 纯函数测试通过。

---

## Task 7: 后端迁移链 — migrate_layout_fields_blocking

**Files:**
- Modify: `src-tauri/src/tool_io.rs`（加新迁移函数）
- Modify: `src-tauri/src/lib.rs:35-65`（setup 接入）

- [ ] **Step 1: 在 tool_io.rs 加迁移函数**

在 `src-tauri/src/tool_io.rs` 的 `migrate_add_source_id_blocking` 函数之后（约 line 510 之前的合适位置——找到 `migrate_to_configs_blocking` 定义之前）追加：

```rust
/// 把旧 `type` 字段迁移到 `layout` + `terminalHidden`（统一布局系统）。
/// 遍历 configs/tools/*/tool.json，调用 pure::migrate_meta 转换字段，
/// 仅当 tool.json 内容有变化时才写回（用「临时文件 + rename」原子写）。
/// 幂等：标志文件 `configs/.migrated-layout` 存在则直接返回 true。
pub fn migrate_layout_fields_blocking(tools_dir: &Path) -> bool {
    const MARKER: &str = ".migrated-layout";
    if tools_dir.join(MARKER).exists() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(tools_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let tool_json = entry.path().join("tool.json");
        let Ok(content) = std::fs::read_to_string(&tool_json) else {
            continue; // 无 tool.json 或读失败——跳过，不阻断
        };
        let Ok(before) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue; // 解析失败——跳过（不破坏坏文件）
        };
        let after = crate::pure::migrate_meta(&before);
        // 只有内容变化才写回（避免无谓 IO / watcher 抖动）。
        if before == after {
            continue;
        }
        let pretty = match serde_json::to_string_pretty(&after) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // 原子写：临时文件 + rename（同目录 rename 原子）。
        let tmp = entry.path().join(".tool.json.tmp");
        if std::fs::write(&tmp, format!("{}\n", pretty)).is_err() {
            continue;
        }
        let _ = std::fs::rename(&tmp, &tool_json);
    }
    // 所有处理完成（或本就无需处理）后写标志文件。
    if let Err(e) = std::fs::write(tools_dir.join(MARKER), "1\n") {
        eprintln!("migrate_layout_fields: write marker failed: {}", e);
    }
    true
}
```

- [ ] **Step 2: 在 lib.rs setup() 接入新迁移**

`src-tauri/src/lib.rs:52-56` 现有迁移调用：

```rust
                let _ = tool_io::migrate_to_uuid_ids_blocking(&tools_dir);
                let _ = tool_io::migrate_order_to_index_blocking(&tools_dir);
                // 给存量工具补 sourceId（跨导入去重的稳定匹配键）。只动 tool.json
                // 内容，放最后，UUID/order 迁移之后。
                let _ = tool_io::migrate_add_source_id_blocking(&tools_dir);
```

在 `migrate_add_source_id_blocking` 之后追加：

```rust
                // 把旧 type 字段迁到 layout + terminalHidden（统一布局系统）。
                // 放最后：依赖前面迁移把 tool.json 整理干净后再做字段转换。
                let _ = tool_io::migrate_layout_fields_blocking(&tools_dir);
```

- [ ] **Step 3: cargo check + cargo test 验证**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5 && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10`

Expected: 编译通过；测试除已知 pure.rs type 测试失败外全绿。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/tool_io.rs src-tauri/src/lib.rs
git commit -m "feat(layout): migrate_layout_fields_blocking 迁移旧 type→layout+terminalHidden

启动时同步执行，幂等（标志文件 .migrated-layout），原子写。
接入 setup() 迁移链末端。"
```

---

## Task 8: 渲染端清理 — TerminalPane / App.tsx / HelpPane / QuickCommands 去 type 引用

**Files:**
- Modify: `src/renderer/components/TerminalPane.tsx:18`（spawnOpts.type）
- Modify: `src/renderer/App.tsx:290`（isDocument）、`App.tsx:330-337`（restart opts.type）
- Modify: `src/renderer/components/HelpPane.tsx:187-194`（opts.type）
- Modify: `src/renderer/components/QuickCommands.tsx:59-66`（opts.type）

> 说明：这一步只是把所有 `type: ...` 引用从 spawnOpts 里删掉，让 typecheck 通过。**暂不动 isDocument 的渲染逻辑**（Task 9 才重构布局）。Task 8 结束后应用仍能正常运行（type 字段虽然从数据模型删了，但渲染还按「有终端」的旧路径走——所有工具都会显示终端，包括原 document 工具。这是中间态，Task 9 修）。

- [ ] **Step 1: TerminalPane.tsx 去 type**

`src/renderer/components/TerminalPane.tsx:18`：

```tsx
            type: t.meta.type,
```

整行删除。

- [ ] **Step 2: HelpPane.tsx 去 type**

`src/renderer/components/HelpPane.tsx:187-194` 的 opts 对象，删掉最后一行：

```tsx
          type: props.tool.meta.type,
```

- [ ] **Step 3: QuickCommands.tsx 去 type**

`src/renderer/components/QuickCommands.tsx:59-66` 的 opts 对象，删掉最后一行：

```tsx
      type: a.meta.type,
```

- [ ] **Step 4: App.tsx restart handler 去 type**

`src/renderer/App.tsx:330-337` 的 opts 对象，删掉：

```tsx
                        type: active.meta.type,
```

- [ ] **Step 5: App.tsx 暂时移除 isDocument fork（让所有工具走终端路径）**

`src/renderer/App.tsx:289-297`：

```tsx
  // 文档型工具（tool.json 的 type === 'document'）：不建终端，整屏渲染文档。
  const isDocument = active?.meta.type === 'document';

  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      {isDocument ? (
        renderHelp(false, true)
      ) : (
```

暂时改为（删 isDocument，始终走终端路径；renderHelp 的 documentMode 参数保留但永远传 false）：

```tsx
  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      {
        <>
```

> 注意：对应的 `) : (` 闭合也要调整为 `)}` —— 原来是 `) : ( <>...</> )}` 三元，现在变成普通块。具体改法：
> - 删掉 `const isDocument = ...`
> - 把 `{isDocument ? (\n  renderHelp(false, true)\n) : (\n  <>` 改为 `{<>`
> - 末尾的 `</>\n)}` 保持（`<>` 是 Fragment）
>
> 这是一个临时改动，Task 9 会把整段重写为统一布局。这里只需让 typecheck 过、应用能跑。

- [ ] **Step 6: typecheck 验证**

Run: `npm run typecheck 2>&1 | tail -15`

Expected: PASS（无类型错误）。

- [ ] **Step 7: 手动验证应用能启动**

Run: `npm run dev` （后台启动，观察 Vite 编译无错；如果已有 dev 在跑则跳过）

Expected: 应用窗口正常打开，所有工具（含原 document 工具）都显示终端 + 帮助栏。**原 document 工具此时会显示终端**（中间态，预期行为）。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/components/TerminalPane.tsx src/renderer/components/HelpPane.tsx \
        src/renderer/components/QuickCommands.tsx src/renderer/App.tsx
git commit -m "refactor(layout): 清理渲染端 type 引用，临时让所有工具走终端路径

- TerminalPane/HelpPane/QuickCommands/App.tsx 的 spawnOpts 去 type 字段
- 移除 isDocument fork（中间态，Task 9 重写为统一布局）"
```

---

## Task 9: 布局重构 — App.tsx 统一双面板 + termHidden state + 双方向拖动条

**Files:**
- Modify: `src/renderer/App.tsx`（主区 JSX 重写、新增 state 和拖动 handler）
- Modify: `src/renderer/styles.css`（新布局类、双方向 splitter）

> 这是最大的一个 task。把它拆成几个子步骤。核心：主区永远渲染「文档 + 终端」双面板，用 `meta.layout` 决定 flex-direction，用 `termHidden`（运行时 state）控制终端显隐。

- [ ] **Step 1: 新增 state 和常量**

在 `src/renderer/App.tsx` 的 state 区（line 67-70 `helpWidth` 之后）追加：

```tsx
  // 终端显隐（运行时状态）。初值取自当前工具的 meta.terminalHidden；
  // 切换工具时重置（见下方 effect）。顶栏 toggle 改这个 state，不写回配置。
  const [termHidden, setTermHidden] = useState<boolean>(false);
  // LR 布局下的终端宽度（px），全局共享。
  const [termSizeLr, setTermSizeLr] = useState<number>(() => {
    const v = Number(localStorage.getItem('termstep:term-size-lr'));
    return v >= 280 && v <= 1200 ? v : 560;
  });
  // TB 布局下的终端高度（px），全局共享。
  const [termSizeTb, setTermSizeTb] = useState<number>(() => {
    const v = Number(localStorage.getItem('termstep:term-size-tb'));
    return v >= 120 && v <= 1200 ? v : 320;
  });
```

- [ ] **Step 2: 切换工具时重置 termHidden**

在 App.tsx 找一个合适位置（active 计算之后、return 之前）加 effect：

```tsx
  // 切换工具时，termHidden 重置为新工具的 meta.terminalHidden（配置默认值）。
  useEffect(() => {
    setTermHidden(!!active?.meta.terminalHidden);
  }, [activeId]); // 只依赖 activeId，不依赖 active 对象（避免每帧重置）
```

- [ ] **Step 3: 加 localStorage persist effects**

在现有 persist effects 区（line 117-125 之后）追加：

```tsx
  useEffect(() => {
    localStorage.setItem('termstep:term-size-lr', String(termSizeLr));
  }, [termSizeLr]);
  useEffect(() => {
    localStorage.setItem('termstep:term-size-tb', String(termSizeTb));
  }, [termSizeTb]);
```

- [ ] **Step 4: 加双方向拖动 handler**

替换 `src/renderer/App.tsx:96-115` 的 `startHelpDrag`（原帮助栏宽度拖动）。新 handler 根据 `active?.meta.layout` 决定方向：

```tsx
  // 终端/文档之间的拖动条。方向由当前工具的 layout 决定：
  // LR = 左右拖（改 termSizeLr），TB = 上下拖（改 termSizeTb）。
  const startTermDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const layout = active?.meta.layout ?? 'LR';
    const startX = e.clientX;
    const startY = e.clientY;
    const startLr = termSizeLr;
    const startTb = termSizeTb;
    // 终端在右/下：光标向左/上移 = 终端变大。
    const onMove = (ev: MouseEvent) => {
      if (layout === 'LR') {
        const w = Math.min(1200, Math.max(280, startLr + (startX - ev.clientX)));
        setTermSizeLr(w);
      } else {
        const h = Math.min(1200, Math.max(120, startTb + (startY - ev.clientY)));
        setTermSizeTb(h);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = layout === 'LR' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
```

（删掉旧的 `startHelpDrag`。注意 `HELP_MIN_WIDTH`/`HELP_MAX_WIDTH`/`HELP_DEFAULT_WIDTH` 常量如果不再被其他地方引用，也可一并删掉——`helpWidth` 仍用于 Peek 浮动宽度，常量保留。）

- [ ] **Step 5: 重写主区 JSX**

替换 `src/renderer/App.tsx:289-371`（从 `// 文档型工具...` 注释到 `</section>` + `)}` 闭合）。新结构：

```tsx
  const layout = active?.meta.layout ?? 'LR';

  return (
    <div className="app">
      {!sidebarCollapsed && sidebarContent}
      <section className="main-area">
        {/* 顶栏：跨布局一致，始终在主区顶部 */}
        <div className="term-header">
          <span className="term-cwd" title={liveCwd ?? ''}>
            {liveCwd ?? (activeId ? '…' : '')}
          </span>
          <div className="term-actions">
            <QuickCommands activeTool={active} />
            {active && (
              <>
                <button
                  className="term-toggle"
                  title={termHidden ? '显示终端' : '隐藏终端'}
                  onClick={() => setTermHidden(!termHidden)}
                >
                  {termHidden ? '▸ 终端' : '▾ 终端'}
                </button>
                <button
                  className="term-restart"
                  title="重启终端（按住 ⌘ 强制重启：放弃旧终端，新起一个）"
                  onClick={(e) => {
                    const id = active.meta.id;
                    const opts = {
                      cwd: active.meta.cwd,
                      shell: active.meta.shell,
                      env: active.meta.env,
                      tmux: active.meta.tmux,
                      initCommands: active.meta.initCommands,
                    };
                    termRegistry.get(id)?.reset();
                    api.pty.restart(id, opts, e.metaKey);
                  }}
                >
                  重启
                </button>
              </>
            )}
            {!sidebarCollapsed && (
              <PanelToggle
                dir="right"
                collapsed={false}
                onClick={() => setSidebarCollapsed(true)}
              />
            )}
          </div>
        </div>
        <div className={`main-body layout-${layout.toLowerCase()}`}>
          {/* 文档区 */}
          <div
            className="doc-pane"
            style={
              termHidden
                ? { flex: 1, minWidth: 0 }
                : layout === 'LR'
                  ? { flex: `0 0 calc(100% - ${termSizeLr}px - 6px)`, minWidth: 0 }
                  : { flex: `0 0 calc(100% - ${termSizeTb}px - 6px)`, minHeight: 0 }
            }
          >
            {renderDocContent()}
            {/* 文档折叠按钮（Peek）放在文档区角落 */}
            {!docCollapsed && (
              <button
                className="doc-collapse-btn"
                title="折叠文档为浮动"
                onClick={() => setDocCollapsed(true)}
              >
                ⤢
              </button>
            )}
          </div>
          {/* 拖动条（终端隐藏或文档折叠时不渲染） */}
          {!termHidden && !docCollapsed && (
            <div
              className={`term-splitter ${layout === 'LR' ? 'lr' : 'tb'}`}
              onMouseDown={startTermDrag}
            />
          )}
          {/* 终端区（隐藏时 CSS 移出流但保留实例） */}
          <div
            className={`term-pane ${termHidden ? 'hidden' : ''}`}
            style={
              termHidden
                ? undefined
                : layout === 'LR'
                  ? { flex: `0 0 ${termSizeLr}px`, minWidth: 0 }
                  : { flex: `0 0 ${termSizeTb}px`, minHeight: 0 }
            }
          >
            {activeId ? (
              <TerminalPane tools={tools} activeId={activeId} />
            ) : (
              <div className="placeholder">选择一个工具</div>
            )}
          </div>
        </div>
        {/* 文档折叠为 Peek（浮动层） */}
        {docCollapsed && active && (
          <div className="doc-peek">
            <div className="doc-peek-header">
              <span>文档</span>
              <button title="展开文档" onClick={() => setDocCollapsed(false)}>▾</button>
            </div>
            <div className="doc-peek-body" style={{ width: `${helpWidth}px` }}>
              {renderDocContent()}
            </div>
          </div>
        )}
      </section>
      {editingId && active && (
        <EditorModal
          tool={active}
          onDone={() => setEditingId(null)}
          existingGroups={existingGroups}
        />
      )}
```

- [ ] **Step 6: 抽取 renderDocContent 函数**

把原 `renderHelp` 里的 HelpPane 渲染部分（`App.tsx:252-282` 的 HelpPane + toolbar 部分）抽成独立函数 `renderDocContent`：

```tsx
  // 文档区内容（docked 和 Peek 共用）。含工具栏（删除/导出/记录/重载/添加/编辑）+ HelpPane。
  const renderDocContent = () =>
    active ? (
      <>
        <div className="help-toolbar">
          <button title="删除" className="danger" onClick={() => deleteTool(active.meta.id)}>删除</button>
          <button title="导出该工具为 JSON" onClick={() => exportOne(active.meta.id)}>导出</button>
          <button title="该工具的配置记录" onClick={() => setRecordsToolId(active.meta.id)}>记录</button>
          {active.meta.useRemote && (
            <button title="重新拉取远程内容" onClick={() => api.refreshMd()}>重载</button>
          )}
          {!active.meta.useRemote && (
            <button title="快速添加命令（追加到末尾）" onClick={() => setQuickAddOpen(true)}>添加</button>
          )}
          <button title="编辑" className="primary" onClick={() => setEditingId(active.meta.id)}>编辑</button>
        </div>
        <HelpPane
          tool={active}
          activeToolId={active.meta.id}
          isRemote={!!active.meta.useRemote}
          markdown={active.meta.useRemote ? active.remoteMarkdown ?? '' : active.helpMarkdown}
          onPreview={openPreview}
          sidebarToc={false}
          termHidden={termHidden}
        />
      </>
    ) : (
      <div className="placeholder">无选中工具</div>
    );
```

> 注意：`HelpPane` 新增了 `termHidden` prop（Task 10 加门控时用）。删掉原 `renderHelp` 函数。

- [ ] **Step 7: 重命名 helpCollapsed → docCollapsed**

把 `src/renderer/App.tsx` 里所有 `helpCollapsed`/`setHelpCollapsed` 改为 `docCollapsed`/`setDocCollapsed`（state 声明 line 62-64 + persist effect line 120-122 + 新 JSX）。localStorage key 保持 `termstep:help-collapsed`（向后兼容，不丢用户偏好）。

- [ ] **Step 8: 加 CSS 新布局类**

在 `src/renderer/styles.css` 合适位置（`.terminal-area` 附近，line 245 之后）追加：

```css
/* 统一布局：主区 = 顶栏 + 双面板主体 */
.main-area {
  flex: 1; min-width: 0; min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
  position: relative; /* 给 doc-peek 浮动层做定位基准 */
}
.term-header { /* 复用现有 term-header 样式，保持不变 */ }

.main-body { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
.main-body.layout-lr { flex-direction: row; }
.main-body.layout-tb { flex-direction: column; }

.doc-pane {
  background: var(--surface); color: var(--text);
  display: flex; flex-direction: column; overflow: hidden;
  position: relative; /* 给折叠按钮定位 */
  min-width: 0; min-height: 0;
}
.layout-lr > .doc-pane { border-right: 1px solid var(--border); }
.layout-tb > .doc-pane { border-bottom: 1px solid var(--border); }

.doc-collapse-btn {
  position: absolute; top: 6px; right: 6px;
  z-index: 10; padding: 2px 8px;
  background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius); cursor: pointer; color: var(--text-weak);
}
.doc-collapse-btn:hover { background: var(--accent-weak); }

.term-splitter { flex: 0 0 6px; z-index: 10; background: transparent; }
.term-splitter.lr { cursor: col-resize; width: 6px; }
.term-splitter.tb { cursor: row-resize; height: 6px; }
.term-splitter:hover, .term-splitter:active { background: var(--accent-weak); }

.term-pane {
  background: var(--term-bg); min-width: 0; min-height: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
/* 终端隐藏：移出 flex 流但保留非零尺寸（避免 xterm display:none 不画提示符坑）。
   pty + xterm 实例都保留在 termRegistry，重新显示立即可见。 */
.term-pane.hidden {
  position: absolute; top: 0; left: 0;
  width: 100%; height: 100%;
  visibility: hidden; pointer-events: none;
  z-index: -1;
}

/* 文档 Peek（折叠态浮动层） */
.doc-peek {
  position: absolute; top: 40px; right: 16px;
  z-index: 50; background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-md); overflow: hidden;
  display: flex; flex-direction: column;
}
.doc-peek-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  font-size: 12px; color: var(--text-weak);
}
.doc-peek-body { max-height: 70vh; overflow: auto; }
```

同时删除/废弃旧样式：
- `.terminal-area`（line 245-249）——保留或改为 `.main-area` 别名（如果有其他地方引用 `.terminal-area`，全局搜索替换）
- `.help-area.document-mode`（line 1252-1254）——删除
- `.help-resizer`（line 773-777）——删除（被 `.term-splitter` 取代）

- [ ] **Step 9: 全局搜索清理旧类名引用**

Run: `grep -rn "terminal-area\|help-area\|help-resizer\|document-mode" src/renderer/ | grep -v styles.css | head -20`

Expected: 找出 JSX 里引用旧类名的地方，逐个替换为新类名（`.main-area` / `.doc-pane` / `.term-splitter`）。`help-area` 在 HelpPane.tsx 内部可能还有引用——检查是否需要保留（HelpPane 内部滚动区样式）。

- [ ] **Step 10: typecheck + 手动验证**

Run: `npm run typecheck 2>&1 | tail -15`

Expected: PASS。

手动验证（`npm run dev`）：
- [ ] 普通 LR 工具：文档左、终端右，拖动条左右拖改终端宽度
- [ ] TB 工具（改配置后）：文档上、终端下，拖动条上下拖改终端高度
- [ ] 点「隐藏终端」按钮：终端消失、文档撑满；pty 仍在（重启终端能恢复输出）
- [ ] 点「显示终端」：终端回来，输出历史保留
- [ ] 点「折叠文档」：文档变 Peek 浮动，终端撑满
- [ ] 切换工具：termHidden 按新工具配置重置

- [ ] **Step 11: 提交**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(layout): App.tsx 统一双面板布局 + termHidden + 双方向拖动条

- 主区永远渲染 doc-pane + term-pane，layout(LR/TB) 决定 flex-direction
- 顶栏上提到 main-area 顶部，跨布局一致
- termHidden 运行时 state（初值取自 meta.terminalHidden，切换工具重置）
- 终端隐藏用 visibility:hidden + position:absolute（保留 xterm 实例）
- 拖动条全局共享 termSizeLr/termSizeTb 两个 localStorage key
- helpCollapsed→docCollapsed 重命名（Peek 机制保留）"
```

---

## Task 10: 按钮门控 — termHidden 时提示「请先打开终端」

**Files:**
- Modify: `src/renderer/lib/clipboardToast.ts`（导出 showToast）
- Modify: `src/renderer/components/HelpPane.tsx`（onClick 加门控 + 接收 termHidden prop）
- Modify: `src/renderer/components/QuickCommands.tsx`（onRun 加门控）

- [ ] **Step 1: 导出 showToast 为通用方法**

`src/renderer/lib/clipboardToast.ts:15` 把 `function showToast` 改为 `export function showToast`：

```ts
export function showToast(text: string): void {
```

- [ ] **Step 2: HelpPane 加 termHidden prop**

`src/renderer/components/HelpPane.tsx` 顶部 props 类型定义（找到 `export function HelpPane(props: {`）追加 `termHidden: boolean`：

```tsx
export function HelpPane(props: {
  tool: Tool;
  activeToolId: string;
  isRemote: boolean;
  markdown: string;
  onPreview: (s: PreviewState) => void;
  sidebarToc: boolean;
  termHidden: boolean;
}) {
```

- [ ] **Step 3: HelpPane onClick 加门控**

`src/renderer/components/HelpPane.tsx:175-184` 的 onClick 开头（`const btn = ...` 之后、复制检查之前）插入门控：

```tsx
      const btn = (e.target as HTMLElement).closest('.cmd-btn') as HTMLButtonElement | null;
      if (btn) {
        const command = btn.dataset['cmd'] ?? '';
        // ⌘/Ctrl + 点击：复制命令到剪贴板，不输入终端。
        if (e.metaKey || e.ctrlKey) {
          void copyOnModifier(e, command);
          return;
        }
        // 终端隐藏时：点按钮提示打开终端，不执行（复制照常）。
        if (props.termHidden) {
          showToast('请先打开终端');
          return;
        }
        const edit = btn.dataset['edit'] === '1';
        // ... 后续不变
```

> 注意顶部 import 加 `showToast`：
> ```tsx
> import { copyOnModifier, showToast } from '../lib/clipboardToast';
> ```

- [ ] **Step 4: QuickCommands 加门控（从 props 接收 termHidden）**

`src/renderer/components/QuickCommands.tsx` 的 props 加 `termHidden: boolean`，`run` 函数（line 50-77）开头插入门控：

```tsx
  const run = (command: string, edit: boolean, params: ButtonParam[] | undefined, e?: React.MouseEvent) => {
    const a = props.activeTool;
    if (!a) return;
    // ⌘/Ctrl + 点击：复制命令到剪贴板，不输入终端。
    if (e && (e.metaKey || e.ctrlKey)) {
      void copyOnModifier(e, command);
      setOpen(false);
      return;
    }
    // 终端隐藏时：提示打开终端，不执行（复制照常）。
    if (props.termHidden) {
      showToast('请先打开终端');
      setOpen(false);
      return;
    }
    const opts: PtySpawnOpts = {
      // ... 后续不变
```

> 顶部 import 加 showToast。App.tsx 里 `<QuickCommands activeTool={active} />` 改为 `<QuickCommands activeTool={active} termHidden={termHidden} />`。

- [ ] **Step 5: termRegistry.runCommand 去掉隐式 no-term 写入（显式门控已前置）**

`src/renderer/lib/termRegistry.ts:24-32` 的 `runCommand`，当 `term` 不存在时不再静默 `api.pty.write`（避免隐藏态下的残留写入）：

```ts
export function runCommand(toolId: string, command: string, edit: boolean, opts: PtySpawnOpts) {
  const term = termRegistry.get(toolId);
  if (!term) {
    // 不应到达此处：调用方（HelpPane/QuickCommands）已在 termHidden 时拦截。
    // 防御性静默返回，避免隐藏态残留写入 pty。
    return;
  }
  term.paste(command);
  if (!edit) api.pty.write(toolId, '\r', opts);
}
```

- [ ] **Step 6: typecheck 验证**

Run: `npm run typecheck 2>&1 | tail -15`

Expected: PASS。

- [ ] **Step 7: 手动验证门控**

`npm run dev` 后：
- [ ] 隐藏终端时点命令按钮 → toast「请先打开终端」
- [ ] 隐藏终端时 ⌘/Ctrl+click 命令按钮 → 复制照常（toast「已复制到剪贴板」）
- [ ] 显示终端时点命令按钮 → 正常执行
- [ ] 文档 Peek 中点按钮 → 按主终端 termHidden 状态门控

- [ ] **Step 8: 提交**

```bash
git add src/renderer/lib/clipboardToast.ts src/renderer/lib/termRegistry.ts \
        src/renderer/components/HelpPane.tsx src/renderer/components/QuickCommands.tsx \
        src/renderer/App.tsx
git commit -m "feat(layout): 终端隐藏时点按钮提示「请先打开终端」，复制照常

- showToast 导出为通用方法
- HelpPane/QuickCommands 加 termHidden prop，onClick 显式门控
- termRegistry.runCommand 去掉隐式 no-term 写入（防御性静默）"
```

---

## Task 11: EditorPane 配置 UI — 替换模式 radio 为布局方向 + 终端初始状态

**Files:**
- Modify: `src/renderer/components/EditorPane.tsx:56-58`（typeMode state）、`EditorPane.tsx:118-141`（save opts）、`EditorPane.tsx:247-273`（radio UI）

- [ ] **Step 1: 替换 typeMode state 为 layout + terminalHidden**

`src/renderer/components/EditorPane.tsx:56-58`：

```tsx
  const [typeMode, setTypeMode] = useState<'terminal' | 'document'>(
    meta.type === 'document' ? 'document' : 'terminal',
  );
```

替换为：

```tsx
  const [layout, setLayout] = useState<'LR' | 'TB'>(meta.layout === 'TB' ? 'TB' : 'LR');
  const [terminalHidden, setTerminalHidden] = useState<boolean>(!!meta.terminalHidden);
```

- [ ] **Step 2: 替换 save() 的 type 字段为 layout + terminalHidden**

`src/renderer/components/EditorPane.tsx:134-141`（type 字段块）：

```tsx
      // terminal 模式发空串让 mergeToolJson 裁掉 type 字段（保持 tool.json 干净，
      // 与旧 terminal 文件一致）；document 保留显式 'document'。
      // ToolMeta.type 的静态类型不含 ''，故此处断言为 ''——mergeToolJson 的
      // PRUNE_WHEN_EMPTY_STRING 正是为 '' 设计的裁剪标记。
      type: (typeMode === 'terminal' ? '' : 'document') as 'terminal' | 'document',
```

替换为：

```tsx
      // layout 默认 LR 发空串让 mergeToolJson 裁掉（保持 tool.json 干净）；
      // TB 保留显式值。terminalHidden 默认 false 不发（mergeToolJson 会 prune false）。
      layout: (layout === 'LR' ? '' : 'TB') as 'LR' | 'TB',
      terminalHidden: terminalHidden || undefined,
```

> 说明：`terminalHidden: undefined` 在 `mergeToolJson` 里被当作「不设置」跳过（line 14 的 `if (patch[k] !== undefined)`），不会污染 merged。`true` 则保留。也可以写 `terminalHidden,` 让 false 自然进去再被 prune——两种都行，用 `|| undefined` 更明确。

- [ ] **Step 3: 替换模式 radio UI**

`src/renderer/components/EditorPane.tsx:247-273`（整个 `.field` 块）替换为两个新控件：

```tsx
            <div className="field">
              <span className="field-label">
                布局方向 <em>LR=文档左/终端右；TB=文档上/终端下</em>
              </span>
              <div className="mode-radio-group" role="radiogroup" aria-label="布局方向">
                <label className="mode-radio">
                  <input
                    type="radio"
                    name="tool-layout"
                    value="LR"
                    checked={layout === 'LR'}
                    onChange={() => setLayout('LR')}
                  />
                  <span>LR（左右）</span>
                </label>
                <label className="mode-radio">
                  <input
                    type="radio"
                    name="tool-layout"
                    value="TB"
                    checked={layout === 'TB'}
                    onChange={() => setLayout('TB')}
                  />
                  <span>TB（上下）</span>
                </label>
              </div>
            </div>
            <div className="field">
              <span className="field-label">终端初始状态</span>
              <label className="mode-radio">
                <input
                  type="checkbox"
                  checked={terminalHidden}
                  onChange={(e) => setTerminalHidden(e.target.checked)}
                />
                <span>默认隐藏终端（仅看文档；运行时可随时显示）</span>
              </label>
            </div>
```

- [ ] **Step 4: typecheck 验证**

Run: `npm run typecheck 2>&1 | tail -15`

Expected: PASS。

- [ ] **Step 5: 手动验证配置 UI**

`npm run dev` 后：
- [ ] 打开编辑器：看到「布局方向 LR/TB」radio + 「默认隐藏终端」checkbox
- [ ] 选 TB + 勾选隐藏 → 保存 → 工具变为 TB 布局、终端隐藏
- [ ] 检查 tool.json：应只有 `layout:"TB"` 和 `terminalHidden:true`，无 `type` 字段
- [ ] 新建普通工具（不设布局/隐藏）→ tool.json 应无 layout/terminalHidden 字段（被 prune）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/EditorPane.tsx
git commit -m "feat(layout): 编辑器替换模式 radio 为布局方向 + 终端初始状态控件"
```

---

## Task 12: TerminalView 适配隐藏态

**Files:**
- Modify: `src/renderer/components/TerminalView.tsx`（适配 termHidden 下的生命周期）

> 说明：现在终端隐藏是 `.term-pane.hidden` CSS 控制（visibility:hidden + position:absolute，保留非零尺寸）。TerminalView 原本用 `display:none` 切换非 active 工具——这套机制在统一布局下需要重新审视。
>
> 关键点：现在所有工具的 TerminalView 都会渲染（不像旧 document 模式那样跳过），隐藏的工具用 `active=false` → `display:none`。但 `display:none` 会让 xterm 不画——所以**隐藏的工具不应创建 xterm**（保持原逻辑：active 才创建）。但**已创建的 xterm 在工具切换走时不应 dispose**（保留实例）。现有逻辑已经满足：active 工具创建、非 active 不创建、dispose 只在组件 unmount。
>
> 本 task 主要是验证现有逻辑在新布局下还能工作，并做必要微调。

- [ ] **Step 1: 审视 TerminalView 的 active 和 display 逻辑**

读 `src/renderer/components/TerminalView.tsx:33-47`（active 才创建）和 `190-202`（display 切换）。确认：
- 非激活工具：`active=false`，不创建 xterm，`display:none`
- 激活工具：`active=true`，创建 xterm，`display:block`
- 切走工具：`active=false`，xterm 不 dispose（cleanup 只在 unmount），但 `display:none`

**问题**：现在 `display:none` 下 xterm 不画——但切回来时 `active=true` 会触发 `requestAnimationFrame + fit()`（line 132-145），重画正常。所以切换工具时短暂不可见是 OK 的。

**新问题**：同一个激活工具，`termHidden=true` 时 `.term-pane.hidden` 把整个容器 visibility:hidden——但容器在 DOM 里、有非零尺寸，xterm 应该还能画（虽然看不见）。切回 `termHidden=false` 时，容器恢复可见，xterm 立即可见。**不需要改 TerminalView**。

- [ ] **Step 2: 但 ResizeObserver 需要检查**

`TerminalView.tsx:155-175` 的 ResizeObserver 在 `props.active` 为 false 时不 fit。但隐藏态下 `active` 仍是 true（工具还是激活的，只是终端隐藏了）。容器尺寸变化（隐藏→显示可能伴随布局重排）会触发 ResizeObserver，应该能正常 fit。

**潜在问题**：`.term-pane.hidden` 用 `position:absolute; width:100%; height:100%`——它脱离了父 flex 流，尺寸跟显示态不同。隐藏时 fit 出的 cols/rows 可能不对。**但隐藏态不需要 fit**（反正看不见）。切回显示时，ResizeObserver 会捕捉到尺寸变化重新 fit。

手动验证即可，暂不改代码。

- [ ] **Step 3: 手动验证 xterm 在隐藏/显示切换下的行为**

`npm run dev` 后，针对一个工具：
- [ ] 显示终端 → 执行 `ls` → 看到输出
- [ ] 点「隐藏终端」→ 终端消失，文档撑满
- [ ] 点「显示终端」→ 终端回来，`ls` 的输出**仍在**（关键：xterm 实例没被 dispose，缓冲保留）
- [ ] 隐藏 → 执行命令（应被门控 toast 拦截，不会到终端）→ 显示后终端无新输出（确认门控生效）
- [ ] 切到另一个工具再切回来 → 终端输出仍在

- [ ] **Step 4: 如果验证发现问题，针对性修复**

如果「显示后输出丢失」或「显示后空白」：可能需要在 `termHidden` 从 true→false 切换时主动触发一次 `fit()` + `refresh()`。这时需要把 `termHidden` 作为 prop 传给 TerminalPane/TerminalView，加一个 effect：

```tsx
  // termHidden 从 true→false 时，主动 fit + refresh（ResizeObserver 可能漏掉首帧）。
  useEffect(() => {
    if (!props.termHidden && termRef.current && fitRef.current) {
      requestAnimationFrame(() => {
        try { fitRef.current?.fit(); } catch {}
        termRef.current?.refresh(0, termRef.current.rows - 1);
      });
    }
  }, [props.termHidden]);
```

> 只有 Step 3 验证出问题才加这个。否则跳过。

- [ ] **Step 5: 提交（如有改动）**

```bash
git add src/renderer/components/TerminalView.tsx src/renderer/components/TerminalPane.tsx
git commit -m "fix(layout): TerminalView 适配隐藏/显示切换（必要时主动 fit+refresh）"
```

> 如果 Step 3 验证无问题、没改代码，则跳过本提交。

---

## Task 13: 更新测试 — pure.rs 和 toolConfig.test.ts 去 type、加 layout/terminalHidden

**Files:**
- Modify: `tests/toolConfig.test.ts:112+`（parseToolMeta type 测试）
- Modify: `src-tauri/src/pure.rs` 内联测试（parse_tool_meta type 相关测试，如果有）
- Modify: `tests/toolJson.test.ts:71-90`（mergeToolJson type 测试）

- [ ] **Step 1: 更新 toolConfig.test.ts**

`tests/toolConfig.test.ts:112+` 的 `describe('parseToolMeta type', ...)` 整块替换为：

```ts
describe('parseToolMeta layout/terminalHidden', () => {
  it('parses layout=TB', () => {
    const m = parseToolMeta({ name: 't', layout: 'TB' });
    expect(m.layout).toBe('TB');
  });
  it('parses layout=LR', () => {
    const m = parseToolMeta({ name: 't', layout: 'LR' });
    expect(m.layout).toBe('LR');
  });
  it('layout defaults undefined when missing', () => {
    const m = parseToolMeta({ name: 't' });
    expect(m.layout).toBeUndefined();
  });
  it('drops invalid layout values', () => {
    const m = parseToolMeta({ name: 't', layout: 'diagonal' });
    expect(m.layout).toBeUndefined();
  });
  it('parses terminalHidden=true', () => {
    const m = parseToolMeta({ name: 't', terminalHidden: true });
    expect(m.terminalHidden).toBe(true);
  });
  it('parses terminalHidden=false', () => {
    const m = parseToolMeta({ name: 't', terminalHidden: false });
    expect(m.terminalHidden).toBe(false);
  });
  it('terminalHidden defaults undefined when missing', () => {
    const m = parseToolMeta({ name: 't' });
    expect(m.terminalHidden).toBeUndefined();
  });
});
```

- [ ] **Step 2: 更新 toolJson.test.ts 的 mergeToolJson type 测试**

`tests/toolJson.test.ts:71-90` 的 `describe('mergeToolJson type', ...)` 替换为：

```ts
describe('mergeToolJson layout/terminalHidden', () => {
  it('prunes cleared layout (empty string)', () => {
    const merged = mergeToolJson({ name: 't', layout: 'TB' }, { layout: '' });
    expect(merged).toEqual({ name: 't' });
    expect('layout' in merged).toBe(false);
  });
  it('keeps layout=TB', () => {
    const merged = mergeToolJson({ name: 't' }, { layout: 'TB' });
    expect(merged).toEqual({ name: 't', layout: 'TB' });
  });
  it('keeps existing layout when patch does not touch it', () => {
    const merged = mergeToolJson({ name: 't', layout: 'TB' }, { cwd: '/x' });
    expect(merged).toEqual({ name: 't', layout: 'TB', cwd: '/x' });
  });
  it('prunes terminalHidden=false', () => {
    const merged = mergeToolJson({ name: 't', terminalHidden: true }, { terminalHidden: false });
    expect(merged).toEqual({ name: 't' });
    expect('terminalHidden' in merged).toBe(false);
  });
  it('keeps terminalHidden=true', () => {
    const merged = mergeToolJson({ name: 't' }, { terminalHidden: true });
    expect(merged).toEqual({ name: 't', terminalHidden: true });
  });
});
```

- [ ] **Step 3: 更新 pure.rs 内联测试（如果有 type 测试）**

Run: `grep -n "type.*document\|tool_type" src-tauri/src/pure.rs | head -10`

Expected: 找出 pure.rs 里的 type 相关测试。替换为 layout/terminalHidden 测试（参照 Step 1/2 的用例）。如果 pure.rs 没有内联 type 测试（测试都在 toolConfig.test.ts），跳过。

- [ ] **Step 4: 运行所有测试验证全绿**

Run: `npm run test 2>&1 | tail -20 && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/toolConfig.test.ts tests/toolJson.test.ts src-tauri/src/pure.rs
git commit -m "test(layout): 更新测试覆盖 layout/terminalHidden，移除 type 用例"
```

---

## Task 14: 最终验证 + 清理

**Files:**
- 全局检查残留 `type` 引用

- [ ] **Step 1: 全局搜索残留 type/tool_type 引用**

Run: `grep -rn "\.type\b\|meta\.type\|tool_type\|isDocument\|typeMode\|helpCollapsed\|terminal-area\|help-area\|help-resizer\|document-mode\|startHelpDrag" src/ src-tauri/src/ tests/ 2>/dev/null | grep -v "node_modules\|target\|\.d\.ts" | head -30`

Expected: 只应有合法的 `.type` 引用（如 React 事件类型、CSS type 属性等）。不应再有 `meta.type`、`tool_type`、`isDocument`、`typeMode`、`helpCollapsed`、旧类名等。逐个检查并清理。

- [ ] **Step 2: 全套验证**

Run: `npm run typecheck && npm run test && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5 && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`

Expected: 全绿。

- [ ] **Step 3: 完整手动验证清单**

`npm run dev` 后逐条过：
- [ ] 老 `type:"document"` 工具迁移后：TB 布局、终端隐藏、文档撑满；点「显示终端」后能正常执行命令、看到输出
- [ ] LR 布局拖动条改宽度，切到 TB 布局（改配置保存），宽度值不串到高度；切回 LR 宽度仍在
- [ ] 终端隐藏时点按钮 → toast「请先打开终端」；⌘/Ctrl+click 复制照常
- [ ] toggle 隐藏→显示→再隐藏：输出历史保留
- [ ] 文档折叠为 Peek：终端撑满；Peek 中点按钮按主终端 termHidden 状态门控
- [ ] 普通 terminal 工具（无新字段）：行为零变化（LR 布局、终端可见）
- [ ] 新建工具：默认 LR + 终端可见，tool.json 干净（无 layout/terminalHidden/type 字段）
- [ ] 编辑器：布局方向 radio + 终端初始状态 checkbox 正常工作
- [ ] 重启终端按钮（含 ⌘ 强制重启）正常
- [ ] 快速命令（QuickCommands）在终端隐藏时也正确门控

- [ ] **Step 4: 更新 AGENTS.md（如有必要）**

检查 `AGENTS.md` 是否有 `type:"terminal"|"document"` 或「文档模式」的描述需要更新。如果有，简要更新（统一布局系统取代二元模式）。如果文档里没有相关描述或描述仍然大致正确，跳过。

- [ ] **Step 5: 如有清理改动，提交**

```bash
git add -A
git commit -m "chore(layout): 清理残留引用，最终验证全绿"
```

---

## 完成后

实现完成后，调用 `superpowers:finishing-a-development-branch` skill 决定如何整合（合并回 main / 开 PR / 清理）。

## 非目标提醒

- ❌ 不引入运行时布局方向 toggle（仅配置控制）
- ❌ 不做每个工具独立尺寸记忆（全局共享两个值）
- ❌ 不保留「纯文档工具」类型概念
- ❌ 不引入新 toast 依赖
- ❌ 不改后端 pty 池模型（除了删 document 早返回）
- ❌ 不改按钮解析/markdown 渲染
