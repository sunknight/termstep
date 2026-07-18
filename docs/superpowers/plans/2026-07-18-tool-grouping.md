# 工具分组（Tool Grouping）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给工具增加「分组」字段，工具列表按分组分区展示、可折叠，组内拖拽排序。

**Architecture:** `ToolMeta.group?: string`（隐式分组）+ `order.json` 新增同级 `groups` 数组（展示顺序）+ flat `order` 数组保持组内顺序。拖拽仅组内；跨组走编辑器。`ScanResult.groups` 经所有 emit 路径传到前端。

**Tech Stack:** Rust（serde, tokio）/ TypeScript / React 18 / vitest。

**Spec:** `docs/superpowers/specs/2026-07-18-tool-grouping-design.md`。

**前置基线（开始前确认全绿）：**
```bash
npm run typecheck && npm run test && cargo test --manifest-path src-tauri/Cargo.toml
```

**分支：** 在 `main` 上新开分支（见 §「开始前」）。

---

## 文件结构

**新增：**
- `src/shared/grouping.ts` — 纯函数 `buildGroupedView`（vitest 可测），渲染端唯一分组逻辑来源。
- `tests/grouping.test.ts` — 覆盖 buildGroupedView 的所有分支。

**修改（渲染端）：**
- `src/shared/types.ts` — `ToolMeta.group`、`ScanResult.groups`。
- `src/shared/toolConfig.ts` — `parseToolMeta` 解析 `group`。
- `src/shared/toolJson.ts` — `PRUNE_WHEN_EMPTY_STRING` 加 `'group'`。
- `src/renderer/components/Sidebar.tsx` — 分组渲染 + 折叠态 + 同组拖拽守卫。
- `src/renderer/components/EditorPane.tsx` — 分组 combobox 输入。
- `src/renderer/App.tsx` — 透传 `groups` 与 `existingGroups` props。
- `src/renderer/styles.css` — `.group-header` 样式。

**修改（后端）：**
- `src-tauri/src/types.rs` — `ToolMeta.group`、`ScanResult.groups`。
- `src-tauri/src/tool_io.rs` — `OrderIndex` 结构 + 重构 `read/write_order_index` + 新增 `append_group_if_new`。
- `src-tauri/src/pure.rs` — `parse_tool_meta` 加 group；`merge_tool_json` prune 加 `group`。
- `src-tauri/src/tools.rs` — `scan_tools` 填 `result.groups`。
- `src-tauri/src/commands.rs` — `tool_save` 调 `append_group_if_new`；`tool_delete`/`emit_reordered` 保留 `groups`。

**不改：** `api.ts`、`IPC` 常量、`tool_create`/`tool_reorder` 签名、bundle、pty、迁移链、capabilities。

---

## 开始前：建分支 + 基线

- [ ] **Step 0.1: 确认基线全绿**

Run:
```bash
npm run typecheck && npm run test && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```
Expected: typecheck 通过、vitest 全过、cargo test `test result: ok`。

- [ ] **Step 0.2: 新建分支**

```bash
git checkout -b feat/tool-grouping
```

---

## Task 1: 后端 — ToolMeta / ScanResult 加 group & groups 字段

**Files:**
- Modify: `src-tauri/src/types.rs:6-33`（ToolMeta）、`src-tauri/src/types.rs:52-57`（ScanResult）

- [ ] **Step 1.1: ToolMeta 加 `group` 字段**

在 `src-tauri/src/types.rs` 的 `ToolMeta` 结构体中，在 `source_id` 字段**之后**（第 32 行后、结构体闭合 `}` 之前）追加：

```rust
    /// 分组名（用户赋值，自由文本）。空/None = 未分组。仅用于侧栏展示分区，
    /// 不影响执行。与 `meta.group` 对偶 src/shared/types.ts。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
```

- [ ] **Step 1.2: ScanResult 加 `groups` 字段**

在 `src-tauri/src/types.rs` 的 `ScanResult` 结构体（约 52-57 行）中，在 `errors` 字段后追加：

```rust
    /// 分组展示顺序（来自 tools/order.json 的 groups 数组）。渲染端据此按
    /// 索引顺序画分组标题；工具引用但未在此列表里的分组追加其后。
    #[serde(default)]
    pub groups: Vec<String>,
```

> 注：`ScanResult` 已 `#[derive(Default)]`，`Vec<String>` 的 default 是空 vec，无需额外 impl。

- [ ] **Step 1.3: cargo check 验证编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`

Expected: 编译失败，报 `parse_tool_meta` 缺少 `group` 字段（struct literal 没初始化新字段）。这是预期的——下一 Task 修。**若编译通过则说明 struct literal 在别处，grep 确认 `ToolMeta {` 所有调用点都补上 `group: None`。**

```bash
grep -rn "ToolMeta {" src-tauri/src/
```

- [ ] **Step 1.4: Commit**

```bash
git add src-tauri/src/types.rs
git commit -m "feat(0.9.x): ToolMeta/ScanResult 增加 group/groups 字段"
```

---

## Task 2: 后端 — parse_tool_meta & merge_tool_json 支持 group

**Files:**
- Modify: `src-tauri/src/pure.rs:179-241`（parse_tool_meta）、`src-tauri/src/pure.rs:26`（merge prune）、`src-tauri/src/pure.rs:194-208`（struct literal）

- [ ] **Step 2.1: 写失败测试 — parse_tool_meta 解析 group**

在 `src-tauri/src/pure.rs` 的 `#[cfg(test)] mod tests` 里（`parse_tool_meta` 测试组下方，约第 365 行 `// ── scan_tool_risks` 注释前）插入：

```rust
    #[test]
    fn meta_parses_group() {
        let m = parse_tool_meta(&json!({"name":"A","group":"前端"}), "x");
        assert_eq!(m.group.as_deref(), Some("前端"));
    }

    #[test]
    fn meta_drops_blank_group() {
        // 空串/纯空白 group 视为缺失 → None
        let m = parse_tool_meta(&json!({"name":"A","group":"   "}), "x");
        assert_eq!(m.group, None);
    }

    #[test]
    fn meta_group_defaults_none() {
        let m = parse_tool_meta(&json!({"name":"A"}), "x");
        assert_eq!(m.group, None);
    }
```

- [ ] **Step 2.2: 写失败测试 — merge_tool_json 清空 group 时 prune**

在同 mod 内（`merge_prunes_mdurl_and_dependents` 测试后，约第 305 行）插入：

```rust
    #[test]
    fn merge_prunes_cleared_group() {
        let existing = json!({"name":"A","group":"前端"});
        let patch = json!({"group":""});
        let m = merge_tool_json(&existing, &patch);
        assert!(m.get("group").is_none(), "cleared group must be pruned");
    }

    #[test]
    fn merge_keeps_group_when_set() {
        let existing = json!({"name":"A"});
        let patch = json!({"group":"后端"});
        let m = merge_tool_json(&existing, &patch);
        assert_eq!(m["group"], "后端");
    }
```

- [ ] **Step 2.3: 运行测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure::tests::meta_parses_group pure::tests::meta_drops_blank_group pure::tests::meta_group_defaults_none pure::tests::merge_prunes_cleared_group pure::tests::merge_keeps_group_when_set 2>&1 | tail -20`

Expected: 编译错误（`group` 字段未初始化）或测试 FAIL。这是 TDD 的红灯。

- [ ] **Step 2.4: 实现 — parse_tool_meta struct literal 加 `group: None`**

在 `src-tauri/src/pure.rs` 的 `parse_tool_meta`（约 194-208 行），把 struct literal 末尾的 `source_id: None,` 改为：

```rust
        source_id: None,
        group: None,
    };
