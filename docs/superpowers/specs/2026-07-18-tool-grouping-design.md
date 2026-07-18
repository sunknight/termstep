# 工具分组（Tool Grouping）设计

- **日期**：2026-07-18
- **目标**：给工具增加「分组」概念。在工具编辑器里可从已有分组选择或新建；左侧工具列表按分组分区展示，分组可折叠（默认全展开），未配置分组的工具落到「未分组」。
- **范围**：分组是**隐式**的（仅因工具的 `group` 字段引用而存在），本版本不含独立的分组管理 UI（重命名/删除/排序分组）。

---

## 1. 决策摘要

| 主题 | 决策 |
|---|---|
| 分组管理方式 | 隐式：分组由工具 `meta.group` 字段引用而存在；编辑器内选择已有或新建 |
| 分组来源 | 工具的 `meta.group?: string`（空/缺失 = 未分组） |
| 分组显示顺序 | 持久化到 `order.json` 的新增 `groups` 数组（创建顺序） |
| 分组内工具顺序 | 复用现有 flat `order` 数组（组内 = 该组工具在 flat 数组中的相对位置） |
| `order.json` 存储模型 | **flat 数组**（跨组整体存储），而非按组存储。新增同级 `groups` 键 |
| 拖拽行为 | **仅组内**排序。跨组拖拽 = no-op（抑制 drag-over 高亮）；跨组移动走编辑器改 `group` 字段 |
| 分组折叠态 | 持久化到 `localStorage`；默认全展开；floating peek 模式恒展开 |
| 分组重排（v1） | **不在范围**。分组按加入 `groups` 索引的顺序显示 |

### 为什么 flat 数组而非按组存储

`order.json` 保留现有 flat `order` 数组，仅**新增**同级 `groups`：

```json
{ "order": ["uuid1", "uuid2", "uuid3", ...], "groups": ["前端", "后端"] }
```

理由：
1. **向后兼容**：旧 `order.json`（无 `groups` 键）读取为 `groups: []`，老用户零中断、零迁移。
2. **关注点分离**：flat `order` = 纯展示顺序；`meta.group` = 归属（正交）。工具换组时 **flat `order` 不变**，只改 `meta.group`。按组存储模型在每次换组时都要把 id 在多个数组间搬运，更复杂。
3. **组内顺序定义清晰**：同一组工具在 flat 数组中的**相对顺序**即组内顺序。跨组的交错对渲染无关（每组是独立 section 渲染）。

### 为什么分组重排不在 v1

拖拽**仅组内**、且没有分组管理 UI，分组顺序在 v1 里**不可由用户调整** —— 按「加入 `groups` 索引的顺序」展示（即首次创建顺序）。后续可在组标题上加拖拽重排，改动很小，但本次不做以保持聚焦。

---

## 2. 数据模型

### 2.1 `ToolMeta` 新增字段

两端同步、自动 round-trip：

```ts
// src/shared/types.ts
export interface ToolMeta {
  // ...既有字段
  group?: string;   // 新增。空/缺失 = 未分组
}
```

```rust
// src-tauri/src/types.rs
pub struct ToolMeta {
    // ...既有字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}
```

- `group` 是用户赋值字符串；不需要 UUID、不需要规范化（trim 即可）。
- 不需要 backfill 迁移（不同于 `sourceId`）—— 缺失即未分组。

### 2.2 `order.json` 扩展

```json
{ "order": ["uuid1", "uuid2", "uuid3"], "groups": ["前端", "后端"] }
```

- `order`：**不变**，仍是工具 id 的 flat 数组。
- `groups`：分组名字符串数组，**展示顺序**。新分组追加到末尾。重复检测：保存工具时若 `group` 不在 `groups` 中则追加（仅追加一次）。
- 缺失 `groups` 键 → 读为 `[]`（向后兼容）。
- 缺失 `order` 键 → 读为 `[]`（与现状一致）。
- 文件损坏/非对象 → 整个读为 `{ order: [], groups: [] }`。

### 2.3 `ScanResult` 新增字段

```ts
// src/shared/types.ts
export interface ScanResult {
  tools: Tool[];
  errors: ScanError[];
  groups: string[];   // 新增：order.json 中的 groups 数组（展示顺序）
}
```

渲染端据此按索引顺序画分组标题。`groups` 中出现但没有任何工具引用的分组：**仍渲染**（空 section），保持「显式创建过的分组不会因临时清空工具而消失」的直觉。**反向**：工具引用了 `groups` 里没有的分组名（例如手动改 `tool.json`、或导入的工具带 `group`）→ `buildGroupedView` 把这些「未索引分组」按字母序追加到已索引分组之后、未分组之前。

