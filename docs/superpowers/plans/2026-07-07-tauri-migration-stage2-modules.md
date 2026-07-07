# Tauri 迁移 · 阶段 2：低风险模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Electron 主进程的低风险模块（updater / tools scanner / tool CRUD / cwd / watcher）迁移到 Rust `#[tauri::command]`，renderer 的 34 处 `window.api.*` 调用点全部切到 Tauri `invoke`/`listen`。完成后，除 PTY 外的所有功能在 Tauri 下可用——工具增删改、导入导出、quick commands、更新检查、剪贴板、外链、md 订阅全部工作。

**Architecture:** Rust 后端按现有 TS 模块 1:1 对应新建（updater.rs/tools.rs/tool_io.rs/cwd.rs/watcher.rs/commands.rs）。renderer 新增 `lib/api.ts`（Tauri invoke 包装，同构 window.api）+ `hooks/useTauriEvent.ts`（统一事件订阅）。纯数据转换逻辑（buttonBlock/toolJson/bundle/toolConfig）的 TS 版**保留**（renderer 仍用），Rust 后端写最小对偶实现 + 测试对齐。PTY（阶段 3）在本阶段仍走 stub。

**Tech Stack:** Rust（tauri 2.11.5 / reqwest / notify / serde / rfd / dirs / regex）、React 18、@tauri-apps/api（invoke/listen/event）。

**关联 Spec:** `docs/superpowers/specs/2026-07-07-migrate-to-tauri-design.md`（第二/四/五节）

**关键架构决策（写在前面，所有 task 遵循）:**

1. **shared/ 的 TS 实现全部保留。** renderer 直接 import shared/ 做按钮渲染、参数替换等（见 TerminalView/HelpPane/QuickCommands/markdown.ts 等）。这些是浏览器代码，不能调 Rust。Rust 后端需要的那部分（mergeToolJson/buildButtonsAppend/serializeTools/parseToolMeta 等），在 Rust 里写**最小实现**，功能与 TS 版对齐，用测试覆盖。不追求 100% API 对偶，只实现后端用到的路径。

2. **types.rs（Rust）↔ types.ts（TS）对偶。** `ScanResult`/`Tool`/`ToolMeta`/`PtySpawnOpts`/`UpdateState` 等在 Rust 用 `#[derive(Serialize,Deserialize)]` + `#[serde(rename_all="camelCase")]` 对齐 TS 字段名。Rust struct 定义在 `src-tauri/src/types.rs`。

3. **State 管理。** 跨 command 的状态（updater 的 state+checking、watcher 的 lastTools）用 `tauri::State<'_, std::sync::Mutex<T>>`。在 `setup()` 初始化 `app.manage()`。

4. **事件 emit。** `tools:changed`/`update:state` 两个事件由 Rust 用 `AppHandle.emit(name, payload)` 推送（`pty:data` 留到阶段 3）。renderer 用 `listen()` 订阅。

5. **Tauri command 参数从前端按 camelCase 传**（invoke 的第二个参数对象），Rust 函数参数用 snake_case，Tauri 自动映射。

---

## File Structure（本阶段涉及）

**Create（Rust 后端）:**
- `src-tauri/src/types.rs` — Rust 对偶 struct（ToolMeta/Tool/ScanResult/UpdateState/PtySpawnOpts + bundle/manifest types）
- `src-tauri/src/pure.rs` — 纯数据转换（merge_tool_json/build_buttons_append/serialize_tools/parse_tools_bundle/parse_tool_meta/slugify）+ 单元测试
- `src-tauri/src/updater.rs` — 更新检查（compare_versions/parse_manifest + reqwest + 状态机 + emit）
- `src-tauri/src/tools.rs` — scan_tools + fetch_remote_markdown + 敏感路径守卫 + 测试
- `src-tauri/src/tool_io.rs` — tool CRUD/save/create/delete/reorder/append_buttons + export/import + quick get/save
- `src-tauri/src/cwd.rs` — live_cwd（lsof）
- `src-tauri/src/watcher.rs` — notify 监听 + emit tools:changed + auto-refresh tick
- `src-tauri/src/commands.rs` — 所有 `#[tauri::command]`（薄封装，调上述模块）

**Create（renderer 适配层）:**
- `src/renderer/lib/api.ts` — Tauri invoke 包装（同构 preload 的 Api shape）
- `src/renderer/hooks/useTauriEvent.ts` — 统一事件订阅 hook

**Modify:**
- `src-tauri/Cargo.toml` — 加 reqwest/notify/serde/rfd/dirs/regex/tokio 依赖
- `src-tauri/src/lib.rs` — 注册 commands + State 初始化 + 启动 watcher + 启动 auto-update check
- `src-tauri/src/main.rs` — 不变
- `src-tauri/capabilities/default.json` — 加 clipboard/opener 插件权限（若用插件）或自写 command
- `src/renderer/main.tsx` — 移除 stubApi 注入（api.ts 接管）
- `src/renderer/types/global.d.ts` — 改为声明 `window.__api`（或彻底移除，让组件 import api）
- **renderer 34 处调用点**（11 个文件）— `window.api.X` → `api.X`

**不动（保留）:**
- `src/shared/**` 全部（renderer + tests 仍用）
- `src/main/**` / `src/preload/**`（阶段 4 删）
- `tests/**`（vitest 回归基准，全程保持绿色）

---

## Task A：types.rs + pure.rs（纯逻辑 + 测试）

先把"地基"打好：类型对偶 + 纯数据转换函数。这些是后续所有模块的依赖，且能独立用 `cargo test` 验证。

**Files:**
- Create: `src-tauri/src/types.rs`
- Create: `src-tauri/src/pure.rs`

- [ ] **Step 1: 写 types.rs（对偶 struct）**

创建 `src-tauri/src/types.rs`：

```rust
use serde::{Deserialize, Serialize};

// Rust 对偶 of src/shared/types.ts。serde camelCase 对齐前端字段名。
// 所有 Option<T> 字段用 #[serde(skip_serializing_if = "Option::is_none")]
// 让序列化输出与 TS（undefined 字段不出现）一致。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMeta {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_commands: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_update_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_remote: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub meta: ToolMeta,
    #[serde(rename = "helpMarkdown")]
    pub help_markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub tools: Vec<Tool>,
    pub errors: Vec<ScanError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnOpts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_commands: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateState {
    Idle,
    Checking,
    UpToDate,
    Available { version: String, url: String, notes: String },
    Error { error: String },
}

impl Default for UpdateState {
    fn default() -> Self {
        UpdateState::Idle
    }
}

// --- Bundle format (对偶 src/shared/bundle.ts) ---
pub const BUNDLE_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleTool {
    pub meta: ToolMeta,
    #[serde(rename = "helpMarkdown")]
    pub help_markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsBundle {
    pub version: i64,
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
    pub tools: Vec<BundleTool>,
}
```

说明：`UpdateState` 用 serde 的 internally-tagged enum（`#[serde(tag="status")]`）对齐 TS 的 discriminated union（`{status:'available', version, url, notes}`）。注意 Rust enum 变体 `UpToDate` 经 `rename_all="camelCase"` 序列化为 `"upToDate"`，与 TS 一致。

- [ ] **Step 2: 写 pure.rs 的测试（先写测试，TDD）**

创建 `src-tauri/src/pure.rs`，先只写测试桩 + 函数签名（编译失败）：

```rust
//! 纯数据转换函数，对偶 src/shared/{toolJson,buttonBlock,bundle,toolConfig}.ts
//! 后端用到的最小子集。无 fs/网络，纯函数，#[cfg(test)] 覆盖。

use crate::types::*;
use serde_json::{json, Value};

// ── 对偶 mergeToolJson (src/shared/toolJson.ts) ──────────────────────────────
// 合并 existing tool.json 与编辑器 patch，裁掉被清空的 optional 字段。
pub fn merge_tool_json(existing: &Value, patch: &Value) -> Value {
    unimplemented!("filled in step 3")
}

// ── 对偶 buildButtonsAppend (src/shared/buttonBlock.ts) ──────────────────────
// 把 body 作为新 ```buttons 围栏追加到 current_md 末尾。
pub fn build_buttons_append(current_md: &str, body: &str) -> String {
    unimplemented!("filled in step 3")
}

// ── 对偶 serializeTools (src/shared/bundle.ts) ───────────────────────────────
pub fn serialize_tools(tools: &[Tool], exported_at: &str) -> ToolsBundle {
    ToolsBundle {
        version: BUNDLE_VERSION,
        app: "TermStep".into(),
        exported_at: Some(exported_at.into()),
        tools: tools
            .iter()
            .map(|t| BundleTool {
                meta: t.meta.clone(),
                help_markdown: t.help_markdown.clone(),
            })
            .collect(),
    }
}

// ── 对偶 parseToolsBundle (src/shared/bundle.ts) ─────────────────────────────
pub struct ParseResult {
    pub tools: Vec<BundleTool>,
    pub error: Option<String>,
}

pub fn parse_tools_bundle(raw: &str) -> ParseResult {
    unimplemented!("filled in step 3")
}

// ── 对偶 parseToolMeta (src/shared/toolConfig.ts) ────────────────────────────
pub fn parse_tool_meta(raw: &Value, id: &str) -> ToolMeta {
    unimplemented!("filled in step 3")
}

