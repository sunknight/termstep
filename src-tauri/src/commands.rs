//! 所有 #[tauri::command]，薄封装调各模块。参数从前端 camelCase 传入。
//! 共享状态（tools_dir/user_data_dir 等）由 lib.rs setup 用 app.manage 注入，
//! 这里用 State<'_, T> 获取。

use crate::tool_io;
use crate::tools;
use crate::updater;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// 校验前端传入的 tool_id，防止路径穿越（`..`、`/`、`\`、NUL 等）。
/// 合法的 tool_id 是工具目录名：由 slugify 产生的 `[a-z0-9-]` 子集。
/// 返回 Err 时携带可向用户展示的错误信息。
fn validate_tool_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        return Err("非法工具标识".into());
    }
    Ok(())
}

/// 容错地获取 Mutex 锁：跳过中毒锁（panic 后遗留），避免一处 panic 永久瘫痪整个子系统。
/// 中毒意味着数据可能不一致，但比起让整个 PTY/watcher 子系统永久不可用，继续运行更可取。
macro_rules! lock_or_recover {
    ($m:expr) => {
        match $m.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(), // 中毒锁：取出数据继续
        }
    };
}

// 共享状态容器。每个 PathBuf 用途必须是**不同的类型**——Tauri State 按类型查找，
// 三个 Mutex<PathBuf> 会冲突（只保留最后一个）。所以用 newtype 包装区分。
// Arc<Mutex<T>> 的状态（updater/watcher/pty）本身类型不同，无需包装。
#[derive(Default)]
pub struct ToolsDir(pub Mutex<PathBuf>);
#[derive(Default)]
pub struct ConfigsDir(pub Mutex<PathBuf>);
/// git 是否可用（启动时探测一次，只读）。
pub struct VcsState {
    pub available: bool,
}
#[derive(Default)]
pub struct UpdateStateFile(pub Mutex<PathBuf>);
type UpdaterArc = Arc<Mutex<crate::updater::UpdaterState>>;
type WatcherArc = Arc<Mutex<crate::watcher::WatcherState>>;
type PtyArc = Arc<Mutex<crate::pty::PtyService>>;

/// 导入预检缓存：dry_run 阶段解析的 bundle 存这里，commit 阶段取出落盘。
/// 避免让 bundle 内容在前后端间来回传递（纯本地数据，但仍减少面）。
/// 单槽：只缓存最近一次预检，新的预检覆盖旧的。
pub type ImportPreviewArc = Arc<Mutex<Option<crate::pure::ParseResult>>>;


// ── tools ───────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn tools_list(tools_dir: State<'_, ToolsDir>) -> Result<crate::types::ScanResult, String> {
    let td = lock_or_recover!(&tools_dir.0).clone();
    Ok(tools::scan_tools(&td).await)
}

#[tauri::command]
pub async fn refresh_md(
    handle: AppHandle,
    watcher_state: State<'_, WatcherArc>,
    tools_dir: State<'_, ToolsDir>,
) -> Result<(), String> {
    let td = lock_or_recover!(&tools_dir.0).clone();
    let r = tools::scan_tools(&td).await;
    {
        let mut s = lock_or_recover!(&watcher_state);
        s.last_tools = r.tools.clone();
    }
    let _ = handle.emit("tools:changed", &r);
    Ok(())
}

// ── tool CRUD ───────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn tool_save(
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    tool_id: String,
    markdown: String,
    meta_patch: serde_json::Value,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    tool_io::tool_save(&td.join(&tool_id), &markdown, meta_patch.clone())
        .await
        .map_err(|e| e.to_string())?;
    // 分组登记：若 patch 带了 group 字段（非空），把它登记到 order.json 的 groups
    // 索引（展示顺序）。失败只 eprintln! 不阻断——保存是首要功能，分组索引是附加。
    if let Some(g) = meta_patch.get("group").and_then(|v| v.as_str()) {
        if let Err(e) = tool_io::append_group_if_new(&td, Some(g)).await {
            eprintln!("tool_save: append_group_if_new failed: {}", e);
        }
    }
    // 自动提交：工具名取 meta_patch.name，缺省用 id。
    let name = meta_patch
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tool_id.clone());
    let cd = lock_or_recover!(&configs_dir.0).clone();
    try_auto_commit(&vcs_state, &cd, &tool_pathspec(&tool_id), &format!("保存工具 {}", name));
    Ok(())
}

#[tauri::command]
pub async fn tool_append_md(
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    tool_id: String,
    body: String,
) -> Result<bool, String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    let wrote = tool_io::tool_append_md(&td.join(&tool_id), &body)
        .await
        .map_err(|e| e.to_string())?;
    // 仅在实际写入（非空、非重复）时提交
    if wrote {
        let cd = lock_or_recover!(&configs_dir.0).clone();
        try_auto_commit(&vcs_state, &cd, &tool_pathspec(&tool_id), &format!("追加命令到 {}", tool_id));
    }
    Ok(wrote)
}