---

## 3. 后端（Rust）

### 3.1 `src-tauri/src/tool_io.rs`

**重构 `read_order_index`**：从返回 `Vec<String>` 改为返回结构体：

```rust
pub struct OrderIndex {
    pub order: Vec<String>,
    pub groups: Vec<String>,
}

pub fn read_order_index(tools_dir: &Path) -> OrderIndex { /* 解析两键，缺失/损坏兜底 */ }
```

- 解析逻辑：读 `order.json`；若不是对象，或缺键，对应字段兜底为 `Vec::new()`。
- 现有所有调用点（`tools.rs: scan_tools`、`tool_reorder`）改为读 `index.order`。

**改造 `write_order_index`** 为 read-modify-write，**不覆盖 `groups`**：

```rust
// 旧行为：写入 {"order": orderedIds}（会清掉 groups）
// 新行为：保留现有 groups，只更新 order
pub async fn write_order_index(tools_dir: &Path, order: &[String]) -> std::io::Result<()> {
    let mut idx = read_order_index(tools_dir);   // 保留 groups
    idx.order = order.to_vec();
    persist(&idx)   // tmp + rename，原子
}
```

**新增 `append_group_if_new`**（由 `tool_save` 在写完 `tool.json` 后调用）：

```rust
/// 若 group 非空且不在 order.json 的 groups 数组中，追加。已存在则 no-op。
pub async fn append_group_if_new(tools_dir: &Path, group: Option<&str>) -> std::io::Result<()> {
    let name = match group.map(str::trim).filter(|s| !s.is_empty()) {
        Some(g) => g,
        None => return Ok(()),    // 未分组：不动 groups
    };
    let mut idx = read_order_index(tools_dir);
    if idx.groups.iter().any(|g| g == name) { return Ok(()); }
    idx.groups.push(name.to_string());
    persist(&idx)
}
```

`persist` 用既有 `tmp + rename` 原子写。

### 3.2 `src-tauri/src/pure.rs`

**`parse_tool_meta`**：

```rust
let group = trim_str_field(o, "group");
// ...struct literal 加 group: None 默认
if let Some(g) = group { meta.group = Some(g); }
```

`trim_str_field` 已存在，空串会被丢弃为 `None`。

**`merge_tool_json`**：把 `"group"` 加入清空时移除的列表（镜像 `cwd`/`tmux`/`mdUrl`）：

```rust
for k in &["cwd", "tmux", "mdUrl", "group"] {   // 加 "group"
    ...
}
```

这样编辑器里清空 group → `tool.json` 的 `group` 键被删除（而非保留空串）。

### 3.3 `src-tauri/src/tools.rs`

`scan_tools`：从 `read_order_index` 读出的 `groups` 填到 `ScanResult.groups`：

```rust
let index = crate::tool_io::read_order_index(tools_dir);
// ...既有 sort 逻辑用 index.order
result.groups = index.groups;
```

### 3.4 `src-tauri/src/commands.rs` / `tool_io.rs`

**`tool_save`**：在写完 `tool.json` 后追加一步：

```rust
tool_io::tool_save(&dir, &markdown, meta_patch.clone()).await...?;
// 新增：若 patch 含 group 字段，确保 order.json.groups 记录之
if let Some(g) = meta_patch.get("group").and_then(|v| v.as_str()) {
    let _ = tool_io::append_group_if_new(&tools_dir_root, Some(g)).await; // 失败只告警
}
```

- 仅当 patch 显式带了 `group` 键时才触发（避免每次保存都读 `order.json`）。
- `append_group_if_new` 失败**只 eprintln!，不阻断保存**（遵循 §6.6 VCS 的「保存是首要功能」原则）。
- 之后照旧触发 watcher rescan + `tools:changed`（既有流程会带上新的 `groups`）。

`tool_create`、`tool_reorder`、`tool_delete`、`bundle import`：**不变**。

### 3.5 风险字段

`group` **不是**风险字段（纯展示，从不执行）。`scan_tool_risk` **不加** `group`。

---

## 4. 渲染端

### 4.1 分组视图构建（纯函数，可单测）

新文件 `src/shared/grouping.ts`：

```ts
export interface GroupSection {
  name: string;              // 分组名；未分组用常量 UNGROUPED
  tools: Tool[];             // 保持 flat order 相对位置
  isUngrouped: boolean;
}

export const UNGROUPED = '未分组';

/**
 * 按 indexedGroups 顺序输出 section，追加「工具引用了但 groups 索引里没有」的分组
 * （字母序，去重），最后是 UNGROUPED section（即使空也输出，但可由调用方决定是否渲染）。
 */
export function buildGroupedView(
  tools: Tool[],
  indexedGroups: string[],
): GroupSection[] { ... }
```