// ── 对偶 slugify (src/main/ipc.ts) ───────────────────────────────────────────
pub fn slugify(name: &str) -> String {
    unimplemented!("filled in step 3")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── merge_tool_json（对偶 tests/toolJson.test.ts）─────────────────────────
    #[test]
    fn merge_keeps_existing_then_applies_patch() {
        let existing = json!({"name":"A","cwd":"/old","order":0});
        let patch = json!({"name":"B"});
        let m = merge_tool_json(&existing, &patch);
        assert_eq!(m["name"], "B");
        assert_eq!(m["cwd"], "/old"); // patch 未提及则保留
        assert_eq!(m["order"], 0);
    }

    #[test]
    fn merge_prunes_cleared_cwd() {
        // 清空 cwd（空字符串）→ 应从结果删除，不保留旧值
        let existing = json!({"cwd":"/old"});
        let patch = json!({"cwd":""});
        let m = merge_tool_json(&existing, &patch);
        assert!(m.get("cwd").is_none(), "cleared cwd must be pruned");
    }

    #[test]
    fn merge_prunes_mdurl_and_dependents() {
        // 清空 mdUrl → autoUpdateMinutes/useRemote 一起清
        let existing = json!({"mdUrl":"http://x","autoUpdateMinutes":5,"useRemote":true});
        let patch = json!({"mdUrl":""});
        let m = merge_tool_json(&existing, &patch);
        assert!(m.get("mdUrl").is_none());
        assert!(m.get("autoUpdateMinutes").is_none());
        assert!(m.get("useRemote").is_none());
    }

    // ── build_buttons_append（对偶 tests/buttonBlock.test.ts 的 append 部分）──
    #[test]
    fn append_empty_body_is_noop() {
        assert_eq!(build_buttons_append("existing", "   "), "existing");
    }

    #[test]
    fn append_to_empty_doc() {
        assert_eq!(build_buttons_append("", "ls\npwd"), "```buttons\nls\npwd\n```\n");
    }

    #[test]
    fn append_to_existing_doc_adds_separator() {
        let r = build_buttons_append("# Title\n", "git status");
        assert_eq!(r, "# Title\n\n```buttons\ngit status\n```\n");
    }

    #[test]
    fn append_trims_trailing_whitespace_of_body() {
        // body 尾部空白被 trim
        let r = build_buttons_append("", "ls\n\n\n");
        assert_eq!(r, "```buttons\nls\n```\n");
    }

    // ── parse_tool_meta（对偶 tests/toolConfig.test.ts）───────────────────────
    #[test]
    fn meta_defaults_name_to_id_when_missing() {
        let m = parse_tool_meta(&json!({}), "git");
        assert_eq!(m.id, "git");
        assert_eq!(m.name, "git"); // name 缺省 = id
        assert_eq!(m.icon, "▣");   // 默认图标
        assert_eq!(m.order, 0);
    }

    #[test]
    fn meta_takes_name_icon_order_from_raw() {
        let m = parse_tool_meta(&json!({"name":"Git","icon":"🌿","order":3}), "git");
        assert_eq!(m.name, "Git");
        assert_eq!(m.icon, "🌿");
        assert_eq!(m.order, 3);
    }

    #[test]
    fn meta_parses_init_commands_from_string() {
        // 逗号/换行分隔的字符串
        let m = parse_tool_meta(&json!({"initCommands":"a\nb,c"}), "x");
        assert_eq!(m.init_commands, Some(vec!["a".into(), "b".into(), "c".into()]));
    }

    #[test]
    fn meta_drops_blank_init_commands() {
        let m = parse_tool_meta(&json!({"initCommands":["","","  "]}), "x");
        assert_eq!(m.init_commands, None); // 全空 → None
    }

    // ── slugify（对偶 ipc.ts 行为）────────────────────────────────────────────
    #[test]
    fn slugify_lowercases_and_dashes() {
        assert_eq!(slugify("My Tool"), "my-tool");
    }

    #[test]
    fn slugify_collapses_runs_and_trims() {
        assert_eq!(slugify("  a  b!!c  "), "a-b-c");
    }

    #[test]
    fn slugify_empty_becomes_tool() {
        assert_eq!(slugify("!!!"), "tool"); // 全非字母数字 → 兜底
    }
}
```

- [ ] **Step 3: 运行测试确认它们失败（编译失败也算）**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure 2>&1 | tail -15`
Expected: 编译失败（`unimplemented!` 在 cargo 编译期不报错，但测试运行时 panic；或者因为 types.rs 还没 mod 进 lib.rs 而编译失败）。先把 types.rs/pure.rs 加入 lib.rs（下一步），再回来跑。

- [ ] **Step 4: 把 types.rs 和 pure.rs 加入 lib.rs**

Edit `src-tauri/src/lib.rs`，在文件顶部 `use tauri::Manager;` 之前加：

```rust
mod types;
mod pure;
```

- [ ] **Step 5: 实现 pure.rs 的函数（替换 unimplemented!）**

把 pure.rs 里每个 `unimplemented!(...)` 替换为真实实现：

`merge_tool_json`：
```rust
pub fn merge_tool_json(existing: &Value, patch: &Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Some(o) = existing.as_object() {
        for (k, v) in o {
            if !v.is_null() {
                merged.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(o) = patch.as_object() {
        for (k, v) in o {
            if !v.is_null() {
                merged.insert(k.clone(), v.clone());
            }
        }
    }
    // 裁掉被清空的 optional 字段
    for k in &["cwd", "tmux", "mdUrl"] {
        if merged.get(*k).and_then(|v| v.as_str()) == Some("") {
            merged.remove(*k);
        }
    }
    if merged.get("initCommands").and_then(|v| v.as_array())
        .map(|a| a.is_empty()).unwrap_or(false)
    {
        merged.remove("initCommands");
    }
    if merged.get("mdUrl").is_none() {
        merged.remove("autoUpdateMinutes");
        merged.remove("useRemote");
    }
    Value::Object(merged)
}
```

`build_buttons_append`：
```rust
pub fn build_buttons_append(current_md: &str, body: &str) -> String {
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        return current_md.to_string();
    }
    let trimmed_md = current_md.trim_end();
    let fence = format!("```buttons\n{}\n```", trimmed_body);
    if trimmed_md.is_empty() {
        format!("{}\n", fence)
    } else {
        format!("{}\n\n{}\n", trimmed_md, fence)
    }
}
```

`parse_tool_meta`：
```rust
pub fn parse_tool_meta(raw: &Value, id: &str) -> ToolMeta {
    let o = raw.as_object();
    let name = o
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.to_string());
    let icon = o
        .and_then(|m| m.get("icon"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("▣")
        .to_string();
    let order = o
        .and_then(|m| m.get("order"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mut meta = ToolMeta {
        id: id.to_string(),
        name,
        icon,
        order,
        cwd: None,
        shell: None,
        env: None,
        tmux: None,
        init_commands: None,
        md_url: None,
        auto_update_minutes: None,
        use_remote: None,
    };
    if let Some(cwd) = o.and_then(|m| m.get("cwd")).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        meta.cwd = Some(cwd);
    }
    if let Some(shell) = o.and_then(|m| m.get("shell")).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        meta.shell = Some(shell);
    }
    if let Some(env) = o.and_then(|m| m.get("env")).and_then(|v| v.as_object()).map(|m| {
        m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()
    }) {
        if !env.is_empty() {
            meta.env = Some(env);
        }
    }
    if let Some(tmux) = o.and_then(|m| m.get("tmux")).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        meta.tmux = Some(tmux);
    }
    meta.init_commands = parse_init_commands(o.and_then(|m| m.get("initCommands")));
    if let Some(md_url) = o.and_then(|m| m.get("mdUrl")).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        meta.md_url = Some(md_url);
    }
    if let Some(aum) = o.and_then(|m| m.get("autoUpdateMinutes")).and_then(|v| v.as_i64()) {
        meta.auto_update_minutes = Some(aum);
    }
    if o.and_then(|m| m.get("useRemote")) == Some(&Value::Bool(true)) {
        meta.use_remote = Some(true);
    }
    meta
}

fn parse_init_commands(raw: Option<&Value>) -> Option<Vec<String>> {
    let raw = raw?;
    let list: Vec<String> = if let Some(arr) = raw.as_array() {
        arr.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string())).collect()
    } else if let Some(s) = raw.as_str() {
        // 逗号或换行分隔
        s.split(|c| c == '\n' || c == '\r' || c == ',')
            .map(|s| s.trim().to_string())
            .collect()
    } else {
        return None;
    };
    let cmds: Vec<String> = list.into_iter().filter(|s| !s.is_empty()).collect();
    if cmds.is_empty() { None } else { Some(cmds) }
}
```

`parse_tools_bundle`：
```rust
pub fn parse_tools_bundle(raw: &str) -> ParseResult {
    let obj: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return ParseResult { tools: vec![], error: Some(format!("JSON 解析失败: {}", e)) },
    };
    let o = match obj.as_object() {
        Some(m) => m,
        None => return ParseResult { tools: vec![], error: Some("根元素不是对象".into()) },
    };
    let tools_arr = match o.get("tools").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return ParseResult { tools: vec![], error: Some("缺少 tools 数组".into()) },
    };
    let mut tools: Vec<BundleTool> = vec![];
    for (i, item) in tools_arr.iter().enumerate() {
        let it = match item.as_object() { Some(m) => m, None => continue };
        // 接受 {meta:{...}} 或扁平 shape
        let meta_in = it.get("meta").and_then(|v| v.as_object()).unwrap_or(it);
        let fallback_id = it.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            .map(|s| s.to_string()).unwrap_or_else(|| format!("tool-{}", i + 1));
        let id = meta_in.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            .map(|s| s.to_string()).unwrap_or(fallback_id);
        let meta = parse_tool_meta(&Value::Object(meta_in.clone()), &id);
        let help_markdown = it.get("helpMarkdown").and_then(|v| v.as_str()).unwrap_or("").to_string();
        tools.push(BundleTool { meta, help_markdown });
    }
    if tools.is_empty() {
        return ParseResult { tools: vec![], error: Some("没有可导入的工具".into()) };
    }
    ParseResult { tools, error: None }
}
```