#[tauri::command]
pub async fn tool_create(
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    name: String,
) -> Result<String, String> {
    let td = lock_or_recover!(&tools_dir.0).clone();
    let id = tool_io::tool_create(&td, &name)
        .await
        .map_err(|e| e.to_string())?;
    let cd = lock_or_recover!(&configs_dir.0).clone();
    try_auto_commit(&vcs_state, &cd, &tool_pathspec(&id), &format!("新建工具 {}", name));
    Ok(id)
}

#[tauri::command]
pub async fn tool_delete(
    handle: AppHandle,
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    watcher_state: State<'_, WatcherArc>,
    tool_id: String,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    // 删除前从 watcher 缓存取工具名（删除后取不到）
    let tool_name = {
        let s = lock_or_recover!(watcher_state);
        s.last_tools
            .iter()
            .find(|t| t.meta.id == tool_id)
            .map(|t| t.meta.name.clone())
            .unwrap_or_else(|| tool_id.clone())
    };
    // pty kill 留到阶段 3（现在 stub）
    tool_io::tool_delete(&td, &tool_id)
        .await
        .map_err(|e| e.to_string())?;
    // 从排序索引移除该 id（保持索引干净；失败不阻断删除）
    let mut idx = tool_io::read_order_index(&td);
    let before_len = idx.order.len();
    idx.order.retain(|x| x != &tool_id);
    let order_changed = before_len != idx.order.len();
    if order_changed {
        let _ = tool_io::write_order_index(&td, &idx.order).await;
    }
    // 立即生效：从 watcher 缓存剔除该工具并 emit，不等全量重扫（同 reorder）。
    {
        let mut s = lock_or_recover!(watcher_state);
        s.last_tools.retain(|t| t.meta.id != tool_id);
        let _ = handle.emit("tools:changed", &crate::types::ScanResult {
            tools: s.last_tools.clone(),
            errors: vec![],
            groups: tool_io::read_groups(&td),
        });
    }
    // 自动提交：分别记录删除目录和排序更新（各自独立提交，消息清晰）。
    let cd = lock_or_recover!(&configs_dir.0).clone();
    let msg = format!("删除工具 {}", tool_name);
    try_auto_commit(&vcs_state, &cd, &tool_pathspec(&tool_id), &msg);
    if order_changed {
        try_auto_commit(&vcs_state, &cd, "tools/order.json", &format!("{}：更新排序", msg));
    }
    Ok(())
}

#[tauri::command]
pub async fn tool_reorder(
    handle: AppHandle,
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    watcher_state: State<'_, WatcherArc>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    for id in &ordered_ids {
        validate_tool_id(id)?;
    }
    let td = lock_or_recover!(&tools_dir.0).clone();
    tool_io::tool_reorder(&td, &ordered_ids)
        .await
        .map_err(|e| e.to_string())?;
    // 立即生效：从 watcher 缓存取当前工具，按新顺序原地重排并 emit，
    // 不等 watcher 的全量重扫（那次会重抓所有 mdUrl 的远程 md → 几秒延迟）。
    // watcher 仍会因 order.json 变化触发一次后台 scan，但前端早已拿到新顺序；
    // 后台 scan 到达时顺序一致，只是刷新了远程 md 内容，无可见回退。
    emit_reordered(&handle, &watcher_state, &td, &ordered_ids);
    // 自动提交：排序变更只动 order.json。
    let cd = lock_or_recover!(&configs_dir.0).clone();
    try_auto_commit(&vcs_state, &cd, "tools/order.json", "重排工具顺序");
    Ok(())
}

/// 把 watcher 缓存的工具按 ordered_ids 重排（重算各 meta.order）并立即 emit。
/// 不读盘、不抓远程——纯内存重排，前端零延迟收到新顺序。
fn emit_reordered(
    handle: &AppHandle,
    watcher_state: &State<'_, WatcherArc>,
    tools_dir: &std::path::Path,
    ordered_ids: &[String],
) {
    let mut tools = {
        let s = lock_or_recover!(watcher_state);
        s.last_tools.clone()
    };
    if tools.is_empty() {
        return;
    }
    // 用 ordered_ids 的位置建立 id→order 映射，重算每个工具的 order。
    let pos: std::collections::HashMap<&String, i64> = ordered_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id, i as i64))
        .collect();
    for t in tools.iter_mut() {
        t.meta.order = pos.get(&t.meta.id).copied().unwrap_or(i64::MAX);
    }
    // 稳定排序：按 order，再按 id（与 scan_tools 的兜底一致）。
    tools.sort_by(|a, b| {
        a.meta
            .order
            .cmp(&b.meta.order)
            .then_with(|| a.meta.id.cmp(&b.meta.id))
    });
    // 同步更新缓存，避免下一次后台 scan 到达前其它读 last_tools 的路径返回旧顺序。
    {
        let mut s = lock_or_recover!(watcher_state);
        s.last_tools = tools.clone();
    }
    let result = crate::types::ScanResult {
        tools,
        errors: vec![],
        groups: tool_io::read_groups(tools_dir),
    };
    let _ = handle.emit("tools:changed", &result);
}