**算法**：
1. 输出 `indexedGroups` 中每个分组，组内工具 = `tools.filter(t => t.meta.group === name)`（保持原顺序）。
2. 收集 `tools` 引用但不在 `indexedGroups` 中的分组名（去重、字母序），追加 section。
3. 末尾追加 `UNGROUNDED` section：`tools.filter(t => !t.meta.group)`。
4. 空分组（`indexedGroups` 里有但无工具）**保留**（直觉：显式创建过的分组不消失）。
5. `UNGROUNDED` 为空时，渲染端可选择隐藏（见 4.2）。

### 4.2 `Sidebar.tsx`

在既有 `<ul className="sidebar-list">` 之上渲染分组：

```tsx
{grouped.map(g => (
  <Fragment key={g.name}>
    <li className="group-header"
        data-group={g.name}
        onClick={() => !floating && toggleGroup(g.name)}>
      <span className="caret">{collapsed.has(g.name) ? '▸' : '▾'}</span>
      <span className="group-name">{g.name}</span>
      <span className="count">{g.tools.length}</span>
    </li>
    {(!collapsed.has(g.name) || floating) && g.tools.map(t => (
      <li key={t.meta.id} data-key={t.meta.id} data-group={g.name} className={...}>
        {/* 既有工具行：icon + name */}
      </li>
    ))}
  </Fragment>
))}
```

- **新 prop**：`groups: string[]`（从 `App.tsx` 透传 `scanResult.groups`）。
- **仅一个分组 + 未分组为空时**：不渲染 header，直接渲染平铺（向后兼容老数据 / 无分组用户，UI 一如既往）。判断：`grouped.filter(g => g.tools.length > 0).length <= 1`。
- **折叠态**：`useState<Set<string>>` 从 `localStorage['termstep:sidebar-collapsed-groups']`（JSON 数组）初始化；切换时写回。默认空集合 = 全展开。`floating` 模式恒展开（peek 是临时视图）。
- **空 `UNGROUNDED` 隐藏**：如果 `g.isUngrouped && g.tools.length === 0` 不渲染该 section（避免出现空「未分组」）。
- **拖拽命中**：`elementFromPoint` → `closest('li')` → 读 `data-key`（既有）和 `data-group`（新）。group-header `<li>` 无 `data-key`，自然被忽略。

### 4.3 拖拽：组内排序 + 同组守卫

`handleDrop` 改造（既有函数，`Sidebar.tsx:74-89`）：

```ts
const handleDrop = () => {
  const fromId = dragStartRef.current?.id ?? dragId;
  const toId = overIdRef.current ?? overId;
  if (!fromId || !toId || fromId === toId) return;

  const ids = props.tools.map(t => t.meta.id);
  const fromGroup = groupOf(fromId);   // 从 props.tools 查 meta.group
  const toGroup = groupOf(toId);
  if (fromGroup !== toGroup) return;    // 跨组：no-op

  // 组内重排：操作子序列
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, fromId);
  props.onReorder(ids);   // 现有 IPC：写回 flat order.json
};
```

- 跨组拖拽时 **no-op**，且 `pointermove` 期间若 `fromGroup !== toGroup` 不设 `overId`（即不显示 `drag-over` 高亮），避免误导。
- 写回的 `ids` 是完整 flat 数组（含跨组工具的未变位置），`write_order_index` 原子写入。

### 4.4 `EditorPane.tsx`：分组输入

基本 fieldset 加一个**原生 combobox**（`<input list>` + `<datalist>`）：

```tsx
const [group, setGroup] = useState(meta.group ?? '');

// JSX
<input list="ts-groups" value={group}
       onChange={e => setGroup(e.target.value)}
       placeholder="未分组" />
<datalist id="ts-groups">
  {props.existingGroups.map(g => <option key={g} value={g} />)}
</datalist>
```

- **新 prop**：`existingGroups: string[]`（`App.tsx` 从 `tools` 聚合：去重的非空 `meta.group` 集合）。
- 行为：从下拉选已有，或输入新名字即新建；清空 → 未分组。
- `<datalist>` 是原生、零依赖。WKWebView 若有兼容问题，回退 `<select>` + 「+ 新建」开关（实施时验证；若 OK 则用 datalist）。
- `save()`：meta patch 加 `group: group.trim()`（既有 `api.tool.save` 已接 `Partial<ToolMeta>`）。

### 4.5 `App.tsx`