```

- [ ] **Step 2.5: 实现 — parse_tool_meta 解析 group**

在 `parse_tool_meta` 中 `source_id` 解析之后（约 237-239 行 `if let Some(sid) = trim_str_field(...)` 块之后、`meta` 返回之前）追加：

```rust
    if let Some(g) = trim_str_field(o, "group") {
        meta.group = Some(g);
    }
```

- [ ] **Step 2.6: 实现 — merge_tool_json prune 加 group**

在 `src-tauri/src/pure.rs:26`，把：

```rust
    for k in &["cwd", "tmux", "mdUrl"] {
```

改为：

```rust
    for k in &["cwd", "tmux", "mdUrl", "group"] {
```

- [ ] **Step 2.7: 运行测试，确认全过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure:: 2>&1 | tail -10`

Expected: 所有 pure::tests 通过，包括新加的 5 个。

- [ ] **Step 2.8: Commit**

```bash
git add src-tauri/src/pure.rs
git commit -m "feat(0.9.x): parse_tool_meta/merge_tool_json 支持 group 字段"
```

---

## Task 3: 后端 — order.json 扩展为 OrderIndex 结构

这是本计划**最危险的一步**：`read_order_index` 当前返回 `Vec<String>`，被多处直接当数组用（含 `tool_delete` 的 `.retain`、测试的 `vec![...]` 断言）。改成结构体会破坏所有调用点——必须一次性更新全部。

**Files:**
- Modify: `src-tauri/src/tool_io.rs:177-215`（read/write）+ 调用点
- 调用点清单（必须全部改）：
  - `src-tauri/src/tools.rs:426` — `scan_tools` 用 `index.order`
  - `src-tauri/src/commands.rs:173-179` — `tool_delete` 用 `index.order`
  - `src-tauri/src/tool_io.rs` 测试（多处 `assert_eq!(read_order_index(...), vec![...])`）

- [ ] **Step 3.1: 写失败测试 — OrderIndex 读 groups**

在 `src-tauri/src/tool_io.rs` 的 `#[cfg(test)] mod tests` 内（`read_order_index_*` 测试组后，约第 497 行）插入：

```rust
    #[test]
    fn read_order_index_returns_groups_when_present() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a","b"],"groups":["前端","后端"]}"#,
        )
        .unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.order, vec!["a".to_string(), "b".into()]);
        assert_eq!(idx.groups, vec!["前端".to_string(), "后端".into()]);
    }

    #[test]
    fn read_order_index_groups_default_empty_when_missing() {
        // 旧版 order.json（无 groups 键）→ groups 读为空（向后兼容）
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.order, vec!["a".to_string()]);
        assert!(idx.groups.is_empty(), "missing groups key → empty");
    }

    #[test]
    fn read_order_index_groups_default_empty_when_corrupt() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), "{ not json").unwrap();
        let idx = read_order_index(dir);
        assert!(idx.order.is_empty());
        assert!(idx.groups.is_empty());
    }
```

- [ ] **Step 3.2: 写失败测试 — write_order_index 保留 groups**

在同 mod 内追加：

```rust
    #[tokio::test]
    async fn write_order_index_preserves_existing_groups() {
        // write_order_index 只改 order，不得覆盖已存在的 groups
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a"],"groups":["前端"]}"#,
        )
        .unwrap();
        write_order_index(dir, &["b".into(), "a".into()]).await.unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.order, vec!["b".to_string(), "a".into()]);
        assert_eq!(idx.groups, vec!["前端".to_string()], "groups must be preserved");
    }
```

- [ ] **Step 3.3: 运行测试，确认编译失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tool_io:: 2>&1 | tail -30`

Expected: 编译失败——`read_order_index` 还返回 `Vec<String>`，无法 `.order`/`.groups`。预期。

- [ ] **Step 3.4: 实现 — 引入 OrderIndex 结构 + 重构 read_order_index**

在 `src-tauri/src/tool_io.rs` 中，把 `read_order_index`（约 182-202 行）整体替换为：

```rust
/// order.json 的内容：order（工具 id 的 flat 数组）+ groups（分组展示顺序）。
/// groups 是分组功能新增的键；旧版 order.json 没有它，读为空（向后兼容）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrderIndex {
    pub order: Vec<String>,
    pub groups: Vec<String>,
}

/// 读排序索引。缺失/损坏返回空 OrderIndex（scanner 对不在数组里的 id 兜底排末尾）。
/// 同步（std::fs）：scanner 是同步路径，对偶它。
pub fn read_order_index(tools_dir: &Path) -> OrderIndex {
    let file = tools_dir.join(ORDER_INDEX_FILE);
    let raw = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(_) => return OrderIndex::default(),
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return OrderIndex::default(),
    };
    let order = v
        .get("order")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let groups = v
        .get("groups")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    OrderIndex { order, groups }
}
```

- [ ] **Step 3.5: 实现 — write_order_index 改为 read-modify-write**

把 `write_order_index`（约 205-215 行）整体替换为：

```rust
/// 原子写排序索引：只更新 order，**保留**已存在的 groups（read-modify-write）。
/// 写临时文件再 rename，避免 watcher 读到半截 JSON。
pub async fn write_order_index(tools_dir: &Path, ordered_ids: &[String]) -> std::io::Result<()> {
    let mut idx = read_order_index(tools_dir); // 保留 groups
    idx.order = ordered_ids.to_vec();
    let obj = serde_json::json!({ "order": idx.order, "groups": idx.groups });
    let pretty = serde_json::to_string_pretty(&obj)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let final_path = tools_dir.join(ORDER_INDEX_FILE);
    let tmp = tools_dir.join(format!(".{}.tmp", ORDER_INDEX_FILE));
    tokio::fs::write(&tmp, format!("{}\n", pretty)).await?;
    tokio::fs::rename(&tmp, &final_path).await?;
    Ok(())
}
```

- [ ] **Step 3.6: 更新调用点 — tools.rs scan_tools**

在 `src-tauri/src/tools.rs:426`，把：

```rust
    let order_index = crate::tool_io::read_order_index(tools_dir);
    let position_of = |id: &str| order_index.iter().position(|x| x == id);
```

改为：

```rust
    let order_index = crate::tool_io::read_order_index(tools_dir);
    let position_of = |id: &str| order_index.order.iter().position(|x| x == id);
    result.groups = order_index.groups;
```

> 注意：`result.groups = order_index.groups;` 必须放在 `let mut result = ScanResult::default();` 之后、函数返回之前。原代码的 `result` 已在函数顶部声明，直接赋值即可。`result.groups` 字段是 Task 1 加的。

- [ ] **Step 3.7: 更新调用点 — commands.rs tool_delete**

在 `src-tauri/src/commands.rs:173-179`，把：

```rust
    // 从排序索引移除该 id（保持索引干净；失败不阻断删除）
    let mut order = tool_io::read_order_index(&td);
    let before_len = order.len();
    order.retain(|x| x != &tool_id);
    let order_changed = before_len != order.len();
    if order_changed {
        let _ = tool_io::write_order_index(&td, &order).await;
    }