/// 移动工具到另一分组并调整排序。同时更新 tool.json 的 group 字段与
/// order.json 的位置，前端零延迟收到新分组/新顺序。
#[tauri::command]
pub async fn tool_move(
    handle: AppHandle,
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    watcher_state: State<'_, WatcherArc>,
    tool_id: String,
    target_group: Option<String>,
    before_id: Option<String>,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    if let Some(ref bid) = before_id {
        validate_tool_id(bid)?;
    }
    let td = lock_or_recover!(&tools_dir.0).clone();
    tool_io::tool_move(&td, &tool_id, target_group.as_deref(), before_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    // 立即生效：更新缓存里的 group 并按最新 order 重排 emit。
    emit_moved(&handle, &watcher_state, &td, &tool_id, target_group.as_deref());
    // 自动提交：工具分组变更只动该工具目录与 order.json。
    let cd = lock_or_recover!(&configs_dir.0).clone();
    let group_display = target_group.as_deref().unwrap_or("未分组");
    try_auto_commit(
        &vcs_state,
        &cd,
        &tool_pathspec(&tool_id),
        &format!("移动工具 {} 到分组 {}", tool_id, group_display),
    );
    try_auto_commit(&vcs_state, &cd, "tools/order.json", "调整工具顺序");
    Ok(())
}

fn emit_moved(
    handle: &AppHandle,
    watcher_state: &State<'_, WatcherArc>,
    tools_dir: &std::path::Path,
    tool_id: &str,
    group_name: Option<&str>,
) {
    let mut tools = {
        let s = lock_or_recover!(watcher_state);
        s.last_tools.clone()
    };
    if let Some(t) = tools.iter_mut().find(|t| t.meta.id == tool_id) {
        t.meta.group = group_name.map(|s| s.to_string());
    }
    let idx = tool_io::read_order_index(tools_dir);
    emit_reordered(handle, watcher_state, tools_dir, &idx.order);
}

// ── md ──────────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn fetch_md_preview(url: String) -> Result<serde_json::Value, String> {
    if url.trim().is_empty() {
        return Ok(serde_json::json!({"markdown": "", "error": "URL 为空"}));
    }
    let r = tools::fetch_remote_markdown(url.trim()).await;
    Ok(serde_json::json!({"markdown": r.markdown, "error": r.error}))
}

#[tauri::command]
pub async fn pick_md_file() -> Result<serde_json::Value, String> {
    let res = rfd::AsyncFileDialog::new()
        .set_title("选择 Markdown 文件")
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .add_filter("所有文件", &["*"])
        .pick_file()
        .await;
    match res {
        Some(f) => Ok(serde_json::json!({"canceled": false, "path": f.path().to_string_lossy()})),
        None => Ok(serde_json::json!({"canceled": true})),
    }
}

// ── bundle ──────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn tools_export(tools_dir: State<'_, ToolsDir>) -> Result<serde_json::Value, String> {
    let td = lock_or_recover!(&tools_dir.0).clone();
    let scan = tools::scan_tools(&td).await;
    let bundle = crate::pure::serialize_tools(&scan.tools, &chrono::Utc::now().to_rfc3339());
    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let file = rfd::AsyncFileDialog::new()
        .set_title("导出工具")
        .set_file_name(format!("termstep-tools-{}.json", stamp))
        .add_filter("TermStep 工具包", &["json"])
        .save_file()
        .await;
    match file {
        Some(f) => {
            let path = f.path();
            let content = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
            tokio::fs::write(path, format!("{}\n", content))
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"canceled": false, "path": path.to_string_lossy(), "count": scan.tools.len()}))
        }
        None => Ok(serde_json::json!({"canceled": true})),
    }
}

#[tauri::command]
pub async fn export_one(
    tools_dir: State<'_, ToolsDir>,
    tool_id: String,
) -> Result<serde_json::Value, String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    let scan = tools::scan_tools(&td).await;
    let tool = scan
        .tools
        .into_iter()
        .find(|t| t.meta.id == tool_id)
        .ok_or("未找到该工具")?;
    let bundle = crate::pure::serialize_tools(&[tool.clone()], &chrono::Utc::now().to_rfc3339());
    // 文件名用工具的 UUID（目录名 = id），既唯一又与磁盘一一对应，避免 slug 重名。
    let file = rfd::AsyncFileDialog::new()
        .set_title("导出工具")
        .set_file_name(format!("termstep-{}.json", tool.meta.id))
        .add_filter("TermStep 工具包", &["json"])
        .save_file()
        .await;
    match file {
        Some(f) => {
            let path = f.path();
            let content = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
            tokio::fs::write(path, format!("{}\n", content))
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"canceled": false, "path": path.to_string_lossy(), "count": 1}))
        }
        None => Ok(serde_json::json!({"canceled": true})),
    }
}