`slugify`：
```rust
pub fn slugify(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // 折叠连续 '-'，去首尾 '-'
    let mut out = String::new();
    let mut prev_dash = true; // 开头视为 dash，避免前导 '-'
    for c in s.chars() {
        if c == '-' {
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { "tool".into() } else { out }
}
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pure 2>&1 | tail -25`
Expected: `running 13 tests` 全部 PASS（merge×3 + append×4 + meta×4 + slugify×3 = 14，按实际写出的数量）。如有失败，对照 TS 实现/测试修正。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/types.rs src-tauri/src/pure.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): add types.rs + pure.rs (data转换 + 14 unit tests)

Rust duals of shared/{toolJson,buttonBlock,bundle,toolConfig}.ts for backend
use. TS originals kept for renderer. Tests mirror the vitest suites."
```

---

## Task B：updater.rs（更新检查）

**Files:**
- Create: `src-tauri/src/updater.rs`

- [ ] **Step 1: 写 updater.rs（含纯函数 + 测试 + 状态机 + reqwest）**

创建 `src-tauri/src/updater.rs`：

```rust
//! 对偶 src/main/updater.ts。reqwest 拉清单，对比版本，状态机 + emit。
//! 不自动下载安装（沿用现状：浏览器打开 DMG）。

use crate::types::UpdateState;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL_DEFAULT: &str = "https://plainraw.com/raw/87c5a6f119b5";
const FETCH_TIMEOUT_MS: u64 = 10_000;

pub struct UpdaterState {
    pub state: UpdateState,
    pub checking: bool,
    pub notified_version: Option<String>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        UpdaterState { state: UpdateState::Idle, checking: false, notified_version: None }
    }
}

// ── 纯函数（对偶 updater.ts，tests/updater.test.ts 覆盖）─────────────────────

/// 解析 "X.Y.Z" 为 [major,minor,patch]，非法返回 None。
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 { return None; }
    let mut nums = vec![];
    for p in parts {
        if !p.chars().all(|c| c.is_ascii_digit()) || p.is_empty() { return None; }
        nums.push(p.parse::<u64>().ok()?);
    }
    Some((nums[0], nums[1], nums[2]))
}

/// 对比版本：>0 remote 更新，0 相等，<0 remote 更旧，None remote 非法。
pub fn compare_versions(remote: &str, current: &str) -> Option<i64> {
    let r = parse_semver(remote)?;
    let c = parse_semver(current)?;
    let cmp = |a: u64, b: u64| -> i64 { if a > b { 1 } else if a < b { -1 } else { 0 } };
    let major = cmp(r.0, c.0);
    if major != 0 { return Some(major); }
    let minor = cmp(r.1, c.1);
    if minor != 0 { return Some(minor); }
    Some(cmp(r.2, c.2))
}

#[derive(Debug, PartialEq)]
pub struct ParsedManifest {
    pub version: String,
    pub url: String,
    pub notes: String,
}

/// 解析清单 JSON，非法返回 None。notes 缺省 ""。
pub fn parse_manifest(raw: &str) -> Option<ParsedManifest> {
    let obj: serde_json::Value = serde_json::from_str(raw).ok()?;
    let o = obj.as_object()?;
    let version = o.get("version")?.as_str()?.to_string();
    let url = o.get("url")?.as_str()?.to_string();
    if version.is_empty() || url.is_empty() { return None; }
    let notes = o.get("notes").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some(ParsedManifest { version, url, notes })
}

// ── 状态机 + 网络（运行时）───────────────────────────────────────────────────

fn set_state(handle: &AppHandle, st: &Mutex<UpdaterState>, next: UpdateState) {
    let mut s = st.lock().unwrap();
    s.state = next.clone();
    let _ = handle.emit("update:state", &s.state); // 广播给 renderer
}

pub fn get_state(st: &Mutex<UpdaterState>) -> UpdateState {
    st.lock().unwrap().state.clone()
}

/// 拉清单并更新状态。manual=true 时把错误/idle 暴露给 UI；auto 静默。
/// 返回 resulting state。防重入。
pub async fn check_for_updates(
    handle: AppHandle,
    st: std::sync::Arc<Mutex<UpdaterState>>,
    app_version: String,
    state_file: std::path::PathBuf,
    manual: bool,
) -> UpdateState {
    {
        let mut s = st.lock().unwrap();
        if s.checking { return s.state.clone(); }
        s.checking = true;
    }
    let result = check_inner(&handle, &st, &app_version, &state_file, manual).await;
    st.lock().unwrap().checking = false;
    result
}

async fn check_inner(
    handle: &AppHandle,
    st: &std::sync::Arc<Mutex<UpdaterState>>,
    app_version: &str,
    state_file: &std::path::Path,
    manual: bool,
) -> UpdateState {
    let url = std::env::var("TERMSTEP_UPDATE_URL").unwrap_or_else(|_| MANIFEST_URL_DEFAULT.to_string());
    let raw = match fetch_manifest(&url).await {
        Ok(r) => r,
        Err(_) => {
            if manual { set_state(handle, st, UpdateState::Error { error: "检查更新失败，请检查网络后重试".into() }); }
            return get_state(st);
        }
    };
    let manifest = match parse_manifest(&raw) {
        Some(m) => m,
        None => {
            if manual { set_state(handle, st, UpdateState::Error { error: "更新信息格式无效".into() }); }
            return get_state(st);
        }
    };
    match compare_versions(&manifest.version, app_version) {
        None => {
            if manual { set_state(handle, st, UpdateState::Error { error: "更新版本号格式无效".into() }); }
        }
        Some(cmp) => {
            if cmp > 0 {
                // 去重：auto 检查对已通知版本保持 idle
                let already = st.lock().unwrap().notified_version.as_deref() == Some(&manifest.version);
                if !(manual == false && already) {
                    set_state(handle, st, UpdateState::Available {
                        version: manifest.version.clone(),
                        url: manifest.url.clone(),
                        notes: manifest.notes.clone(),
                    });
                    let _ = std::fs::write(state_file, serde_json::json!({"version": manifest.version}).to_string());
                }
            } else if manual {
                set_state(handle, st, UpdateState::UpToDate);
            }
        }
    }
    get_state(st)
}