```

改为（注意：`read_order_index` 现在返回 `OrderIndex`，要取 `.order`）：

```rust
    // 从排序索引移除该 id（保持索引干净；失败不阻断删除）
    let mut idx = tool_io::read_order_index(&td);
    let before_len = idx.order.len();
    idx.order.retain(|x| x != &tool_id);
    let order_changed = before_len != idx.order.len();
    if order_changed {
        let _ = tool_io::write_order_index(&td, &idx.order).await;
    }
```

- [ ] **Step 3.8: 更新测试 — tool_io.rs 里旧的 read_order_index 断言**

旧测试用 `assert_eq!(read_order_index(dir), vec!["a".into()])` 这种形式，现在返回 `OrderIndex`，必须改成 `.order`。

在 `src-tauri/src/tool_io.rs` 测试 mod 内，逐个改：

1. `read_order_index_returns_empty_when_missing`（第 469 行附近）：
   ```rust
   assert!(read_order_index(_dir.path()).order.is_empty());
   ```
2. `read_order_index_parses_array`（第 475 行附近）：
   ```rust
   assert_eq!(read_order_index(dir).order, vec!["a".to_string(), "b".into(), "c".into()]);
   ```
3. `read_order_index_returns_empty_on_corrupt_json`（第 483 行附近）：
   ```rust
   assert!(read_order_index(dir).order.is_empty());
   ```
4. `read_order_index_returns_empty_when_order_not_array`（第 491 行附近）：
   ```rust
   assert!(read_order_index(dir).order.is_empty());
   ```
5. `write_then_read_roundtrip`（第 500 行附近）：
   ```rust
   assert_eq!(read_order_index(dir).order, ids);
   ```
6. `tool_reorder_writes_index_file`（第 519 行附近）：
   ```rust
   assert_eq!(read_order_index(dir).order, ids);
   ```
7. `migrate_order_to_index_from_tool_json`（第 543 行附近）：
   ```rust
   assert_eq!(read_order_index(dir).order, vec!["docker".to_string(), "git".into()]);
   ```
8. `migrate_order_to_index_is_idempotent`（第 563 行附近，**两处**）：
   ```rust
   assert_eq!(read_order_index(dir).order, vec!["git".to_string()]);
   ```
9. `migrate_order_to_index_defaults_missing_order_to_zero`（第 583 行附近）：
   ```rust
   assert_eq!(read_order_index(dir).order, vec!["a".to_string(), "b".into()]);
   ```

逐个 `assert_eq!(read_order_index(...), vec![...])` → `assert_eq!(read_order_index(...).order, vec![...])`，`.is_empty()` → `.order.is_empty()`。

- [ ] **Step 3.9: cargo check + 跑全部 tool_io 测试**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10
cargo test --manifest-path src-tauri/Cargo.toml tool_io:: 2>&1 | tail -15
```

Expected: 编译通过；tool_io:: 全部测试通过（含新增的 `read_order_index_*groups*`、`write_order_index_preserves_existing_groups`）。

> 若仍有编译错误（如别处也调了 `read_order_index`），按 `grep -rn "read_order_index" src-tauri/src/` 定位并补 `.order`。

- [ ] **Step 3.10: 跑全量 cargo test 确认没破坏其它**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10`

Expected: `test result: ok`。

- [ ] **Step 3.11: Commit**

```bash
git add src-tauri/src/tool_io.rs src-tauri/src/tools.rs src-tauri/src/commands.rs
git commit -m "feat(0.9.x): order.json 扩展 OrderIndex 结构，新增 groups 键（向后兼容）"
```

---

## Task 4: 后端 — 新增 append_group_if_new + tool_save 调用

**Files:**
- Modify: `src-tauri/src/tool_io.rs`（新增函数）
- Modify: `src-tauri/src/commands.rs:86-109`（tool_save 追加调用）

- [ ] **Step 4.1: 写失败测试 — append_group_if_new**

在 `src-tauri/src/tool_io.rs` 测试 mod 内（Task 3 加的 `write_order_index_preserves_existing_groups` 之后）插入：

```rust
    #[tokio::test]
    async fn append_group_if_new_appends_when_absent() {
        let _dir = tmp();
        let dir = _dir.path();
        // 初始 order.json 无 groups
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.groups, vec!["前端".to_string()]);
        // order 不受影响
        assert_eq!(idx.order, vec!["a".to_string()]);
    }

    #[tokio::test]
    async fn append_group_if_new_noop_when_present() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a"],"groups":["前端"]}"#,
        )
        .unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap();
        let idx = read_order_index(dir);
        assert_eq!(idx.groups, vec!["前端".to_string()], "no duplicate");
    }

    #[tokio::test]
    async fn append_group_if_new_ignores_empty_and_none() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        append_group_if_new(dir, Some("   ")).await.unwrap();
        append_group_if_new(dir, None).await.unwrap();
        let idx = read_order_index(dir);
        assert!(idx.groups.is_empty(), "empty/None group must not be appended");
    }

    #[tokio::test]
    async fn append_group_if_new_appends_multiple_in_order() {
        let _dir = tmp();
        let dir = _dir.path();
        append_group_if_new(dir, Some("前端")).await.unwrap();
        append_group_if_new(dir, Some("后端")).await.unwrap();
        append_group_if_new(dir, Some("前端")).await.unwrap(); // 重复 → no-op
        let idx = read_order_index(dir);
        assert_eq!(idx.groups, vec!["前端".to_string(), "后端".into()]);
    }
```

- [ ] **Step 4.2: 运行测试，确认编译失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml append_group_if_new 2>&1 | tail -15`

Expected: 编译错误 `cannot find function append_group_if_new`。

- [ ] **Step 4.3: 实现 — append_group_if_new**

在 `src-tauri/src/tool_io.rs`，紧接 `write_order_index` 之后（约 215 行后）插入：

```rust
/// 若 group 非空且不在 order.json 的 groups 数组中，追加。已存在则 no-op。
/// 由 tool_save 在写完 tool.json 后调用：编辑器保存工具时若指定了新分组名，
/// 把它登记到 groups 索引里（展示顺序）。失败只返回 Err，由调用方决定降级。
pub async fn append_group_if_new(tools_dir: &Path, group: Option<&str>) -> std::io::Result<()> {
    let name = match group.map(str::trim).filter(|s| !s.is_empty()) {
        Some(g) => g,
        None => return Ok(()), // 未分组：不动 groups
    };
    let mut idx = read_order_index(tools_dir);
    if idx.groups.iter().any(|g| g == name) {
        return Ok(()); // 已登记 → no-op
    }
    idx.groups.push(name.to_string());
    let obj = serde_json::json!({ "order": idx.order, "groups": idx.groups });
    let pretty = serde_json::to_string_pretty(&obj)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let final_path = tools_dir.join(ORDER_INDEX_FILE);
    let tmp = tools_dir.join(format!(".{}.tmp", ORDER_INDEX_FILE));
    tokio::fs::write(&tmp, format!("{}\n", pretty)).await?;
    tokio::fs::rename(&tmp, &final_path).await?;
    Ok(())
}
```