#[tauri::command]
pub async fn tools_import(
    tools_dir: State<'_, ToolsDir>,
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    preview_state: State<'_, ImportPreviewArc>,
    dry_run: Option<bool>,
) -> Result<serde_json::Value, String> {
    let dry_run = dry_run.unwrap_or(false);

    // 落盘阶段：直接用预检缓存的解析结果，不重新选文件（用户已在预检时选过）。
    // 无缓存（前端直接 commit / 旧前端）→ 报错要求先预检。
    if !dry_run {
        let parsed = lock_or_recover!(preview_state)
            .take()
            .ok_or_else(|| "请先进行导入预检".to_string())?;
        let td = lock_or_recover!(&tools_dir.0).clone();
        let stats = write_imported_tools(&td, &parsed).await?;
        // 仅新建的工具追加到排序索引末尾（更新的保持原位）。
        if !stats.created.is_empty() {
            let mut idx = tool_io::read_order_index(&td);
            idx.order.extend(stats.created.iter().cloned());
            let _ = tool_io::write_order_index(&td, &idx.order).await;
        }
        // 自动提交：导入会写新工具目录 + 可能的 order.json + 被更新的工具，一个提交涵盖 tools/。
        if stats.total() > 0 {
            let cd = lock_or_recover!(&configs_dir.0).clone();
            let msg = format!(
                "导入 {} 个工具（新建 {}，更新 {}）",
                stats.total(),
                stats.created.len(),
                stats.updated
            );
            try_auto_commit(&vcs_state, &cd, "tools/", &msg);
        }
        return Ok(serde_json::json!({
            "canceled": false,
            "count": stats.total(),
            "created": stats.created.len(),
            "updated": stats.updated,
        }));
    }

    // 预检阶段：选文件 + 解析 + 扫描风险，返回摘要（不写盘）。
    let file = rfd::AsyncFileDialog::new()
        .set_title("导入工具")
        .add_filter("TermStep 工具包", &["json"])
        .pick_file()
        .await;
    let f = match file {
        Some(f) => f,
        None => return Ok(serde_json::json!({"canceled": true})),
    };
    let raw = tokio::fs::read_to_string(f.path())
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;
    let parsed = crate::pure::parse_tools_bundle(&raw);
    if let Some(err) = parsed.error {
        return Ok(serde_json::json!({"canceled": false, "count": 0, "error": err}));
    }
    let risks: Vec<crate::pure::ToolRiskSummary> =
        parsed.tools.iter().map(crate::pure::scan_tool_risk).collect();
    let has_risk = risks.iter().any(|r| !r.is_empty());
    // 缓存解析结果，供紧随其后的 commit 取用。
    *lock_or_recover!(preview_state) = Some(parsed);
    Ok(serde_json::json!({
        "canceled": false,
        "dryRun": true,
        "count": risks.len(),
        "hasRisk": has_risk,
        "risks": risks,
    }))
}

/// 导入统计：区分新建与更新（同一 bundle 多次导入时，按 sourceId 命中已有工具则
/// 更新而非重复新建）。`created` 是新建的目录 UUID 列表（需追加到 order.json）。
#[derive(Debug, Default)]
struct ImportStats {
    created: Vec<String>,
    updated: usize,
}

impl ImportStats {
    fn total(&self) -> usize {
        self.created.len() + self.updated
    }
}