async fn fetch_manifest(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .build()?;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()).into());
    }
    Ok(resp.text().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_patch_newer() { assert!(compare_versions("0.4.0", "0.3.0").unwrap() > 0); }
    #[test]
    fn compare_equal() { assert_eq!(compare_versions("0.3.0", "0.3.0").unwrap(), 0); }
    #[test]
    fn compare_older() { assert!(compare_versions("0.2.0", "0.3.0").unwrap() < 0); }
    #[test]
    fn compare_numeric_not_lexic() { assert!(compare_versions("1.0.0", "0.9.9").unwrap() > 0); }
    #[test]
    fn compare_two_digit_segments() { assert!(compare_versions("0.10.0", "0.9.0").unwrap() > 0); }
    #[test]
    fn compare_invalid_abc() { assert!(compare_versions("abc", "0.3.0").is_none()); }
    #[test]
    fn compare_invalid_two_parts() { assert!(compare_versions("1.2", "0.3.0").is_none()); }
    #[test]
    fn compare_invalid_four_parts() { assert!(compare_versions("1.2.3.4", "0.3.0").is_none()); }

    #[test]
    fn manifest_valid() {
        let r = parse_manifest(r#"{"version":"0.4.0","url":"https://x/d.dmg","notes":"fix"}"#).unwrap();
        assert_eq!(r.version, "0.4.0");
        assert_eq!(r.url, "https://x/d.dmg");
        assert_eq!(r.notes, "fix");
    }
    #[test]
    fn manifest_notes_defaults_empty() {
        let r = parse_manifest(r#"{"version":"0.4.0","url":"https://x/d.dmg"}"#).unwrap();
        assert_eq!(r.notes, "");
    }
    #[test]
    fn manifest_invalid_json() { assert!(parse_manifest("not json").is_none()); }
    #[test]
    fn manifest_missing_version() { assert!(parse_manifest(r#"{"url":"x"}"#).is_none()); }
    #[test]
    fn manifest_missing_url() { assert!(parse_manifest(r#"{"version":"0.4.0"}"#).is_none()); }
    #[test]
    fn manifest_version_not_string() { assert!(parse_manifest(r#"{"version":4,"url":"x"}"#).is_none()); }
    #[test]
    fn manifest_url_not_string() { assert!(parse_manifest(r#"{"version":"0.4.0","url":5}"#).is_none()); }
}
```

- [ ] **Step 2: 把 updater 加入 lib.rs mod**

Edit `src-tauri/src/lib.rs`，把：
```rust
mod types;
mod pure;
```
改为：
```rust
mod types;
mod pure;
mod updater;
```

- [ ] **Step 3: 加 reqwest 依赖到 Cargo.toml**

Edit `src-tauri/Cargo.toml`，把 `[dependencies]` 段改为：
```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"], default-features = false, features = ["rustls-tls"] }
tokio = { version = "1", features = ["full"] }
```

（注意 reqwest 用 rustls-tls 避免系统 openssl 依赖，跨机器构建更稳。修正重复的 features key：合并为 `features = ["json", "rustls-tls"]`）

最终 `[dependencies]`：
```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["full"] }
```

- [ ] **Step 4: 跑 updater 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml updater 2>&1 | tail -20`
Expected: 15 个测试 PASS（compare×8 + manifest×7）。首次会下载 reqwest/tokio 依赖（几分钟）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/updater.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(tauri): add updater.rs (compare_versions/parse_manifest + reqwest + state machine + 15 tests)"
```

---

## Task C：tools.rs（scanner + 敏感路径 + fetchRemoteMarkdown）

**Files:**
- Create: `src-tauri/src/tools.rs`

- [ ] **Step 1: 写 tools.rs（含敏感路径守卫 + 测试 + scan + fetch）**

创建 `src-tauri/src/tools.rs`：

```rust
//! 对偶 src/main/toolsScanner.ts。scan 工具目录 + fetch 远程 md（含敏感路径守卫）。

use crate::types::*;
use crate::pure::parse_tool_meta;
use regex::Regex;
use std::path::{Path, PathBuf};

pub const DEFAULT_AUTO_UPDATE_MINUTES: i64 = 0;

// ── 敏感路径守卫（对偶 toolsScanner.ts，tests/toolsScanner.test.ts 覆盖）──────
const SENSITIVE_DIR_SEGMENTS: &[&str] = &[
    ".ssh", ".aws", ".kube", ".docker", ".config/gcloud", ".gnupg",
    "Library/Keychains", "Library/Cookies", ".password-store",
];

fn sensitive_file_patterns() -> Vec<Regex> {
    vec![
        Regex::new(r"(?i)^\.env(\..*)?$").unwrap(),
        Regex::new(r"(?i)^\.netrc$").unwrap(),
        Regex::new(r"(?i)^\.npmrc$").unwrap(),
        Regex::new(r"(?i)^\.pypirc$").unwrap(),
        Regex::new(r"(?i)^\.my\.cnf$").unwrap(),
        Regex::new(r"(?i)^id_[a-z0-9]+$").unwrap(),
        Regex::new(r"(?i)^_netrc$").unwrap(),
        Regex::new(r"(?i)^credentials(\..*)?$").unwrap(),
        Regex::new(r"(?i)^.*\.key$").unwrap(),
        Regex::new(r"(?i)^.*\.pem$").unwrap(),
        Regex::new(r"(?i)^.*\.pfx$").unwrap(),
        Regex::new(r"(?i)^.*\.keystore$").unwrap(),
    ]
}

/// 路径敏感则返回人类可读理由，否则 None。
pub fn sensitive_path_reason(p: &str) -> Option<String> {
    let home = dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_default();
    let mut abs = p.replace('\\', "/");
    if abs.starts_with("~/") {
        abs = format!("{}/{}", home, &abs[2..]);
    }
    let lower = abs.to_lowercase();
    for seg in SENSITIVE_DIR_SEGMENTS {
        let s = seg.to_lowercase();
        if lower.contains(&format!("/{}/", s)) || lower.ends_with(&format!("/{}", s)) {
            return Some(format!("路径位于敏感目录 (/{}/)", seg));
        }
    }
    let base = lower.rsplit('/').next().unwrap_or("").to_string();
    for re in sensitive_file_patterns() {
        if re.is_match(&base) {
            return Some(format!("文件名疑似凭据文件 ({})", base));
        }
    }
    None
}

// ── fetchRemoteMarkdown（对偶 toolsScanner.ts）───────────────────────────────
/// is_local_path: file:// 或非 URL scheme（http/https/data）视为本地路径。
fn is_local_path(url: &str) -> bool {
    if url.starts_with("file://") { return true; }
    let bytes = url.as_bytes();
    let scheme_end = bytes.iter().position(|&b| b == b':');
    match scheme_end {
        Some(i) if i > 0 => {
            let scheme = &url[..i];
            let valid = scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
            let starts_letter = scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
            !(valid && starts_letter && (scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("data")))
        }
        _ => true, // 无 scheme → 本地路径
    }
}

pub struct FetchedMd {
    pub markdown: String,
    pub error: Option<String>,
}

pub async fn fetch_remote_markdown(url: &str) -> FetchedMd {
    if is_local_path(url) {
        let p = if url.starts_with("file://") {
            url.strip_prefix("file://").unwrap_or(url).to_string()
        } else {
            url.to_string()
        };
        if let Some(reason) = sensitive_path_reason(&p) {
            return FetchedMd { markdown: String::new(), error: Some(format!("拒绝读取敏感文件: {}", reason)) };
        }
        match tokio::fs::read_to_string(&p).await {
            Ok(text) => FetchedMd { markdown: text, error: None },
            Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
        }
    } else {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(8000))
            .build().unwrap();
        match client.get(url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return FetchedMd { markdown: String::new(), error: Some(format!("HTTP {}", resp.status())) };
                }
                match resp.text().await {
                    Ok(t) => FetchedMd { markdown: t, error: None },
                    Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
                }
            }
            Err(e) => FetchedMd { markdown: String::new(), error: Some(e.to_string()) },
        }
    }
}

// ── scanTools（对偶 toolsScanner.ts）──────────────────────────────────────────
pub async fn scan_tools(tools_dir: &Path) -> ScanResult {
    let mut result = ScanResult::default();
    let entries = match std::fs::read_dir(tools_dir) {
        Ok(e) => e,
        Err(_) => return result, // 目录缺失 → 空
    };
    for entry in entries.flatten() {
        let child = entry.path();
        let filetype = match entry.file_type() { Ok(f) => f, Err(_) => continue };
        if !filetype.is_dir() { continue; }
        let id = child.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let tool_json_path = child.join("tool.json");
        let meta_raw: serde_json::Value = if tool_json_path.exists() {
            match std::fs::read_to_string(&tool_json_path) {
                Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Object(Default::default())),
                Err(e) => {
                    result.errors.push(ScanError { id: id.clone(), message: format!("tool.json 解析失败: {}", e) });
                    continue;
                }
            }
        } else {
            serde_json::Value::Object(Default::default())
        };
        let mut meta = parse_tool_meta(&meta_raw, &id);
        // help.md
        let help_markdown = std::fs::read_to_string(child.join("help.md")).unwrap_or_default();
        // 可选远程 md
        let mut remote_markdown = None;
        if let Some(md_url) = meta.md_url.clone() {
            if meta.auto_update_minutes.is_none() {
                meta.auto_update_minutes = Some(DEFAULT_AUTO_UPDATE_MINUTES);
            }
            let fetched = fetch_remote_markdown(&md_url).await;
            remote_markdown = if fetched.markdown.is_empty() && fetched.error.is_some() {
                result.errors.push(ScanError { id: id.clone(), message: format!("远程帮助加载失败 ({}): {}", md_url, fetched.error.unwrap()) });
                None
            } else {
                Some(fetched.markdown)
            };
        }
        let tool = Tool { meta, help_markdown, remote_markdown };
        result.tools.push(tool);
    }
    result.tools.sort_by(|a, b| {
        a.meta.order.cmp(&b.meta.order).then_with(|| a.meta.id.cmp(&b.meta.id))
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_ssh_dir() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert!(sensitive_path_reason(&format!("{}/.ssh/id_rsa", home)).is_some());
    }
    #[test]
    fn sensitive_aws_dir() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert!(sensitive_path_reason(&format!("{}/.aws/credentials", home)).is_some());
    }
    #[test]
    fn sensitive_env_file() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert!(sensitive_path_reason(&format!("{}/.env", home)).is_some());
    }
    #[test]
    fn sensitive_pem_anywhere() {
        assert!(sensitive_path_reason("/tmp/server.pem").is_some());
    }
    #[test]
    fn sensitive_npmrc() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert!(sensitive_path_reason(&format!("{}/.npmrc", home)).is_some());
    }
    #[test]
    fn nonsensitive_ok() {
        assert!(sensitive_path_reason("/tmp/notes.md").is_none());
    }
    #[test]
    fn nonsensitive_project_file() {
        assert!(sensitive_path_reason("/Users/x/project/readme.md").is_none());
    }
}
```

- [ ] **Step 2: 把 tools 加入 lib.rs mod**

Edit `src-tauri/src/lib.rs`，加 `mod tools;`。

- [ ] **Step 3: 加 regex/dirs 依赖**

Edit `src-tauri/Cargo.toml` `[dependencies]`，加：
```toml
regex = "1"
dirs = "5"
```

- [ ] **Step 4: 跑 tools 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tools 2>&1 | tail -15`
Expected: 7 个 sensitive_path 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tools.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(tauri): add tools.rs (scan + sensitive-path guard + fetchRemoteMarkdown + 7 tests)"
```

---

## Task D：cwd.rs + watcher.rs + tool_io.rs

这三个模块逻辑相对直接，合并为一个 task。cwd 是 OS 调用（无单元测试，靠手测），watcher 是 notify + emit，tool_io 是 fs CRUD。

**Files:**
- Create: `src-tauri/src/cwd.rs`
- Create: `src-tauri/src/watcher.rs`
- Create: `src-tauri/src/tool_io.rs`

- [ ] **Step 1: 写 cwd.rs（对偶 src/main/cwd.ts）**

创建 `src-tauri/src/cwd.rs`：

```rust
//! 对偶 src/main/cwd.ts。macOS 走 lsof（无 /proc），Linux 走 readlink。

use std::path::PathBuf;

/// 解析进程的实时 cwd。macOS 用 lsof，Linux 用 /proc。None = 读不到。
pub fn live_cwd(pid: u32) -> Option<PathBuf> {
    if pid == 0 { return None; }
    #[cfg(target_os = "linux")]
    {
        if let Ok(p) = std::fs::read_link(format!("/proc/{}/cwd", pid)) {
            return Some(p);
        }
    }
    lsof_cwd(pid)
}

fn lsof_cwd(pid: u32) -> Option<PathBuf> {
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // 'n' 开头的行携带 cwd 路径
    stdout.lines()
        .find(|l| l.starts_with('n'))
        .and_then(|l| l.strip_prefix('n'))
        .map(|s| PathBuf::from(s))
}
```

- [ ] **Step 2: 写 tool_io.rs（对偶 ipc.ts 的 tool CRUD + bundle + quick）**

创建 `src-tauri/src/tool_io.rs`：

```rust
//! 对偶 src/main/ipc.ts 中 tool CRUD / bundle / quick 部分。
//! 所有 fs 操作，由 commands.rs 调用。

use crate::types::*;
use crate::pure::*;
use std::path::Path;

const DEFAULT_QUICK_MD: &str = "# 快捷命令\n\n这些按钮出现在终端标题栏的全局下拉中，可在任意工具的终端执行。点「编辑」修改：\n\n```buttons\npwd # 当前目录\nls -la # 列出文件\nclear # 清屏\n```\n";

/// 读 tool.json + help.md（不做 merge），用于 tool_save。
pub async fn read_tool_json(dir: &Path) -> serde_json::Value {
    match tokio::fs::read_to_string(dir.join("tool.json")).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Object(Default::default())),
        Err(_) => serde_json::Value::Object(Default::default()),
    }
}

/// tool_save：merge tool.json + 写 help.md。
pub async fn tool_save(dir: &Path, markdown: &str, meta_patch: serde_json::Value) -> std::io::Result<()> {
    let existing = read_tool_json(dir).await;
    let merged = merge_tool_json(&existing, &meta_patch);
    tokio::fs::write(dir.join("tool.json"), format!("{}\n", serde_json::to_string_pretty(&merged).unwrap())).await?;
    tokio::fs::write(dir.join("help.md"), markdown).await?;
    Ok(())
}

/// tool_append_buttons：追加 ```buttons 围栏。
pub async fn tool_append_buttons(dir: &Path, body: &str) -> std::io::Result<bool> {
    let file = dir.join("help.md");
    let cur = tokio::fs::read_to_string(&file).await.unwrap_or_default();
    let next = build_buttons_append(&cur, body);
    if next == cur { return Ok(false); } // no-op
    tokio::fs::write(file, next).await?;
    Ok(true)
}

/// 找第一个空闲 id（base 冲突则 -2,-3…）。
pub async fn unique_id(tools_dir: &Path, base: &str) -> String {
    let base = if slugify(base).is_empty() { "tool".to_string() } else { slugify(base) };
    let mut id = base.clone();
    let mut n = 2;
    loop {
        if !tools_dir.join(&id).exists() { return id; }
        id = format!("{}-{}", base, n);
        n += 1;
    }
}

/// tool_create：建目录 + 写 tool.json + starter help.md。返回新 id。
pub async fn tool_create(tools_dir: &Path, name: &str) -> std::io::Result<String> {
    let id = unique_id(tools_dir, name).await;
    let dir = tools_dir.join(&id);
    tokio::fs::create_dir_all(&dir).await?;
    let meta = parse_tool_meta(&serde_json::json!({"name":name,"icon":"★"}), &id);
    let tool_json = serde_json::json!({"name":meta.name,"icon":meta.icon,"order":999});
    tokio::fs::write(dir.join("tool.json"), format!("{}\n", serde_json::to_string_pretty(&tool_json).unwrap())).await?;
    let help = starter_help_md(&meta.name);
    tokio::fs::write(dir.join("help.md"), help).await?;
    Ok(id)
}

fn starter_help_md(name: &str) -> String {
    // 对偶 ipc.ts TOOL_CREATE 的 starter help.md（含 buttons/buttons-json 语法注释）
    format!("# {}\n\n点击按钮运行命令。buttons / buttons-json 的完整语法写在下面这个 buttons 块的注释里（点「编辑」即可看到）。\n\n```buttons\n# ── buttons 语法（每行一条命令）──\n# 命令                 → 生成一个按钮，按钮文字 = 命令本身\nls\n# 命令 # 标签          → 按钮显示「标签」，运行时执行「命令」\n# 命令 // edit         → 只粘贴到终端、不自动回车（编辑模式）\n# 命令 # 标签 // edit  → 带标签的编辑模式\n# // 文字              → 行首以 // 开头：渲染为一段可见纯文本\n# # 文字               → 行首以 # 开头：注释，只留在源码、不渲染（这些行就是）\n# 空行                 → 跳过\n\n# ── buttons-json 语法（带参数的按钮）──\n# 把围栏名 buttons 改成 buttons-json，内容是 JSON 对象或数组，每项可用字段：\n#   command（必填）   label   edit   params\n# params 每项：name（必填）   required   default   hint   options\n# command 里写 {{{{参数名}}}} 占位；点按钮时弹表单收集，值做 POSIX shell 转义后代入\n# 示例（去掉下面这行开头的 #，放进 buttons-json 围栏即可用）：\n# {{\"command\":\"git commit -m {{{{msg}}}}\",\"label\":\"提交\",\"params\":[{{\"name\":\"msg\",\"required\":true}}]}}\n```\n", name)
}

/// tool_delete：rm -r（pty kill 由 command 层做）。
pub async fn tool_delete(tools_dir: &Path, tool_id: &str) -> std::io::Result<()> {
    tokio::fs::remove_dir_all(tools_dir.join(tool_id)).await
}

/// tool_reorder：写各 tool.json 的 order。
pub async fn tool_reorder(tools_dir: &Path, ordered_ids: &[String]) -> std::io::Result<()> {
    for (i, id) in ordered_ids.iter().enumerate() {
        let file = tools_dir.join(id).join("tool.json");
        let raw = tokio::fs::read_to_string(&file).await.unwrap_or_else(|_| "{}".into());
        let mut o: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()));
        if let Some(obj) = o.as_object_mut() { obj.insert("order".into(), serde_json::json!(i)); }
        tokio::fs::write(file, format!("{}\n", serde_json::to_string_pretty(&o).unwrap())).await?;
    }
    Ok(())
}

/// quick_get：读 quick-commands.md，缺失返回 DEFAULT_QUICK_MD。
pub async fn quick_get(user_data_dir: &Path) -> String {
    let file = user_data_dir.join("quick-commands.md");
    tokio::fs::read_to_string(file).await.unwrap_or_else(|_| DEFAULT_QUICK_MD.to_string())
}

/// quick_save。
pub async fn quick_save(user_data_dir: &Path, md: &str) -> std::io::Result<()> {
    tokio::fs::write(user_data_dir.join("quick-commands.md"), md).await
}
```

说明：starter_help_md 里的 `{{{{` 是 Rust format! 的转义，输出 `{{`（即 TS 模板里的 `{{`）。需仔细核对输出与原 TS 完全一致。

- [ ] **Step 3: 写 watcher.rs（对偶 toolManager.ts）**

创建 `src-tauri/src/watcher.rs`：

```rust
//! 对偶 src/main/toolManager.ts。notify 监听 toolsDir，变化触发 scan + emit。
//! auto-refresh tick（每 30s）检查 mdUrl 工具是否到期。

use crate::tools::scan_tools;
use crate::types::*;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use notify::{Watcher, RecursiveMode, EventKind};

pub struct WatcherState {
    pub last_tools: Vec<Tool>,
    pub last_fetched: std::collections::HashMap<String, Instant>,
}

pub async fn start_watcher(handle: AppHandle, tools_dir: PathBuf) -> Arc<Mutex<WatcherState>> {
    let state = Arc::new(Mutex::new(WatcherState {
        last_tools: vec![],
        last_fetched: std::collections::HashMap::new(),
    }));

    // 初始 scan + 广播（让 renderer 启动即有数据）
    refresh(&handle, &tools_dir, &state).await;

    // notify 监听（debounce 200ms，对齐 chokidar awaitWriteFinish）
    let h1 = handle.clone();
    let td1 = tools_dir.clone();
    let st1 = state.clone();
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(tx, notify::Config::default()) {
            Ok(w) => w,
            Err(e) => { eprintln!("watcher init failed: {}", e); return; }
        };
        let _ = watcher.watch(&td1, RecursiveMode::Recursive);
        let mut last_fire = None::<Instant>;
        while let Ok(res) = rx.recv() {
            if let Ok(ev) = res {
                // 忽略不需要的事件类型
                match ev.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
                    _ => continue,
                }
                // debounce: 200ms 内多次事件只触发一次
                let now = Instant::now();
                if last_fire.map(|t| now.duration_since(t) < Duration::from_millis(200)).unwrap_or(false) {
                    continue;
                }
                last_fire = Some(now);
                let h = h1.clone();
                let td = td1.clone();
                let st = st1.clone();
                // 短延迟聚合（再等 150ms 让连续写入稳定）
                std::thread::sleep(Duration::from_millis(150));
                tauri::async_runtime::spawn(async move {
                    refresh(&h, &td, &st).await;
                });
            }
        }
    });

    // auto-refresh tick（30s）
    let h2 = handle.clone();
    let td2 = tools_dir.clone();
    let st2 = state.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            maybe_auto_refresh(&h2, &td2, &st2).await;
        }
    });

    state
}

async fn refresh(handle: &AppHandle, tools_dir: &std::path::Path, state: &Arc<Mutex<WatcherState>>) -> ScanResult {
    let r = scan_tools(tools_dir).await;
    {
        let mut s = state.lock().unwrap();
        s.last_tools = r.tools.clone();
        let now = Instant::now();
        for t in &r.tools {
            if t.meta.md_url.is_some() && !s.last_fetched.contains_key(&t.meta.id) {
                s.last_fetched.insert(t.meta.id.clone(), now);
            }
        }
    }
    let _ = handle.emit("tools:changed", &r);
    r
}

async fn maybe_auto_refresh(handle: &AppHandle, tools_dir: &std::path::Path, state: &Arc<Mutex<WatcherState>>) {
    let now = Instant::now();
    let due = {
        let s = state.lock().unwrap();
        let mut d = false;
        for t in &s.last_tools {
            if t.meta.md_url.is_none() { continue; }
            let mins = t.meta.auto_update_minutes.unwrap_or(0);
            if mins <= 0 { continue; }
            if let Some(last) = s.last_fetched.get(&t.meta.id) {
                if now.duration_since(*last) >= Duration::from_mins(mins as u64 * 60_000 / 1000) {
                    d = true;
                }
            }
        }
        d
    };
    if due { refresh(handle, tools_dir, state).await; }
}

// Duration::from_mins 不存在，用辅助
trait DurExt {
    fn from_mins(mins: u64) -> Duration;
}
impl DurExt for Duration {
    fn from_mins(mins: u64) -> Duration { Duration::from_secs(mins * 60) }
}
```

> 注意：上面 `Duration::from_mins` 是为可读性写的 trait；实际用 `Duration::from_secs(mins * 60)`。实现时直接用 from_secs，删掉 trait。

- [ ] **Step 4: 把 cwd/tool_io/watcher 加入 lib.rs mod + 加 notify 依赖**

Edit `src-tauri/src/lib.rs`，加：
```rust
mod cwd;
mod tool_io;
mod watcher;
```

Edit `src-tauri/Cargo.toml` `[dependencies]`，加：
```toml
notify = "6"
```

- [ ] **Step 5: cargo check 确认编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -15`
Expected: Finished，无 error。如有，按编译错误修正（watcher 的 async/spawn、Duration trait 等）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/cwd.rs src-tauri/src/tool_io.rs src-tauri/src/watcher.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(tauri): add cwd.rs + tool_io.rs + watcher.rs (fs CRUD + notify watch + emit)"
```

---

## Task E：commands.rs + lib.rs 注册 + State 初始化

把所有模块接成 Tauri commands，注册到 Builder，初始化 State（updater + watcher），启动 auto-update check。

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写 commands.rs**

创建 `src-tauri/src/commands.rs`：

```rust
//! 所有 #[tauri::command]，薄封装，调各模块。参数从前端 camelCase 传入。

use crate::types::*;
use crate::{tools, tool_io, updater, cwd};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State, Manager, Emitter};

// ── tools ───────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn tools_list(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>) -> Result<ScanResult, String> {
    let td = tools_dir.lock().unwrap().clone();
    Ok(tools::scan_tools(&td).await)
}

#[tauri::command]
pub async fn refresh_md(handle: AppHandle, watcher_state: State<'_, Arc<Mutex<crate::watcher::WatcherState>>>, tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>) -> Result<(), String> {
    let td = tools_dir.lock().unwrap().clone();
    let r = tools::scan_tools(&td).await;
    {
        let mut s = watcher_state.lock().unwrap();
        s.last_tools = r.tools.clone();
    }
    let _ = handle.emit("tools:changed", &r);
    Ok(())
}

// ── tool CRUD ───────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn tool_save(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, tool_id: String, markdown: String, meta_patch: serde_json::Value) -> Result<(), String> {
    let td = tools_dir.lock().unwrap().clone();
    tool_io::tool_save(&td.join(&tool_id), &markdown, meta_patch).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_append_buttons(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, tool_id: String, body: String) -> Result<bool, String> {
    let td = tools_dir.lock().unwrap().clone();
    tool_io::tool_append_buttons(&td.join(&tool_id), &body).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_create(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, name: String) -> Result<String, String> {
    let td = tools_dir.lock().unwrap().clone();
    tool_io::tool_create(&td, &name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_delete(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, tool_id: String) -> Result<(), String> {
    let td = tools_dir.lock().unwrap().clone();
    // pty kill 留到阶段 3（现在 stub 不接 pty）
    tool_io::tool_delete(&td, &tool_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_reorder(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, ordered_ids: Vec<String>) -> Result<(), String> {
    let td = tools_dir.lock().unwrap().clone();
    tool_io::tool_reorder(&td, &ordered_ids).await.map_err(|e| e.to_string())
}

// ── md ──────────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn fetch_md_preview(url: String) -> Result<serde_json::Value, String> {
    if url.trim().is_empty() {
        return Ok(serde_json::json!({"markdown":"","error":"URL 为空"}));
    }
    let r = tools::fetch_remote_markdown(url.trim()).await;
    Ok(serde_json::json!({"markdown":r.markdown,"error":r.error}))
}

#[tauri::command]
pub async fn pick_md_file() -> Result<serde_json::Value, String> {
    let res = rfd::AsyncFileDialog::new()
        .set_title("选择 Markdown 文件")
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .add_filter("所有文件", &["*"])
        .pick_file().await;
    match res {
        Some(f) => Ok(serde_json::json!({"canceled":false,"path":f.path().to_string_lossy()})),
        None => Ok(serde_json::json!({"canceled":true})),
    }
}

// ── bundle ──────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn tools_export(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>) -> Result<serde_json::Value, String> {
    let td = tools_dir.lock().unwrap().clone();
    let scan = tools::scan_tools(&td).await;
    let bundle = crate::pure::serialize_tools(&scan.tools, &chrono::Utc::now().to_rfc3339());
    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let file = rfd::AsyncFileDialog::new()
        .set_title("导出工具")
        .set_file_name(format!("termstep-tools-{}.json", stamp))
        .add_filter("TermStep 工具包", &["json"])
        .save_file().await;
    match file {
        Some(f) => {
            let path = f.path();
            let content = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
            tokio::fs::write(path, format!("{}\n", content)).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"canceled":false,"path":path.to_string_lossy(),"count":scan.tools.len()}))
        }
        None => Ok(serde_json::json!({"canceled":true})),
    }
}

#[tauri::command]
pub async fn export_one(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, tool_id: String) -> Result<serde_json::Value, String> {
    let td = tools_dir.lock().unwrap().clone();
    let scan = tools::scan_tools(&td).await;
    let tool = scan.tools.into_iter().find(|t| t.meta.id == tool_id)
        .ok_or("未找到该工具")?;
    let bundle = crate::pure::serialize_tools(&[tool], &chrono::Utc::now().to_rfc3339());
    let name = crate::pure::slugify(&tool.meta.name);
    let name = if name.is_empty() { tool.meta.id.clone() } else { name };
    let file = rfd::AsyncFileDialog::new()
        .set_title("导出工具")
        .set_file_name(format!("termstep-{}.json", name))
        .add_filter("TermStep 工具包", &["json"])
        .save_file().await;
    match file {
        Some(f) => {
            let path = f.path();
            let content = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
            tokio::fs::write(path, format!("{}\n", content)).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"canceled":false,"path":path.to_string_lossy(),"count":1}))
        }
        None => Ok(serde_json::json!({"canceled":true})),
    }
}