- 给 `<Sidebar>` 传 `groups={result.groups}`（`useTools` 已返回 `ScanResult`，已含新字段）。
- 给 `<EditorPane>` 传 `existingGroups`：

```tsx
const existingGroups = Array.from(new Set(
  tools.map(t => t.meta.group).filter((g): g is string => !!g)
));
```

其余不变（`useTools`/`useTauriEvent`/`createTool`/`reorderTools` 均不动）。

---

## 5. 向后兼容与边界

| 情况 | 行为 |
|---|---|
| 旧 `order.json`（无 `groups` 键） | 读为 `groups: []`；所有工具在「未分组」；零迁移 |
| 旧 `tool.json`（无 `group` 键） | `meta.group = undefined` → 未分组 |
| 工具引用 `groups` 索引外的分组 | `buildGroupedView` 按字母序追加为「未索引分组」section |
| 用户把某分组命名为「未分组」 | 作为普通 section（按索引位置）渲染；另外末尾的隐式未分组桶若空则不显示。罕见，不做特殊处理 |
| 工具换组（编辑器改 group） | `meta.group` 变；flat `order` **不变**；新分组追加到 `groups` 末尾（若新） |
| Bundle 导入带 `group` 的工具 | `ToolMeta` round-trip 自动携带；import 后该分组若不在 `groups` 索引 → 按「未索引分组」渲染。**可选**：import 路径也调一次 `append_group_if_new`（见 §7 future） |
| 清空 group | `tool.json` 的 `group` 键被移除（merge_tool_json prune）；`groups` 索引保留该名字（空 section 可能显示） |

---

## 6. 测试

### 6.1 vitest（node，纯逻辑）

- **`tests/grouping.test.ts`**（新）：
  - indexed 顺序、unindexed 字母序追加、UNGROUPED 恒末尾。
  - 组内顺序 = flat order 相对位置。
  - 空 `indexedGroups` → 仅 UNGROUPED。
  - 工具引用索引外分组 → 追加 section 去重。
- **`tests/toolJson.test.ts`**（既有，加 case）：清空 `group` 时 prune 掉（镜像 cwd/tmux prune 测试）。

### 6.2 Rust（`cargo test`）

- `read_order_index`：返回 `{order, groups}`；缺键兜底；损坏文件兜底。
- `write_order_index`：**保留** groups（写 order 不覆盖 groups）。
- `append_group_if_new`：仅追加一次；已存在则 no-op；空/None 则不动。
- `merge_tool_json`：清空 `group` 时移除键。

### 6.3 手测清单

- 新建工具 → 默认未分组 → 侧栏单 section 无 header。
- 编辑器输入新分组名 → 保存 → 侧栏出现新 section（展开）。
- 编辑器从已有分组切换 → 工具移到目标 section。
- 组内拖拽 → 顺序更新；跨组拖拽 → 无变化、无高亮。
- 折叠分组 → 刷新窗口仍折叠（localStorage）。
- floating peek → 分组恒展开。

---

## 7. 未来（不在本版范围）

- 分组重排（组标题拖拽 → 重写 `groups` 数组）。
- 分组管理 UI（重命名/删除）。删除空分组 = 从 `groups` 移除名字。
- Bundle import 时调 `append_group_if_new` 让导入分组进索引。
- 分组级折叠全部/展开全部按钮。

---

## 8. 涉及文件清单

**新增**：
- `src/shared/grouping.ts`
- `tests/grouping.test.ts`

**修改（渲染端）**：
- `src/shared/types.ts`（`ToolMeta.group`、`ScanResult.groups`）
- `src/shared/toolConfig.ts`（`parseToolMeta` 加 group）
- `src/shared/toolJson.ts`（`PRUNE_WHEN_EMPTY_STRING` 加 `'group'`）
- `src/renderer/components/Sidebar.tsx`（分组渲染 + 折叠 + 同组拖拽守卫）
- `src/renderer/components/EditorPane.tsx`（分组输入）
- `src/renderer/App.tsx`（透传 props）

**修改（后端）**：
- `src-tauri/src/types.rs`（`ToolMeta.group`、`ScanResult.groups`）
- `src-tauri/src/tool_io.rs`（`OrderIndex` 结构、`read/write_order_index` 重构、新增 `append_group_if_new`）
- `src-tauri/src/pure.rs`（`parse_tool_meta`、`merge_tool_json` prune）
- `src-tauri/src/tools.rs`（`scan_tools` 填 `groups`）
- `src-tauri/src/commands.rs`（`tool_save` 追加 `append_group_if_new` 调用）

**不改**：`api.ts`、`IPC` 常量、`tool_create`/`tool_delete`/`tool_reorder`、bundle import/export、pty、迁移链、capabilities。