- [ ] **Step 4.4: 运行测试，确认全过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml append_group_if_new 2>&1 | tail -10`

Expected: 4 个新测试全过。

- [ ] **Step 4.5: 实现 — tool_save 调用 append_group_if_new**

在 `src-tauri/src/commands.rs` 的 `tool_save`（约 86-109 行），在 `tool_io::tool_save(...)` 调用**之后**、`try_auto_commit` **之前**插入：

```rust
    // 分组登记：若 patch 带了 group 字段（非空），把它登记到 order.json 的 groups
    // 索引（展示顺序）。失败只告警不阻断——保存是首要功能，分组索引是附加。
    if let Some(g) = meta_patch.get("group").and_then(|v| v.as_str()) {
        if let Err(e) = tool_io::append_group_if_new(&td, Some(g)).await {
            eprintln!("tool_save: append_group_if_new failed: {}", e);
        }
    }
```

> 位置参考：现有 `tool_save` 体内顺序是 `validate → tool_io::tool_save → name 提取 → try_auto_commit`。新代码插在 `tool_io::tool_save` 之后、`name` 提取之前。

- [ ] **Step 4.6: cargo check + 全量测试**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: 编译通过；全量 cargo test `ok`。

- [ ] **Step 4.7: Commit**

```bash
git add src-tauri/src/tool_io.rs src-tauri/src/commands.rs
git commit -m "feat(0.9.x): append_group_if_new + tool_save 登记 group 到索引"
```

---

## Task 5: 后端 — tool_delete / emit_reordered 保留 groups（关键回归修复）

> **为什么需要：** `tool_delete` 和 `tool_reorder` 不走 watcher 全量 scan，而是**手工构造 ScanResult emit**。`ScanResult` 现在多了 `groups` 字段，若不填会 emit `groups: []`，前端在后台 scan 到达前会丢失分组索引（侧栏分组标题闪没）。必须从 order.json 读出 groups 带上。

**Files:**
- Modify: `src-tauri/src/commands.rs:148-197`（tool_delete 的 emit）、`src-tauri/src/commands.rs:228-265`（emit_reordered）

- [ ] **Step 5.1: 写失败测试 — emit_reordered 保留 groups**

`emit_reordered` 是 `commands.rs` 内的私有函数，不便单测。改为对 `tool_reorder` 命令做集成式断言太重。**替代策略**：把 emit 时读 groups 的逻辑下沉成一个小的可测纯函数 `build_reorder_scan_result`，或在 `tool_io` 里加一个 `read_groups` 辅助函数测它。

**选最小改动**：在 `tool_io.rs` 加一个 `read_groups` 薄封装并测它，commands 里用它。

先在 `src-tauri/src/tool_io.rs` 测试 mod 加：

```rust
    #[test]
    fn read_groups_returns_indexed_groups() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(
            dir.join("order.json"),
            r#"{"order":["a"],"groups":["前端","后端"]}"#,
        )
        .unwrap();
        assert_eq!(read_groups(dir), vec!["前端".to_string(), "后端".into()]);
    }

    #[test]
    fn read_groups_empty_when_missing() {
        let _dir = tmp();
        let dir = _dir.path();
        std::fs::write(dir.join("order.json"), r#"{"order":["a"]}"#).unwrap();
        assert!(read_groups(dir).is_empty());
    }
```

- [ ] **Step 5.2: 运行测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml read_groups 2>&1 | tail -10`

Expected: `cannot find function read_groups`。

- [ ] **Step 5.3: 实现 — read_groups 薄封装**

在 `src-tauri/src/tool_io.rs`，紧接 `append_group_if_new` 之后插入：

```rust
/// 读 order.json 的 groups 数组（展示顺序）。供不走全量 scan 的 emit 路径
/// （tool_delete / tool_reorder）带上 groups，避免前端在后台 scan 到达前
/// 丢失分组索引（侧栏分组标题闪没）。缺失/损坏返回空。
pub fn read_groups(tools_dir: &Path) -> Vec<String> {
    read_order_index(tools_dir).groups
}
```

- [ ] **Step 5.4: 运行测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml read_groups 2>&1 | tail -8`

Expected: 2 个新测试通过。

- [ ] **Step 5.5: 实现 — tool_delete 的 emit 带 groups**

在 `src-tauri/src/commands.rs` 的 `tool_delete`（约 181-188 行），把：

```rust
    {
        let mut s = lock_or_recover!(watcher_state);
        s.last_tools.retain(|t| t.meta.id != tool_id);
        let _ = handle.emit("tools:changed", &crate::types::ScanResult {
            tools: s.last_tools.clone(),
            errors: vec![],
        });
    }
```

改为（加 `groups`）：

```rust
    {
        let mut s = lock_or_recover!(watcher_state);
        s.last_tools.retain(|t| t.meta.id != tool_id);
        let _ = handle.emit("tools:changed", &crate::types::ScanResult {
            tools: s.last_tools.clone(),
            errors: vec![],
            groups: tool_io::read_groups(&td),
        });
    }
```

- [ ] **Step 5.6: 实现 — emit_reordered 带 groups**

`emit_reordered` 签名加 `tools_dir` 参数以便读 groups。在 `src-tauri/src/commands.rs`：

把 `emit_reordered` 函数（约 228-265 行）签名改为：

```rust
fn emit_reordered(
    handle: &AppHandle,
    watcher_state: &State<'_, WatcherArc>,
    tools_dir: &std::path::Path,
    ordered_ids: &[String],
) {
```

并在函数体末尾构造 `ScanResult` 处（约 261-264 行）加 `groups`：

```rust
    let result = crate::types::ScanResult {
        tools,
        errors: vec![],
        groups: tool_io::read_groups(tools_dir),
    };
```

- [ ] **Step 5.7: 更新 emit_reordered 调用点**

在 `tool_reorder`（约 219 行）把：

```rust
    emit_reordered(&handle, &watcher_state, &ordered_ids);
```

改为：

```rust
    emit_reordered(&handle, &watcher_state, &td, &ordered_ids);
```

- [ ] **Step 5.8: cargo check + 全量测试**

Run:
```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: 编译通过；全量 ok。

- [ ] **Step 5.9: Commit**

```bash
git add src-tauri/src/tool_io.rs src-tauri/src/commands.rs
git commit -m "fix(0.9.x): tool_delete/reorder 的 emit 保留 groups，避免分组索引闪失"
```

---

## Task 6: 渲染端 — 类型 + 解析 + prune（shared 层）

**Files:**
- Modify: `src/shared/types.ts:32-59`（ToolMeta）、`src/shared/types.ts:76-79`（ScanResult）
- Modify: `src/shared/toolConfig.ts:40`（parseToolMeta）
- Modify: `src/shared/toolJson.ts:6`（PRUNE 列表）

- [ ] **Step 6.1: types.ts — ToolMeta 加 group**

在 `src/shared/types.ts` 的 `ToolMeta` 接口（约 58 行 `sourceId?: string;` 之后）追加：

```ts
  // 分组名（自由文本）。空/缺失 = 未分组。仅侧栏展示分区用，不影响执行。
  group?: string;
```

- [ ] **Step 6.2: types.ts — ScanResult 加 groups**

在 `src/shared/types.ts` 的 `ScanResult` 接口（约 76-79 行）改为：

```ts
export interface ScanResult {
  tools: Tool[];
  errors: ScanError[];
  // 分组展示顺序（来自 order.json 的 groups 数组）。渲染端按此顺序画分组标题。
  groups: string[];
}
```

> 注意：这是 breaking change for `useTools` 的初值 `{ tools: [], errors: [] }`——下一步修。

- [ ] **Step 6.3: toolConfig.ts — parseToolMeta 解析 group**

在 `src/shared/toolConfig.ts:40`（`if (typeof o.sourceId ...` 块之后、`return meta;` 之前）插入：

```ts
  if (typeof o.group === 'string' && o.group.trim()) meta.group = o.group.trim();
```

- [ ] **Step 6.4: toolJson.ts — PRUNE 加 group**

在 `src/shared/toolJson.ts:6`，把：

```ts
const PRUNE_WHEN_EMPTY_STRING = ['cwd', 'tmux', 'mdUrl'] as const;
```

改为：

```ts
const PRUNE_WHEN_EMPTY_STRING = ['cwd', 'tmux', 'mdUrl', 'group'] as const;
```

- [ ] **Step 6.5: 修 useTools 初值**

`useTools` 初值缺 `groups` 会触发 TS 报错。在 `src/renderer/hooks/useTools.ts` 把：

```ts
const [result, setResult] = useState<ScanResult>({ tools: [], errors: [] });
```

改为：

```ts
const [result, setResult] = useState<ScanResult>({ tools: [], errors: [], groups: [] });
```

- [ ] **Step 6.6: 写失败测试 — toolJson prune group**

在 `tests/toolJson.test.ts` 的 `describe('mergeToolJson', ...)` 内（约第 22 行 `prunes cleared cwd` 测试后）插入：

```ts
  it('prunes cleared group', () => {
    const merged = mergeToolJson({ name: 'T', group: '前端' }, { group: '' });
    expect(merged.group).toBeUndefined();
  });

  it('keeps group when set', () => {
    const merged = mergeToolJson({ name: 'T' }, { group: '后端' });
    expect(merged.group).toBe('后端');
  });
```

- [ ] **Step 6.7: typecheck + test**

Run:
```bash
npm run typecheck 2>&1 | tail -10
npx vitest run tests/toolJson.test.ts 2>&1 | tail -15
```

Expected: typecheck 通过（除非有别的 ScanResult 字面量，grep `tools: \[\], errors: \[\]` 补 groups）；toolJson 测试全过。

> 若 typecheck 报别的 ScanResult 字面量缺 groups：
> ```bash
> grep -rn "errors: \[\]" src/ tests/
> ```
> 逐个补 `, groups: []`。

- [ ] **Step 6.8: 写失败测试 — toolConfig parse group**

在 `tests/toolConfig.test.ts`（末尾）插入：

```ts
  it('parses group', () => {
    const m = parseToolMeta({ name: 'A', group: '前端' }, 'x');
    expect(m.group).toBe('前端');
  });

  it('drops blank group', () => {
    const m = parseToolMeta({ name: 'A', group: '   ' }, 'x');
    expect(m.group).toBeUndefined();
  });

  it('group defaults undefined', () => {
    const m = parseToolMeta({ name: 'A' }, 'x');
    expect(m.group).toBeUndefined();
  });
```

- [ ] **Step 6.9: 跑该测试**

Run: `npx vitest run tests/toolConfig.test.ts 2>&1 | tail -10`

Expected: 全过。

- [ ] **Step 6.10: Commit**

```bash
git add src/shared/ src/renderer/hooks/useTools.ts tests/toolJson.test.ts tests/toolConfig.test.ts
git commit -m "feat(0.9.x): shared 层加 group 字段（types/toolConfig/toolJson）"
```

---

## Task 7: 渲染端 — buildGroupedView 纯函数（TDD 核心）

**Files:**
- Create: `src/shared/grouping.ts`
- Create: `tests/grouping.test.ts`

- [ ] **Step 7.1: 写失败测试 — 完整覆盖 buildGroupedView**

创建 `tests/grouping.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildGroupedView, UNGROUPED } from '../src/shared/grouping';
import type { Tool } from '../src/shared/types';

function tool(id: string, group: string | undefined, order: number): Tool {
  return {
    meta: { id, name: id, icon: '▣', order, group },
    helpMarkdown: '',
  };
}

describe('buildGroupedView', () => {
  it('returns single ungrouped section when no groups and no tool has group', () => {
    const tools = [tool('a', undefined, 0), tool('b', undefined, 1)];
    const view = buildGroupedView(tools, []);
    expect(view).toHaveLength(1);
    expect(view[0].name).toBe(UNGROUPED);
    expect(view[0].isUngrouped).toBe(true);
    expect(view[0].tools.map((t) => t.meta.id)).toEqual(['a', 'b']);
  });

  it('outputs indexed groups in order, then ungrouped last', () => {
    const tools = [
      tool('a', '前端', 0),
      tool('b', '后端', 1),
      tool('c', '前端', 2),
      tool('d', undefined, 3),
    ];
    const view = buildGroupedView(tools, ['前端', '后端']);
    expect(view.map((g) => g.name)).toEqual(['前端', '后端', UNGROUPED]);
    // 组内保持 flat order 相对位置
    expect(view[0].tools.map((t) => t.meta.id)).toEqual(['a', 'c']);
    expect(view[1].tools.map((t) => t.meta.id)).toEqual(['b']);
    expect(view[2].tools.map((t) => t.meta.id)).toEqual(['d']);
  });

  it('appends unindexed groups (referenced but not in index) in alphabetical order', () => {
    // 工具引用了 '后端'、'前端'，但 indexedGroups 只有 ['前端']
    const tools = [
      tool('a', '前端', 0),
      tool('b', '后端', 1),
      tool('c', undefined, 2),
    ];
    const view = buildGroupedView(tools, ['前端']);
    // indexed '前端' 在前；unindexed '后端' 按字母序追加；最后未分组
    expect(view.map((g) => g.name)).toEqual(['前端', '后端', UNGROUPED]);
  });

  it('keeps empty indexed groups (explicitly created groups do not vanish)', () => {
    // indexedGroups 含 '空分组'，但没有工具引用它 → 仍渲染（空 section）
    const tools = [tool('a', '前端', 0)];
    const view = buildGroupedView(tools, ['前端', '空分组']);
    expect(view.map((g) => g.name)).toEqual(['前端', '空分组', UNGROUPED]);
    expect(view[1].tools).toHaveLength(0);
  });

  it('omits ungrouped section when it is empty', () => {
    const tools = [tool('a', '前端', 0)];
    const view = buildGroupedView(tools, ['前端']);
    // 所有工具都在分组里 → 不渲染空未分组
    expect(view.map((g) => g.name)).toEqual(['前端']);
  });

  it('preserves within-group relative order from flat array', () => {
    // flat order: a(前端), b(后端), c(前端), d(前端) → 前端组内顺序 a,c,d
    const tools = [
      tool('a', '前端', 0),
      tool('b', '后端', 1),
      tool('c', '前端', 2),
      tool('d', '前端', 3),
    ];
    const view = buildGroupedView(tools, ['前端', '后端']);
    expect(view[0].tools.map((t) => t.meta.id)).toEqual(['a', 'c', 'd']);
  });

  it('dedupes unindexed groups', () => {
    const tools = [tool('a', 'X', 0), tool('b', 'X', 1)];
    const view = buildGroupedView(tools, []);
    // X 未索引但被两个工具引用 → 只出现一次
    expect(view.map((g) => g.name)).toEqual(['X', UNGROUPED]);
    expect(view[0].tools).toHaveLength(2);
  });
});
```

- [ ] **Step 7.2: 运行测试，确认失败**

Run: `npx vitest run tests/grouping.test.ts 2>&1 | tail -15`

Expected: FAIL `Failed to resolve import '../src/shared/grouping'`（模块不存在）。

- [ ] **Step 7.3: 实现 — grouping.ts**

创建 `src/shared/grouping.ts`：

```ts
import type { Tool } from './types';

/** 未分组 section 的名字（i18n 占位，与渲染端一致）。 */
export const UNGROUPED = '未分组';

export interface GroupSection {
  name: string;
  tools: Tool[];
  isUngrouped: boolean;
}

/**
 * 把扁平有序的 tools 按 meta.group 分区。
 *
 * - indexedGroups 顺序决定已登记分组的展示顺序；
 * - 工具引用了但不在 indexedGroups 里的分组（手动改 tool.json / 导入）按字母序
 *   追加到已登记分组之后；
 * - 未分组（meta.group 空/缺失）恒放最后；若为空则整个 section 不返回
 *   （避免出现空的「未分组」）。
 * - 空的已登记分组（indexedGroups 里有但无工具）**保留**：显式创建过的分组
 *   不因临时清空工具而消失。
 * - 组内工具顺序 = 它们在入参 tools 数组中的相对顺序（flat order 的子序列）。
 */
export function buildGroupedView(tools: Tool[], indexedGroups: string[]): GroupSection[] {
  const sections: GroupSection[] = [];

  // 1. 已登记分组，按索引顺序
  for (const name of indexedGroups) {
    sections.push({
      name,
      tools: tools.filter((t) => t.meta.group === name),
      isUngrouped: false,
    });
  }

  // 2. 未索引分组：工具引用了但不在 indexedGroups 里，按字母序去重追加
  const indexed = new Set(indexedGroups);
  const unindexed = new Set<string>();
  for (const t of tools) {
    const g = t.meta.group;
    if (g && !indexed.has(g)) unindexed.add(g);
  }
  const unindexedSorted = Array.from(unindexed).sort((a, b) => a.localeCompare(b));
  for (const name of unindexedSorted) {
    sections.push({
      name,
      tools: tools.filter((t) => t.meta.group === name),
      isUngrouped: false,
    });
  }

  // 3. 未分组（恒末尾）；空则不追加
  const ungroupedTools = tools.filter((t) => !t.meta.group);
  if (ungroupedTools.length > 0) {
    sections.push({
      name: UNGROUPED,
      tools: ungroupedTools,
      isUngrouped: true,
    });
  }

  return sections;
}
```

- [ ] **Step 7.4: 运行测试，确认全过**

Run: `npx vitest run tests/grouping.test.ts 2>&1 | tail -10`

Expected: 7 个测试全过。

- [ ] **Step 7.5: typecheck**

Run: `npm run typecheck 2>&1 | tail -5`

Expected: 通过。

- [ ] **Step 7.6: Commit**

```bash
git add src/shared/grouping.ts tests/grouping.test.ts
git commit -m "feat(0.9.x): buildGroupedView 纯函数（分组视图构建）"
```

---

## Task 8: 渲染端 — EditorPane 分组输入

**Files:**
- Modify: `src/renderer/components/EditorPane.tsx:27`（props）、`:39`（state）、`:105-112`（save patch）、`:137-179`（基本 fieldset）
- Modify: `src/renderer/App.tsx:237`（透传 existingGroups）

- [ ] **Step 8.1: EditorPane props 加 existingGroups**

在 `src/renderer/components/EditorPane.tsx:27` 把：

```tsx
export function EditorPane(props: { tool: Tool; onDone: () => void }) {
```

改为：

```tsx
export function EditorPane(props: {
  tool: Tool;
  onDone: () => void;
  /** 已有分组名（去重），供分组输入下拉选择。 */
  existingGroups: string[];
}) {
```

- [ ] **Step 8.2: 加 group state**

在 `src/renderer/components/EditorPane.tsx:39`（`const [autoUpdate, ...]` 之后）插入：

```tsx
  const [group, setGroup] = useState(meta.group ?? '');
```

- [ ] **Step 8.3: save patch 加 group**

在 `src/renderer/components/EditorPane.tsx` 的 `save()`（约 105-112 行 meta 对象字面量），把：

```tsx
    const meta: Partial<ToolMeta> = {
      name,
      icon,
      cwd: cwd.trim(),
      tmux: tmux.trim(),
      mdUrl: mdUrl.trim(),
      initCommands: initList,
    };
```

改为（加一行 `group`）：

```tsx
    const meta: Partial<ToolMeta> = {
      name,
      icon,
      cwd: cwd.trim(),
      tmux: tmux.trim(),
      mdUrl: mdUrl.trim(),
      group: group.trim(),
      initCommands: initList,
    };
```

- [ ] **Step 8.4: 基本 fieldset 加分组 combobox**

在 `src/renderer/components/EditorPane.tsx` 的「基本」fieldset（约 137-179 行），在「图标」field 的 `</div>` 之后、`</fieldset>` 之前插入分组 field：

```tsx
          <label className="field">
            <span className="field-label">分组 <em>留空 = 未分组；输入新名字即新建</em></span>
            <input
              list="ts-groups"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="未分组"
            />
            <datalist id="ts-groups">
              {props.existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
```

> 位置参考：插在 `<div className="field">...图标...</div>` 之后、`</fieldset>`（基本 fieldset 闭合）之前。

- [ ] **Step 8.5: App.tsx 透传 existingGroups**

在 `src/renderer/App.tsx`（约 45 行 `const { tools, errors } = useTools();` 附近）加派生量：

```tsx
  const existingGroups = Array.from(
    new Set(tools.map((t) => t.meta.group).filter((g): g is string => !!g)),
  );
```

并在 EditorPane 渲用处（约 237 行）把：

```tsx
        <EditorPane tool={active} onDone={() => setEditingId(null)} />
```

改为：

```tsx
        <EditorPane
          tool={active}
          onDone={() => setEditingId(null)}
          existingGroups={existingGroups}
        />
```

- [ ] **Step 8.6: typecheck**

Run: `npm run typecheck 2>&1 | tail -5`

Expected: 通过。

- [ ] **Step 8.7: 手测前的构建验证（dev server）**

Run（可选，留待最终手测）: `npm run dev:web`

Expected: 无编译错误。（完整手测见 Task 10。）

- [ ] **Step 8.8: Commit**

```bash
git add src/renderer/components/EditorPane.tsx src/renderer/App.tsx
git commit -m "feat(0.9.x): 编辑器加分组 combobox（选已有/新建）"
```

---

## Task 9: 渲染端 — Sidebar 分区渲染 + 折叠 + 同组拖拽守卫

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`（props、state、handleDrop、render）
- Modify: `src/renderer/App.tsx:208-221`（透传 groups）
- Modify: `src/renderer/styles.css`（.group-header 样式）

- [ ] **Step 9.1: Sidebar props 加 groups**

在 `src/renderer/components/Sidebar.tsx:11` 的 props 类型，把：

```tsx
export function Sidebar(props: {
  tools: Tool[];
  activeId: string | null;
```

改为（加 `groups`）：

```tsx
export function Sidebar(props: {
  tools: Tool[];
  /** 分组展示顺序（来自 ScanResult.groups）。 */
  groups: string[];
  activeId: string | null;
```

- [ ] **Step 9.2: 加折叠态 state + localStorage 持久化**

在 `src/renderer/components/Sidebar.tsx:9`（`const STORAGE_KEY = ...` 后）加：

```tsx
const COLLAPSED_KEY = 'termstep:sidebar-collapsed-groups';
```

在组件内（约 43 行 `const dragActiveRef = ...` 之后）加：

```tsx
  // 分组折叠态：存「已折叠」的分组名集合。默认空 = 全展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set<string>();
    }
  });
  const toggleGroup = (name: string) => {
    if (props.floating) return; // 浮层恒展开
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  };
```

- [ ] **Step 9.3: 加 import buildGroupedView + groupOf 辅助**

在 `src/renderer/components/Sidebar.tsx:2`（`import type { Tool } ...` 后）加：

```tsx
import { buildGroupedView, UNGROUPED } from '../../shared/grouping';
```

并在组件内（紧接 Step 9.2 的 toggleGroup 之后）加 groupOf 辅助：

```tsx
  // 由 toolId 查所属分组名（用于拖拽同组守卫）。未分组返回 null。
  const groupOf = (id: string): string | null => {
    const t = props.tools.find((x) => x.meta.id === id);
    return t?.meta.group ?? null;
  };
```

- [ ] **Step 9.4: 改造 handleDrop — 同组守卫**

在 `src/renderer/components/Sidebar.tsx:74-89`，把整个 `handleDrop` 替换为：

```tsx
  const handleDrop = () => {
    const fromId = dragStartRef.current?.id ?? dragId;
    const toId = overIdRef.current ?? overId;
    if (!fromId || !toId || fromId === toId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    // 同组守卫：跨组拖拽 no-op（跨组移动走编辑器改 group 字段）。
    if (groupOf(fromId) !== groupOf(toId)) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = props.tools.map((t) => t.meta.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from >= 0 && to >= 0) {
      ids.splice(from, 1);
      ids.splice(to, 0, fromId);
      props.onReorder(ids);
    }
    setDragId(null);
    setOverId(null);
  };
```

- [ ] **Step 9.5: 改造 onMove — 跨组时不设 overId（隐藏误导高亮）**

在 `src/renderer/components/Sidebar.tsx` 的拖拽 `onMove` 回调（约 153-168 行），把命中 drop 目标的那段：

```tsx
                          const el = document.elementFromPoint(ev.clientX, ev.clientY);
                          const li = el?.closest?.('li');
                          const overKey = li?.getAttribute('data-key') ?? null;
                          setOverId((cur) => (cur === overKey ? cur : overKey));
```

改为（跨组时 overKey 视为 null，不显示高亮）：

```tsx
                          const el = document.elementFromPoint(ev.clientX, ev.clientY);
                          const li = el?.closest?.('li');
                          const overKey = li?.getAttribute('data-key') ?? null;
                          // 跨组拖拽不显示 drag-over 高亮（drop 时也会被守卫挡掉）
                          const effectiveOver =
                            overKey && groupOf(overKey) === groupOf(s.id) ? overKey : null;
                          setOverId((cur) => (cur === effectiveOver ? cur : effectiveOver));
```

> `s.id` 是 dragStartRef.current.id（被拖工具）。`groupOf(s.id)` 是它的分组。

- [ ] **Step 9.6: 重写 list 渲染 — 分区 + 折叠**

在 `src/renderer/components/Sidebar.tsx:101-200`，把整个 `<ul className="sidebar-list">...</ul>` 块替换为：

```tsx
      <ul className="sidebar-list">
        {(() => {
          const grouped = buildGroupedView(props.tools, props.groups);
          // 只有一个非空 bucket（或全未分组）→ 平铺渲染，不画分组头（向后兼容老数据）
          const nonEmpty = grouped.filter((g) => g.tools.length > 0);
          const flat = nonEmpty.length <= 1;
          if (flat) {
            return grouped.flatMap((g) => g.tools).map((t) => renderToolRow(t));
          }
          return grouped.map((g) => {
            // 空未分组不渲染（buildGroupedView 已保证，双保险）
            if (g.isUngrouped && g.tools.length === 0) return null;
            const isCollapsed = !props.floating && collapsed.has(g.name);
            return (
              <Fragment key={g.name}>
                <li
                  className="group-header"
                  onClick={() => toggleGroup(g.name)}
                  title={props.floating ? undefined : '点击折叠/展开'}
                >
                  <span className="caret" aria-hidden>
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="group-name">{g.name}</span>
                  <span className="group-count">{g.tools.length}</span>
                </li>
                {!isCollapsed && g.tools.map((t) => renderToolRow(t))}
              </Fragment>
            );
          });
        })()}
      </ul>
```

并在文件顶部 import 加 `Fragment`：

```tsx
import { Fragment, useEffect, useRef, useState } from 'react';
```

- [ ] **Step 9.7: 抽出 renderToolRow 辅助函数**

在 `src/renderer/components/Sidebar.tsx` 组件内（`handleDrop` 之后），把原 `<li>` 渲染逻辑抽成函数。注意保留所有原有行为（active/dragging/drag-over 类、data-key、onPointerDown 选中、图标拖拽手柄）。把原 102-199 行的 `<li>...</li>` 改写为：

```tsx
  const renderToolRow = (t: Tool) => {
    const id = t.meta.id;
    const cls = [
      id === props.activeId ? 'active' : '',
      dragId === id ? 'dragging' : '',
      overId === id && dragId && dragId !== id ? 'drag-over' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <li
        key={id}
        data-key={id}
        className={cls}
        title={props.floating ? undefined : '拖动图标以排序'}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          props.onSelect(id);
        }}
      >
        <span
          className={'icon' + (props.floating ? '' : ' drag-handle')}
          onPointerDown={
            props.floating
              ? undefined
              : (e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  const handle = e.currentTarget;
                  const pointerId = e.pointerId;
                  dragStartRef.current = { id, x: e.clientX, y: e.clientY };
                  dragActiveRef.current = false;
                  handle.setPointerCapture(pointerId);
                  const onMove = (ev: PointerEvent) => {
                    const s = dragStartRef.current;
                    if (!s) return;
                    if (!dragActiveRef.current) {
                      const dx = ev.clientX - s.x;
                      const dy = ev.clientY - s.y;
                      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
                      dragActiveRef.current = true;
                      setDragId(s.id);
                    }
                    const el = document.elementFromPoint(ev.clientX, ev.clientY);
                    const li = el?.closest?.('li');
                    const overKey = li?.getAttribute('data-key') ?? null;
                    const effectiveOver =
                      overKey && groupOf(overKey) === groupOf(s.id) ? overKey : null;
                    setOverId((cur) => (cur === effectiveOver ? cur : effectiveOver));
                  };
                  const finish = () => {
                    handle.removeEventListener('pointermove', onMove);
                    handle.removeEventListener('pointerup', finish);
                    handle.removeEventListener('pointercancel', finish);
                    try {
                      handle.releasePointerCapture(pointerId);
                    } catch {
                      // pointerId 已失效
                    }
                    if (dragActiveRef.current) {
                      handleDrop();
                    }
                    dragStartRef.current = null;
                    dragActiveRef.current = false;
                    setDragId(null);
                    setOverId(null);
                  };
                  handle.addEventListener('pointermove', onMove);
                  handle.addEventListener('pointerup', finish);
                  handle.addEventListener('pointercancel', finish);
                }
          }
        >
          {t.meta.icon}
        </span>
        <span className="name">{t.meta.name}</span>
      </li>
    );
  };
```

> 注：`onMove` 内已包含 Step 9.5 的跨组高亮抑制。若 Step 9.5 已改过原内联代码，这里抽函数时不要重复改。**推荐顺序：先抽函数（保留原 onMove），再在抽出的函数里改 onMove。** 为避免混淆，本步直接给出最终形态（已含跨组守卫）。

- [ ] **Step 9.8: App.tsx 透传 groups 给 Sidebar**

在 `src/renderer/App.tsx` 的 `sidebarContent`（约 208-221 行），把：

```tsx
    <Sidebar
      tools={tools}
      activeId={activeId}
```

改为（加 `groups`）：

```tsx
    <Sidebar
      tools={tools}
      groups={groups}
      activeId={activeId}
```

并在 `App.tsx` 顶部 `useTools` 解构处（约 45 行）把：

```tsx
  const { tools, errors } = useTools();
```

改为：

```tsx
  const { tools, errors, groups } = useTools();
```

- [ ] **Step 9.9: styles.css 加 .group-header**

在 `src/renderer/styles.css`（`.sidebar li.drag-over::before` 块之后，约 202 行后）插入：

```css
/* 分组标题：区别于普通工具项（不可选中、不可拖拽、无 hover 高亮）。 */
.sidebar li.group-header {
  padding: 10px 10px 4px;
  cursor: default;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3);
  gap: 6px;
}
.sidebar li.group-header:hover { background: transparent; color: var(--text-3); }
.sidebar li.group-header .caret {
  width: 1em; flex: 0 0 auto; font-size: 10px; opacity: 0.7;
}
.sidebar li.group-header .group-name {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sidebar li.group-header .group-count {
  flex: 0 0 auto; opacity: 0.6; font-weight: 400;
}
```

> 若 `--text-3` 变量不存在，用 `var(--text-2)` 并加 `opacity: 0.7`。先 grep 确认：
> ```bash
> grep -n "text-3\|text-2" src/renderer/styles.css | head -5
> ```

- [ ] **Step 9.10: typecheck**

Run: `npm run typecheck 2>&1 | tail -10`

Expected: 通过。若有 `Tool` 未导入警告等，按提示修。

- [ ] **Step 9.11: 跑全量 vitest（确认没碰坏 shared 测试）**

Run: `npm run test 2>&1 | tail -15`

Expected: 全过。

- [ ] **Step 9.12: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(0.9.x): Sidebar 按分组分区渲染 + 折叠 + 同组拖拽守卫"
```

---

## Task 10: 最终验证 + 手测

- [ ] **Step 10.1: 全量自动化基线**

Run:
```bash
npm run typecheck && npm run test && cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: 三项全过。

- [ ] **Step 10.2: 启动 dev 验证（GUI 手测）**

Run: `npm run dev`

手测清单（按 spec §6.3）：
1. **默认态**：新建工具 → 默认未分组 → 侧栏单 section 无 header（平铺）。
2. **新建分组**：编辑某工具 → 分组输入框写「前端」→ 保存 → 侧栏出现「前端」section（展开）。
3. **选已有分组**：编辑另一工具 → 分组下拉选「前端」→ 保存 → 该工具进「前端」section。
4. **跨组切换**：把「前端」里的工具改成「后端」→ 保存 → 工具移到「后端」section（新分组追加到末尾）。
5. **组内拖拽**：在「前端」section 内拖拽工具图标 → 顺序更新。
6. **跨组拖拽**：从「前端」拖到「后端」的工具上 → 无变化、无 drag-over 高亮。
7. **折叠**：点「前端」header → 折叠；刷新窗口（Cmd+R）→ 仍折叠（localStorage）。
8. **floating peek**：折叠侧栏 → hover peek 出现 → 分组恒展开（不折叠）。
9. **未分组**：所有工具都设了分组 → 「未分组」section 不出现。
10. **向后兼容**：清空 `~/Library/Application Support/TermStep/configs/tools/order.json` 的 `groups` 键（或用旧格式 `{"order":[...]}`）→ 所有工具归到「未分组」、不崩。

- [ ] **Step 10.3: （可选）更新 AGENTS.md**

若分组功能需要记入项目文档，在 `AGENTS.md` 的 §2 工具模型/§3 结构里补一句分组字段。**非必须**——本次不改 AGENTS.md 除非用户要求。

- [ ] **Step 10.4: 最终 commit（若有手测中发现的小修）**

```bash
git status
# 若有未提交的修复：
git add -A && git commit -m "fix(0.9.x): 手测修复"
```

- [ ] **Step 10.5: 收尾**

按 `superpowers:finishing-a-development-branch` 决定合并/PR/清理（不在本计划范围，执行时由 worker 触发）。

---

## 自审清单（写完后自检）

**Spec 覆盖：**
- ✅ §2.1 ToolMeta.group → Task 1（Rust）+ Task 6（TS）
- ✅ §2.2 order.json groups 键 → Task 3
- ✅ §2.3 ScanResult.groups → Task 1（Rust）+ Task 6（TS）
- ✅ §3.1 read/write_order_index 重构 → Task 3
- ✅ §3.1 append_group_if_new → Task 4
- ✅ §3.2 parse_tool_meta + merge prune → Task 2
- ✅ §3.3 scan_tools 填 groups → Task 3 Step 3.6
- ✅ §3.4 tool_save 调 append_group_if_new → Task 4 Step 4.5
- ✅ §3.5 group 非风险字段 → 不动 scan_tool_risk（Task 2 未碰，正确）
- ✅ §4.1 buildGroupedView → Task 7
- ✅ §4.2 Sidebar 分区 + 折叠 + flat 兜底 → Task 9
- ✅ §4.3 组内拖拽守卫 → Task 9 Step 9.4/9.5
- ✅ §4.4 EditorPane combobox → Task 8
- ✅ §4.5 App.tsx 透传 → Task 8 Step 8.5 + Task 9 Step 9.8
- ✅ §5 emit 路径保留 groups（spec 未单列，实现时发现的关键点）→ Task 5
- ✅ §6 测试 → 各 Task 内 TDD

**Placeholder 扫描：** 无 TBD/TODO；每步都有完整代码。

**类型一致性：**
- `OrderIndex { order, groups }` — Task 3 定义，Task 5 `read_groups` 用 `.groups`，一致。
- `buildGroupedView(tools, indexedGroups)` — Task 7 定义，Task 9 调用 `buildGroupedView(props.tools, props.groups)`，一致。
- `GroupSection.isUngrouped` — Task 7 定义，Task 9 用 `g.isUngrouped`，一致。
- `UNGROUPED` 常量 — Task 7 导出，Task 9 import，一致。
- `existingGroups` prop — Task 8 定义，App.tsx 透传，一致。
- `Sidebar` props.groups — Task 9 定义，App.tsx 透传 `groups={groups}`，一致。