#[tauri::command]
pub async fn tools_import(tools_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>) -> Result<serde_json::Value, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_title("导入工具")
        .add_filter("TermStep 工具包", &["json"])
        .pick_file().await;
    let f = match file { Some(f) => f, None => return Ok(serde_json::json!({"canceled":true})) };
    let raw = tokio::fs::read_to_string(f.path()).await.map_err(|e| format!("读取文件失败: {}", e))?;
    let parsed = crate::pure::parse_tools_bundle(&raw);
    if let Some(err) = parsed.error {
        return Ok(serde_json::json!({"canceled":false,"count":0,"error":err}));
    }
    let td = tools_dir.lock().unwrap().clone();
    let mut count = 0;
    for t in parsed.tools {
        let id = tool_io::unique_id(&td, &t.meta.id).await;
        let dir = td.join(&id);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let mut meta = serde_json::to_value(&t.meta).map_err(|e| e.to_string())?;
        if let Some(o) = meta.as_object_mut() { o.remove("id"); } // id 在目录名
        tokio::fs::write(dir.join("tool.json"), format!("{}\n", serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?)).await.map_err(|e| e.to_string())?;
        tokio::fs::write(dir.join("help.md"), &t.help_markdown).await.map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(serde_json::json!({"canceled":false,"count":count}))
}