/// 把已解析的 bundle 工具落盘到 tools_dir。**upsert 语义**：按 bundle 工具的
/// `sourceId` 匹配现有工具——命中则覆盖该目录（全量覆盖 tool.json + help.md），
/// 未命中才新建一个 UUID 目录。这样同一 bundle 多次导入不会重复生成工具。
///
/// 覆盖规则（全量覆盖）：
/// - tool.json：用 bundle 的 meta 序列化，剥掉 id（目录名）和 order（order.json）。
///   sourceId 确保落盘：bundle 无则新建时用目录 UUID，命中时保留现有的。
/// - help.md：直接用 bundle 内容覆盖。
/// 失败立即返回 Err（已写入的工具保留在磁盘）。
async fn write_imported_tools(
    tools_dir: &Path,
    parsed: &crate::pure::ParseResult,
) -> Result<ImportStats, String> {
    // 1. 扫现有工具，建 sourceId → 目录 UUID 映射（命中判定）。
    let existing = crate::tools::scan_tools(tools_dir).await;
    let mut by_source: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for t in &existing.tools {
        if let Some(sid) = &t.meta.source_id {
            by_source.insert(sid.clone(), t.meta.id.clone());
        }
    }

    let mut stats = ImportStats::default();
    for t in &parsed.tools {
        // 2. 决定目标目录：bundle 的 sourceId 命中现有 → 复用；否则新建。
        let (target_id, is_new) = match t.meta.source_id.as_ref().and_then(|sid| by_source.get(sid)) {
            Some(existing_id) => (existing_id.clone(), false),
            None => (tool_io::new_tool_id(), true),
        };
        let dir = tools_dir.join(&target_id);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

        // 3. tool.json：全量覆盖（bundle meta），剥掉 id/order，确保 sourceId 落盘。
        let mut meta_v = serde_json::to_value(&t.meta).map_err(|e| e.to_string())?;
        if let Some(o) = meta_v.as_object_mut() {
            o.remove("id"); // id 体现在目录名
            o.remove("order"); // 排序由 order.json 索引管理
            // bundle 无 sourceId 时兜底：新建→用目录UUID；命中→保留现有的。
            if o.get("sourceId").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_none() {
                let sid = if is_new {
                    target_id.clone()
                } else {
                    // 命中现有（by_source 命中说明现有有 sourceId），取回现有的。
                    existing
                        .tools
                        .iter()
                        .find(|e| e.meta.id == target_id)
                        .and_then(|e| e.meta.source_id.clone())
                        .unwrap_or_else(tool_io::new_source_id)
                };
                o.insert("sourceId".into(), serde_json::json!(sid));
            }
        }
        let pretty = serde_json::to_string_pretty(&meta_v).map_err(|e| e.to_string())?;
        tokio::fs::write(dir.join("tool.json"), format!("{}\n", pretty))
            .await
            .map_err(|e| e.to_string())?;
        // 4. help.md：全量覆盖。
        tokio::fs::write(dir.join("help.md"), &t.help_markdown)
            .await
            .map_err(|e| e.to_string())?;

        if is_new {
            stats.created.push(target_id);
        } else {
            stats.updated += 1;
        }
    }
    Ok(stats)
}

// ── quick ───────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn quick_get(configs_dir: State<'_, ConfigsDir>) -> Result<String, String> {
    let cd = lock_or_recover!(&configs_dir.0).clone();
    Ok(tool_io::quick_get(&cd).await)
}

#[tauri::command]
pub async fn quick_save(
    configs_dir: State<'_, ConfigsDir>,
    vcs_state: State<'_, VcsState>,
    md: String,
) -> Result<(), String> {
    let cd = lock_or_recover!(&configs_dir.0).clone();
    tool_io::quick_save(&cd, &md)
        .await
        .map_err(|e| e.to_string())?;
    try_auto_commit(&vcs_state, &cd, "quick-commands.md", "保存快捷命令");
    Ok(())
}

// ── 版本控制（git 配置记录）──────────────────────────────────────────────────
// 模型：每次保存且文件有变动时自动提交（仅提交变更路径）。无手动快照。
// 所有 vcs 命令先查 VcsState.available，git 不可用时降级返回（不报错弹窗）。
use crate::vcs;
use std::path::Path;

/// 自动提交钩子：git 可用时，仅暂存并提交指定路径。失败只告警，**绝不阻断写入**
/// （配置保存是首要功能，版本控制是附加价值）。
fn try_auto_commit(state: &VcsState, configs_dir: &Path, pathspec: &str, msg: &str) {
    if !state.available {
        return;
    }
    // 仓库未初始化时跳过（理论上 lib.rs 已 init，此处防御）
    if !configs_dir.join(".git").exists() {
        return;
    }
    if let Err(e) = vcs::snapshot_path(configs_dir, pathspec, msg) {
        eprintln!("vcs auto-commit failed ({}): {}", pathspec, e);
    }
}

/// 从 tool_id 派生 pathspec：tools/<id>/
fn tool_pathspec(tool_id: &str) -> String {
    format!("tools/{}/", tool_id)
}

/// 全局配置记录历史（整个 configs 仓库）。
#[tauri::command]
pub async fn vcs_log(
    state: State<'_, VcsState>,
    configs_dir: State<'_, ConfigsDir>,
    limit: Option<usize>,
) -> Result<Vec<vcs::CommitEntry>, String> {
    if !state.available {
        return Ok(vec![]);
    }
    let cd = lock_or_recover!(&configs_dir.0).clone();
    vcs::log_list(&cd, limit)
}