// ── quick ───────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn quick_get(user_data_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>) -> Result<String, String> {
    let ud = user_data_dir.lock().unwrap().clone();
    Ok(tool_io::quick_get(&ud).await)
}

#[tauri::command]
pub async fn quick_save(user_data_dir: State<'_, std::sync::Mutex<std::path::PathBuf>>, md: String) -> Result<(), String> {
    let ud = user_data_dir.lock().unwrap().clone();
    tool_io::quick_save(&ud, &md).await.map_err(|e| e.to_string())
}

// ── shell / clipboard ───────────────────────────────────────────────────────
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        opener::open(&url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn clipboard_read(app: AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// ── update ──────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn update_check(handle: AppHandle, state: State<'_, Arc<Mutex<crate::updater::UpdaterState>>>, app_version: String, state_file: State<'_, std::sync::Mutex<std::path::PathBuf>>) -> Result<UpdateState, String> {
    let sf = state_file.lock().unwrap().clone();
    Ok(updater::check_for_updates(handle, Arc::new(Mutex::new(updater::UpdaterState::default())), app_version, sf, true).await)
}

// ── pty（阶段 3 实现；本阶段 stub 让 renderer 的 invoke 不报错）──────────────
#[tauri::command]
pub async fn pty_write(_tool_id: String, _data: String, _opts: Option<PtySpawnOpts>) -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_open(_tool_id: String, _opts: Option<PtySpawnOpts>) -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_restart(_tool_id: String, _opts: Option<PtySpawnOpts>) -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_resize(_tool_id: String, _cols: u16, _rows: u16) -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_kill(_tool_id: String) -> Result<(), String> { Ok(()) }
#[tauri::command]
pub async fn pty_cwd(_tool_id: String) -> Result<String, String> {
    // 阶段 2 无 pty，回退到 home
    Ok(dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or("~".into()))
}
```

- [ ] **Step 2: 重写 lib.rs 的 run()（注册 commands + State + 启动 watcher/updater）**

把 `src-tauri/src/lib.rs` 的 `run()` 函数替换为：

```rust
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 路径
            let tools_dir = app.path().app_data_dir().expect("no app_data_dir").join("tools");
            let user_data_dir = app.path().app_data_dir().expect("no app_data_dir");
            let state_file = user_data_dir.join("update-state.json");
            std::fs::create_dir_all(&tools_dir).ok();
            let app_version = app.package_info().version.to_string();

            // seed 默认 git 工具（对偶 seed.ts）—— 仅当 toolsDir 空
            let seed_fut = {
                let td = tools_dir.clone();
                async move {
                    if let Ok(mut entries) = tokio::fs::read_dir(&td).await {
                        if entries.next_entry().await.ok().flatten().is_none() {
                            let _ = crate::seed::seed_default_tool(&td).await;
                        }
                    }
                }
            };
            tauri::async_runtime::spawn(seed_fut);

            // State
            app.manage(std::sync::Mutex::new(tools_dir.clone()));
            app.manage(std::sync::Mutex::new(user_data_dir.clone()));
            app.manage(std::sync::Mutex::new(state_file.clone()));
            app.manage(std::sync::Arc::new(std::sync::Mutex::new(crate::updater::UpdaterState::default())));

            // 启动 watcher（emit tools:changed）
            let handle = app.handle().clone();
            let td = tools_dir.clone();
            tauri::async_runtime::spawn(async move {
                let ws = crate::watcher::start_watcher(handle, td).await;
                // watcher_state 需在 spawn 内 manage？—— 改为在 start_watcher 返回后 manage
                // 这里用 once_cell 或重新设计；简化：watcher_state 在 start_watcher 内自行管理 emit，
                // 对外只需广播。refresh_md 命令需要访问 last_tools → 改为独立 state。
            });

            // devtools
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            // auto-update check（5s 后静默）
            let h = app.handle().clone();
            let av = app_version.clone();
            let sf = state_file.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let st = std::sync::Arc::new(std::sync::Mutex::new(crate::updater::UpdaterState::default()));
                let _ = crate::updater::check_for_updates(h, st, av, sf, false).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::tools_list,
            crate::commands::refresh_md,
            crate::commands::tool_save,
            crate::commands::tool_append_buttons,
            crate::commands::tool_create,
            crate::commands::tool_delete,
            crate::commands::tool_reorder,
            crate::commands::fetch_md_preview,
            crate::commands::pick_md_file,
            crate::commands::tools_export,
            crate::commands::export_one,
            crate::commands::tools_import,
            crate::commands::quick_get,
            crate::commands::quick_save,
            crate::commands::open_external,
            crate::commands::clipboard_read,
            crate::commands::clipboard_write,
            crate::commands::update_check,
            crate::commands::pty_write,
            crate::commands::pty_open,
            crate::commands::pty_restart,
            crate::commands::pty_resize,
            crate::commands::pty_kill,
            crate::commands::pty_cwd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

> 注意：watcher_state 的 manage 需要调整——start_watcher 返回 Arc<Mutex<WatcherState>>，但 setup 里 spawn 了它。最干净的方式：让 start_watcher 接收一个预创建的 state 并 manage 它。实现时按此调整（在 manage 之前创建 state，传引用给 start_watcher）。

- [ ] **Step 3: 加 seed.rs + opener/rfd/chrono 依赖**

创建 `src-tauri/src/seed.rs`（对偶 src/main/seed.ts）：
```rust
use std::path::Path;

pub async fn seed_default_tool(tools_dir: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(tools_dir).await?;
    let git_dir = tools_dir.join("git");
    tokio::fs::create_dir_all(&git_dir).await?;
    tokio::fs::write(
        git_dir.join("tool.json"),
        "{\n  \"name\": \"Git\",\n  \"icon\": \"🌿\",\n  \"order\": 0\n}\n"
    ).await?;
    let help = "# Git\n\n常用命令：\n\n```buttons\n// 查看状态\ngit status # 查看状态\ngit log --oneline -20\n\n// 改完再提交\ngit commit -m \"\" // edit\ngit push # 推送\n```\n\n带参数：\n\n```buttons-json\n[\n  {\n    \"label\": \"提交（填信息）\",\n    \"command\": \"git commit -m {{message}}\",\n    \"edit\": true,\n    \"params\": [\n      { \"name\": \"message\", \"hint\": \"提交信息\", \"required\": true }\n    ]\n  }\n]\n```\n";
    tokio::fs::write(git_dir.join("help.md"), help).await?;
    Ok(())
}
```

Edit `src-tauri/Cargo.toml` `[dependencies]`，加：
```toml
rfd = "0.14"
opener = "0.7"
chrono = "0.4"
```

Edit `src-tauri/src/lib.rs` 顶部 mod 列表加 `mod commands; mod seed;`。

- [ ] **Step 4: cargo check + 跑所有 Rust 测试**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -15`
Expected: Finished。修正编译错误（State 生命周期、async command、watcher_state manage 等）。

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10`
Expected: 所有 pure/updater/tools 测试仍 PASS（commands 无单元测试）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/seed.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(tauri): register all commands + State init + watcher/updater startup"
```