/// rev = "WORKING" → 工作区相对 HEAD 的未提交 diff；否则当作 commit hash。
#[tauri::command]
pub async fn vcs_diff(
    state: State<'_, VcsState>,
    configs_dir: State<'_, ConfigsDir>,
    rev: String,
) -> Result<crate::types::VcsDiff, String> {
    if !state.available {
        return Ok(crate::types::VcsDiff { diff: String::new() });
    }
    let cd = lock_or_recover!(&configs_dir.0).clone();
    let diff = if rev == "WORKING" {
        vcs::diff_working(&cd)?
    } else {
        vcs::diff_rev(&cd, &rev)?
    };
    Ok(crate::types::VcsDiff { diff })
}

/// 单工具的配置记录历史（仅触碰过 tools/<id>/ 的提交）。
#[tauri::command]
pub async fn vcs_log_tool(
    state: State<'_, VcsState>,
    configs_dir: State<'_, ConfigsDir>,
    tool_id: String,
    limit: Option<usize>,
) -> Result<Vec<vcs::CommitEntry>, String> {
    validate_tool_id(&tool_id)?;
    if !state.available {
        return Ok(vec![]);
    }
    let cd = lock_or_recover!(&configs_dir.0).clone();
    vcs::log_list_path(&cd, &tool_pathspec(&tool_id), limit)
}

/// 单工具的 diff（仅限 tools/<id>/）。
/// rev = "WORKING" → 该工具工作区相对 HEAD 的未提交变更；否则当 commit hash。
#[tauri::command]
pub async fn vcs_diff_tool(
    state: State<'_, VcsState>,
    configs_dir: State<'_, ConfigsDir>,
    tool_id: String,
    rev: String,
) -> Result<crate::types::VcsDiff, String> {
    validate_tool_id(&tool_id)?;
    if !state.available {
        return Ok(crate::types::VcsDiff { diff: String::new() });
    }
    let cd = lock_or_recover!(&configs_dir.0).clone();
    let pathspec = tool_pathspec(&tool_id);
    let diff = if rev == "WORKING" {
        vcs::diff_working_path(&cd, &pathspec)?
    } else {
        vcs::diff_rev_path(&cd, &rev, &pathspec)?
    };
    Ok(crate::types::VcsDiff { diff })
}