---

## Task F：renderer 适配层（api.ts + useTauriEvent + 34 处调用点改造）

**Files:**
- Create: `src/renderer/lib/api.ts`
- Create: `src/renderer/hooks/useTauriEvent.ts`
- Modify: 11 个 renderer 文件（34 处调用点）
- Modify: `src/renderer/main.tsx`（移除 stub）
- Modify: `src/renderer/types/global.d.ts`（移除 window.api 声明）

- [ ] **Step 1: 写 useTauriEvent.ts**

创建 `src/renderer/hooks/useTauriEvent.ts`：

```ts
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// 统一事件订阅：封装 Tauri listen() 的异步性（返回 Promise<UnlistenFn>），
// 让组件像用同步 cleanup 那样订阅。handler 用 ref 保持最新，不重订阅。
export function useTauriEvent<T>(name: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let active = true;
    listen<T>(name, (e) => ref.current(e.payload)).then((u) => {
      if (active) un = u;
      else u();
    });
    return () => {
      active = false;
      un?.();
    };
  }, [name]);
}
```

- [ ] **Step 2: 写 api.ts（同构 preload Api shape）**

创建 `src/renderer/lib/api.ts`：

```ts
import { invoke } from '@tauri-apps/api/core';
import type { ScanResult, ToolMeta, PtySpawnOpts, UpdateState } from '../../shared/types';

// 同构 preload/index.ts 的 api，但底层走 Tauri invoke/listen。
// 所有命名空间/方法签名与原 window.api 一致，调用点只需 window.api → api。
export const api = {
  tools: {
    list: (): Promise<ScanResult> => invoke('tools_list'),
    onChanged: (cb: (r: ScanResult) => void) =>
      listen<ScanResult>('tools:changed', (e) => cb(e.payload)),
  },
  pty: {
    onData: (cb: (toolId: string, data: string) => void) =>
      listen<{ toolId: string; data: string }>('pty:data', (e) => cb(e.payload.toolId, e.payload.data)),
    write: (toolId: string, data: string, opts?: PtySpawnOpts) =>
      invoke('pty_write', { toolId, data, opts }),
    open: (toolId: string, opts?: PtySpawnOpts) => invoke('pty_open', { toolId, opts }),
    restart: (toolId: string, opts?: PtySpawnOpts) => invoke('pty_restart', { toolId, opts }),
    resize: (toolId: string, cols: number, rows: number) => invoke('pty_resize', { toolId, cols, rows }),
    cwd: (toolId: string) => invoke<string>('pty_cwd', { toolId }),
    kill: (toolId: string) => invoke('pty_kill', { toolId }),
  },
  tool: {
    save: (toolId: string, markdown: string, meta: Partial<ToolMeta>) =>
      invoke('tool_save', { toolId, markdown, metaPatch: meta }),
    appendButtons: (toolId: string, body: string) =>
      invoke('tool_append_buttons', { toolId, body }),
    create: (name: string) => invoke<string>('tool_create', { name }),
    del: (toolId: string) => invoke('tool_delete', { toolId }),
    reorder: (orderedIds: string[]) => invoke('tool_reorder', { orderedIds }),
  },
  shell: {
    openExternal: (url: string) => invoke('open_external', { url }),
  },
  clipboard: {
    readText: () => invoke<string>('clipboard_read'),
    writeText: (text: string) => invoke('clipboard_write', { text }),
  },
  update: {
    onState: (cb: (s: UpdateState) => void) =>
      listen<UpdateState>('update:state', (e) => cb(e.payload)),
    check: () => invoke('update_check'),
  },
  bundle: {
    export: () => invoke('tools_export'),
    exportOne: (toolId: string) => invoke('export_one', { toolId }),
    import: () => invoke('tools_import'),
  },
  refreshMd: () => invoke('refresh_md'),
  fetchMdPreview: (url: string) =>
    invoke<{ markdown: string; error: string | null }>('fetch_md_preview', { url }),
  pickMdFile: () =>
    invoke<{ canceled: true } | { canceled: false; path: string }>('pick_md_file'),
  quick: {
    get: () => invoke<string>('quick_get'),
    save: (md: string) => invoke('quick_save', { md }),
  },
};

// 事件订阅方法返回 Promise<UnlistenFn>（listen 异步）。组件用 useTauriEvent 包装；
// 非 hook 调用点（目前无）自行 .then。为兼容「直接 return cleanup」的旧写法，
// useTools/useUpdateState/TerminalView 改用 useTauriEvent。
```