// ── shell / clipboard ───────────────────────────────────────────────────────
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        opener::open(&url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// arboard 直接读写系统剪贴板（Tauri v2 把 clipboard 移到了插件，arboard 更简单
// 且无需 capability 配置）。用于 copy-on-select、⌘C/⌘V、OSC 52。
#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

// ── update ──────────────────────────────────────────────────────────────────
// 复用 manage 的 UpdaterState（持久 checking/notified 跨调用）。
// 版本号不从前端传——直接从 package_info 取，前端 `invoke('update_check')` 即可，
// 与菜单「检查更新」走同一路径。
#[tauri::command]
pub async fn update_check(
    handle: AppHandle,
    state: State<'_, UpdaterArc>,
    state_file: State<'_, UpdateStateFile>,
) -> Result<crate::types::UpdateState, String> {
    let sf = lock_or_recover!(&state_file.0).clone();
    let app_version = handle.package_info().version.to_string();
    // State<'_, Arc<...>> 实现了 Deref 到 Arc，但 check_for_updates 需要_owned_ Arc；
    // clone 出来。
    let st = state.inner().clone();
    Ok(updater::check_for_updates(handle, st, app_version, sf, true).await)
}

// ── pty（portable-pty 池）───────────────────────────────────────────────────
// PtyArc 的类型用全限定路径 crate::pty::PtyService，无需 import。

#[tauri::command]
pub async fn pty_write(
    handle: AppHandle,
    pty: State<'_, PtyArc>,
    tool_id: String,
    data: String,
    opts: Option<crate::types::PtySpawnOpts>,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let opts = opts.unwrap_or_default();
    lock_or_recover!(pty.inner()).write(&handle, &tool_id, &data, &opts);
    Ok(())
}

#[tauri::command]
pub async fn pty_open(
    handle: AppHandle,
    pty: State<'_, PtyArc>,
    tool_id: String,
    opts: Option<crate::types::PtySpawnOpts>,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let opts = opts.unwrap_or_default();
    lock_or_recover!(pty.inner()).open(&handle, &tool_id, &opts);
    Ok(())
}

#[tauri::command]
pub async fn pty_restart(
    handle: AppHandle,
    pty: State<'_, PtyArc>,
    tool_id: String,
    opts: Option<crate::types::PtySpawnOpts>,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let opts = opts.unwrap_or_default();
    lock_or_recover!(pty.inner()).restart(&handle, &tool_id, &opts);
    Ok(())
}

/// 强制重启（⌘+点击「重启终端」触发）：清残留哨兵 + kill 旧 entry + 强制 spawn。
/// 用于普通 restart 失效时的逃生通道。详见 pty::PtyService::force_restart。
#[tauri::command]
pub async fn pty_force_restart(
    handle: AppHandle,
    pty: State<'_, PtyArc>,
    tool_id: String,
    opts: Option<crate::types::PtySpawnOpts>,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let opts = opts.unwrap_or_default();
    lock_or_recover!(pty.inner()).force_restart(&handle, &tool_id, &opts);
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    pty: State<'_, PtyArc>,
    tool_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    lock_or_recover!(pty.inner()).resize(&tool_id, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(pty: State<'_, PtyArc>, tool_id: String) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    lock_or_recover!(pty.inner()).kill(&tool_id);
    Ok(())
}

// 实时 cwd：先试 lsof 拿 shell 的 cwd；拿不到则回退到工具 meta 的 cwd 或 home。
#[tauri::command]
pub async fn pty_cwd(
    pty: State<'_, PtyArc>,
    tools_dir: State<'_, ToolsDir>,
    tool_id: String,
) -> Result<String, String> {
    validate_tool_id(&tool_id)?;
    let pid = lock_or_recover!(pty.inner()).pid_of(&tool_id);
    if let Some(cwd) = pid.and_then(crate::cwd::live_cwd) {
        return Ok(cwd.to_string_lossy().to_string());
    }
    // 回退：扫工具拿 meta.cwd，再不行 home
    let td = lock_or_recover!(&tools_dir.0).clone();
    let scan = crate::tools::scan_tools(&td).await;
    if let Some(t) = scan.tools.into_iter().find(|t| t.meta.id == tool_id) {
        if let Some(cwd) = t.meta.cwd {
            return Ok(crate::pty::expand_home(&cwd));
        }
    }
    Ok(dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| "~".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_id_accepts_normal_slug() {
        assert!(validate_tool_id("git").is_ok());
        assert!(validate_tool_id("my-tool-2").is_ok());
        assert!(validate_tool_id("工具").is_ok()); // 非 ASCII 字符允许（slugify 不影响目录名）
    }

    #[test]
    fn tool_id_rejects_traversal() {
        assert!(validate_tool_id("..").is_err());
        assert!(validate_tool_id("../").is_err());
        assert!(validate_tool_id("../..").is_err());
        assert!(validate_tool_id("a/../b").is_err());
        assert!(validate_tool_id("a/../../etc").is_err());
    }

    #[test]
    fn tool_id_rejects_separators() {
        assert!(validate_tool_id("a/b").is_err());
        assert!(validate_tool_id(r"a\b").is_err());
        assert!(validate_tool_id("a\0b").is_err());
    }

    #[test]
    fn tool_id_rejects_empty() {
        assert!(validate_tool_id("").is_err());
    }

    // ── write_imported_tools upsert 语义 ─────────────────────────────────────
    // 用 ParseResult + BundleTool 直接构造，绕过文件对话框。

    /// 构造一个带 sourceId 的 ParseResult（单工具）。
    fn bundle_with(source_id: Option<&str>, name: &str, help: &str) -> crate::pure::ParseResult {
        let mut meta_json = serde_json::json!({ "name": name, "icon": "★" });
        if let Some(sid) = source_id {
            meta_json["sourceId"] = serde_json::json!(sid);
        }
        let meta = crate::pure::parse_tool_meta(&meta_json, "bundle-id");
        crate::pure::ParseResult {
            tools: vec![crate::types::BundleTool {
                meta,
                help_markdown: help.into(),
            }],
            error: None,
        }
    }

    /// 在 tools_dir 下预置一个已有工具目录（含 tool.json + help.md）。
    async fn seed_tool(tools_dir: &Path, dir_id: &str, source_id: Option<&str>, name: &str) {
        let dir = tools_dir.join(dir_id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let mut json = serde_json::json!({ "name": name, "icon": "★" });
        if let Some(sid) = source_id {
            json["sourceId"] = serde_json::json!(sid);
        }
        let pretty = serde_json::to_string_pretty(&json).unwrap();
        tokio::fs::write(dir.join("tool.json"), format!("{}\n", pretty))
            .await
            .unwrap();
        tokio::fs::write(dir.join("help.md"), "# old\n").await.unwrap();
    }

    fn tmp() -> tempfile::TempDir {
        tempfile::TempDir::new().unwrap()
    }

    #[tokio::test]
    async fn import_creates_when_no_match() {
        let _d = tmp();
        let dir = _d.path();
        // 空 tools_dir + bundle（带 sourceId="src-1"）
        let parsed = bundle_with(Some("src-1"), "Git", "# Git");
        let stats = write_imported_tools(dir, &parsed).await.unwrap();
        assert_eq!(stats.created.len(), 1, "no match → create");
        assert_eq!(stats.updated, 0);
        assert_eq!(stats.total(), 1);
        // 工具目录被创建，help.md 与 tool.json 落盘
        let new_id = &stats.created[0];
        let help = tokio::fs::read_to_string(dir.join(new_id).join("help.md"))
            .await
            .unwrap();
        assert_eq!(help, "# Git");
        // bundle 自带 sourceId 时保留（这是匹配键，下次导入靠它命中）
        let json: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(dir.join(new_id).join("tool.json")).await.unwrap())
                .unwrap();
        assert_eq!(json["sourceId"], serde_json::json!("src-1"));
    }

    #[tokio::test]
    async fn import_updates_when_source_id_matches() {
        let _d = tmp();
        let dir = _d.path();
        // 预置一个已有工具，sourceId="src-1"，目录 UUID = "existing-uuid"
        seed_tool(dir, "existing-uuid", Some("src-1"), "OldName").await;
        // bundle 同 sourceId="src-1"，但 name/help 变了
        let parsed = bundle_with(Some("src-1"), "NewName", "# new help");
        let stats = write_imported_tools(dir, &parsed).await.unwrap();
        assert_eq!(stats.created.len(), 0, "match → no new dir");
        assert_eq!(stats.updated, 1);
        // 目录数不变（仍是 existing-uuid，未新建第二个）
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .collect();
        entries.sort();
        assert_eq!(entries, vec!["existing-uuid".to_string()]);
        // tool.json 的 name 被全量覆盖为 NewName
        let json: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(dir.join("existing-uuid").join("tool.json")).await.unwrap())
                .unwrap();
        assert_eq!(json["name"], "NewName");
        // help.md 被覆盖
        let help = tokio::fs::read_to_string(dir.join("existing-uuid").join("help.md"))
            .await
            .unwrap();
        assert_eq!(help, "# new help");
        // sourceId 保留为现有值 src-1
        assert_eq!(json["sourceId"], "src-1");
    }

    #[tokio::test]
    async fn import_mixed_create_and_update() {
        let _d = tmp();
        let dir = _d.path();
        // 预置 sourceId="src-1" 的工具
        seed_tool(dir, "existing-uuid", Some("src-1"), "OldName").await;
        // bundle 两工具：src-1（匹配）+ src-2（不匹配）
        let mut parsed = bundle_with(Some("src-1"), "NewName", "# a");
        parsed.tools.push(crate::types::BundleTool {
            meta: crate::pure::parse_tool_meta(
                &serde_json::json!({ "name": "B", "icon": "★", "sourceId": "src-2" }),
                "bundle-id-b",
            ),
            help_markdown: "# b".into(),
        });
        let stats = write_imported_tools(dir, &parsed).await.unwrap();
        assert_eq!(stats.created.len(), 1, "src-2 not found → create");
        assert_eq!(stats.updated, 1, "src-1 found → update");
        assert_eq!(stats.total(), 2);
    }

    #[tokio::test]
    async fn import_bundle_without_source_id_creates_and_assigns_one() {
        // bundle 工具无 sourceId（首次导入老 bundle）→ 新建，并兜底生成 sourceId。
        let _d = tmp();
        let dir = _d.path();
        let parsed = bundle_with(None, "Git", "# Git");
        let stats = write_imported_tools(dir, &parsed).await.unwrap();
        assert_eq!(stats.created.len(), 1);
        let new_id = &stats.created[0];
        let json: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(dir.join(new_id).join("tool.json")).await.unwrap())
                .unwrap();
        // 无 sourceId 时兜底用目录 UUID（非空、合法值）
        assert_eq!(json["sourceId"], serde_json::json!(new_id));
    }

    #[tokio::test]
    async fn import_same_bundle_twice_does_not_duplicate() {
        // 端到端回归：同一 bundle 导两次 → 第二次命中第一次建的（sourceId）→ 更新。
        let _d = tmp();
        let dir = _d.path();
        let parsed1 = bundle_with(Some("src-1"), "Git", "# v1");
        let stats1 = write_imported_tools(dir, &parsed1).await.unwrap();
        assert_eq!(stats1.created.len(), 1);
        let first_id = stats1.created[0].clone();

        // 第二次：同 sourceId="src-1"，help 变了
        let parsed2 = bundle_with(Some("src-1"), "Git", "# v2");
        let stats2 = write_imported_tools(dir, &parsed2).await.unwrap();
        assert_eq!(stats2.created.len(), 0, "second import must not create");
        assert_eq!(stats2.updated, 1, "second import must update");
        // 仍是同一个目录，help 被刷新
        let help = tokio::fs::read_to_string(dir.join(&first_id).join("help.md"))
            .await
            .unwrap();
        assert_eq!(help, "# v2");
        // 全局只有一个工具目录
        let count = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .count();
        assert_eq!(count, 1);
    }
}