注意 `api.ts` 需要 `import { listen } from '@tauri-apps/api/event'`（顶部加）。

- [ ] **Step 3: 改造 3 个事件订阅点**

`src/renderer/hooks/useTools.ts`：
```ts
import { useEffect, useState } from 'react';
import type { ScanResult } from '../../shared/types';
import { api } from '../lib/api';
import { useTauriEvent } from './useTauriEvent';

export function useTools(): ScanResult {
  const [result, setResult] = useState<ScanResult>({ tools: [], errors: [] });
  useTauriEvent<ScanResult>('tools:changed', setResult);
  useEffect(() => {
    api.tools.list().then(setResult);
  }, []);
  return result;
}
```

`src/renderer/hooks/useUpdateState.ts`：
```ts
import { useState } from 'react';
import type { UpdateState } from '../../shared/types';
import { useTauriEvent } from './useTauriEvent';

export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useTauriEvent<UpdateState>('update:state', setState);
  return state;
}
```

`src/renderer/components/TerminalView.tsx`（pty.onData 部分，约 113 行）：把原 `window.api.pty.onData(...)`（在 useEffect 内，返回 cleanup）改为 useTauriEvent。但 TerminalView 的 onData 需按 toolId 过滤且依赖 term 实例——保留其 useEffect 结构，内部用 listen + 过滤。具体改法在实现时按文件实际结构定（需读该文件完整上下文）。

- [ ] **Step 4: 改造 31 处 invoke 调用点**

对每个文件：`window.api.X` → `api.X`，并加 `import { api } from '../lib/api'`（或相对路径）。逐文件改：

- `App.tsx`（10 处：pty.cwd, tool.create/del/reorder, bundle.export/exportOne/import, refreshMd, pty.restart, tool.appendButtons）
- `TerminalView.tsx`（6 处 invoke：clipboard.writeText×3, readText, pty.write/resize/open）
- `HelpPane.tsx`（1 处：shell.openExternal）
- `QuickCommands.tsx`（3 处：quick.get×2, quick.save）
- `QuickAddModal.tsx`（1 处：clipboard.readText）
- `UpdateChecker.tsx`（2 处：update.check, shell.openExternal）
- `EditorPane.tsx`（3 处：fetchMdPreview, tool.save, pickMdFile）
- `termRegistry.ts`（2 处：pty.write×2）

实现时用 Edit 工具逐个 `window.api.` → `api.` 替换（多数可用 replace_all），并确保每个文件顶部有 `import { api }`。

- [ ] **Step 5: 移除 stub（main.tsx + global.d.ts）**

`src/renderer/main.tsx`：删除 stubApi import 和 `if (!window.api)` 注入块（恢复为原始 main.tsx）。

`src/renderer/types/global.d.ts`：删除整个文件（不再需要 window.api 声明；组件直接 import api）。

- [ ] **Step 6: 更新 tsconfig.web.json 移除 global.d.ts 引用**

（已在阶段 1 移除 preload 引用；确认 include 不再含 types/global.d.ts——删文件后无需引用）

- [ ] **Step 7: typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 0 errors。如有「api 未导入」或参数不匹配，逐个修正。

Run: `npm run build:web`
Expected: 构建成功。

- [ ] **Step 8: 删除 stubApi.ts**

```bash
rm src/renderer/lib/stubApi.ts
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(tauri): renderer IPC layer → Tauri invoke/listen (api.ts + useTauriEvent, 34 call sites)

- lib/api.ts: Tauri wrappers mirroring preload Api shape
- hooks/useTauriEvent.ts: unify async listen() into a sync-cleanup hook
- 31 invoke call sites: window.api.X → api.X
- 3 event subscriptions: useTauriEvent
- remove stubApi + window.api ambient decl
- pty commands stub in Rust (real PTY in stage 3)"
```

---

## Task G：端到端手测 + 验证

**Files:** 无。

- [ ] **Step 1: 清理端口 + 启动 dev**

```bash
lsof -ti:1420 | xargs kill -9 2>/dev/null
npm run dev
```

- [ ] **Step 2: 手测清单（本阶段验收）**

在打开的窗口里逐项验证：
- [ ] 侧边栏显示默认 Git 工具（seed 生效）
- [ ] 点击 Git → 帮助页显示按钮（buttons 渲染，TS shared/buttonBlock 仍工作）
- [ ] 新建工具 → 出现在侧边栏
- [ ] 编辑工具（meta + markdown）→ 保存生效，刷新仍在
- [ ] 删除工具 → 消失
- [ ] 拖拽排序 → 持久化
- [ ] 导出全部/单个 → 保存对话框 + json 文件
- [ ] 导入 → 工具出现
- [ ] quick commands 下拉 → 显示默认 pwd/ls/clear
- [ ] 编辑 quick commands → 保存生效
- [ ] 帮助页点外链 → 浏览器打开
- [ ] 终端区域选中文字 → 复制到剪贴板；⌘V 粘贴（stub 不报错即可，pty 阶段 3）
- [ ] 更新检查（点 sidebar 检查更新）→ 状态变化（idle/checking/upToDate/error）
- [ ] mdUrl 订阅：编辑某工具加 http URL → 帮助页显示远程内容
- [ ] devtools 控制台无报错（除 pty 相关的预期 stub）

- [ ] **Step 3: 跑 vitest 确认 shared 测试仍绿**

```bash
npm run test 2>&1 | tail -15
```
Expected: shared/ 的所有测试 PASS（buttonBlock/bundle/toolConfig/toolJson/tmux/peekController/dangerous）。updater/toolsScanner/cwd/ptyService 的测试会因 import 的 main/ 文件还在而仍跑——它们测的是 TS 版，与 Rust 并存，阶段 4 删 TS 时一并删。

- [ ] **Step 4: 更新进度文档 + Commit**

更新 `docs/superpowers/plans/tauri-migration-progress.md`，记录阶段 2 完成 + 手测结果。

```bash
git add docs/superpowers/plans/tauri-migration-progress.md
git commit -m "docs(tauri): record stage 2 (low-risk modules) completion"
```

---

## 阶段 2 完成标准（Definition of Done）

- [x] types.rs + pure.rs（14 单元测试 PASS）
- [x] updater.rs（15 测试 PASS，reqwest 拉清单，状态机 emit）
- [x] tools.rs（7 敏感路径测试 PASS，scan + fetchRemoteMarkdown）
- [x] tool_io.rs + cwd.rs + watcher.rs（fs CRUD + notify + emit）
- [x] commands.rs 注册 24 个 command + State 初始化 + watcher/updater 启动
- [x] renderer api.ts + useTauriEvent，34 处调用点全切换
- [x] stubApi 删除，window.api ambient 声明删除
- [x] `npm run typecheck` + `npm run build:web` 通过
- [x] vitest（shared 测试）全绿
- [x] tauri dev 手测：工具 CRUD/导入导出/quick/剪贴板/外链/更新/mdUrl 全工作
- [x] PTY 仍为 stub（阶段 3 实现）

## 阶段 2 不做

- PTY 服务（portable-pty，阶段 3）
- pty:data 事件（阶段 3）
- 删除 Electron 文件/依赖（阶段 4）
- 原生菜单/Dock/About（阶段 4）

---

## 风险与缓解

- **watcher 的 emit 时机**：notify 事件 → debounce → scan → emit。若 scan 是 async，emit 可能在 command 之后。缓解：scan 用 `tauri::async_runtime::spawn`，emit 用 AppHandle clone。手测时验证「改 tool.json → 侧边栏自动更新」。
- **State 锁竞争**：updater/watcher 的 Mutex 在 emit 时持锁可能导致死锁（emit 回调重入）。缓解：emit 前 clone 数据出锁。
- **rfd 对话框在 Tauri**：rfd 是独立 crate，不依赖 Tauri 窗口；但它的 parent 关联需手测（对话框是否在主窗口前）。
- **chrono/opener 依赖**：加依赖增加编译时间（几分钟），但功能必需。
