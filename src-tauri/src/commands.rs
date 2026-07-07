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
pub struct UserDataDir(pub Mutex<PathBuf>);
#[derive(Default)]
pub struct UpdateStateFile(pub Mutex<PathBuf>);
type UpdaterArc = Arc<Mutex<crate::updater::UpdaterState>>;
type WatcherArc = Arc<Mutex<crate::watcher::WatcherState>>;
type PtyArc = Arc<Mutex<crate::pty::PtyService>>;

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
    tool_id: String,
    markdown: String,
    meta_patch: serde_json::Value,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    tool_io::tool_save(&td.join(&tool_id), &markdown, meta_patch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_append_buttons(
    tools_dir: State<'_, ToolsDir>,
    tool_id: String,
    body: String,
) -> Result<bool, String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    tool_io::tool_append_buttons(&td.join(&tool_id), &body)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_create(tools_dir: State<'_, ToolsDir>, name: String) -> Result<String, String> {
    let td = lock_or_recover!(&tools_dir.0).clone();
    tool_io::tool_create(&td, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tool_delete(
    handle: AppHandle,
    tools_dir: State<'_, ToolsDir>,
    watcher_state: State<'_, WatcherArc>,
    tool_id: String,
) -> Result<(), String> {
    validate_tool_id(&tool_id)?;
    let td = lock_or_recover!(&tools_dir.0).clone();
    // pty kill 留到阶段 3（现在 stub）
    tool_io::tool_delete(&td, &tool_id)
        .await
        .map_err(|e| e.to_string())?;
    // 从排序索引移除该 id（保持索引干净；失败不阻断删除）
    let mut order = tool_io::read_order_index(&td);
    let before_len = order.len();
    order.retain(|x| x != &tool_id);
    if order.len() != before_len {
        let _ = tool_io::write_order_index(&td, &order).await;
    }
    // 立即生效：从 watcher 缓存剔除该工具并 emit，不等全量重扫（同 reorder）。
    {
        let mut s = lock_or_recover!(watcher_state);
        s.last_tools.retain(|t| t.meta.id != tool_id);
        let _ = handle.emit("tools:changed", &crate::types::ScanResult {
            tools: s.last_tools.clone(),
            errors: vec![],
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn tool_reorder(
    handle: AppHandle,
    tools_dir: State<'_, ToolsDir>,
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
    emit_reordered(&handle, &watcher_state, &ordered_ids);
    Ok(())
}

/// 把 watcher 缓存的工具按 ordered_ids 重排（重算各 meta.order）并立即 emit。
/// 不读盘、不抓远程——纯内存重排，前端零延迟收到新顺序。
fn emit_reordered(
    handle: &AppHandle,
    watcher_state: &State<'_, WatcherArc>,
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
    };
    let _ = handle.emit("tools:changed", &result);
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
pub async fn tools_import(tools_dir: State<'_, ToolsDir>) -> Result<serde_json::Value, String> {
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
    let td = lock_or_recover!(&tools_dir.0).clone();
    let mut count = 0;
    let mut new_ids: Vec<String> = vec![];
    for t in parsed.tools {
        let id = tool_io::new_tool_id();
        let dir = td.join(&id);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let mut meta = serde_json::to_value(&t.meta).map_err(|e| e.to_string())?;
        if let Some(o) = meta.as_object_mut() {
            o.remove("id"); // id 在目录名，不存进 json
            o.remove("order"); // 排序由 order.json 索引管理，不存进各 tool.json
        }
        let pretty = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        tokio::fs::write(dir.join("tool.json"), format!("{}\n", pretty))
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(dir.join("help.md"), &t.help_markdown)
            .await
            .map_err(|e| e.to_string())?;
        new_ids.push(id);
        count += 1;
    }
    // 把导入的新 id 追加到排序索引末尾（新工具排最后，符合预期）
    if !new_ids.is_empty() {
        let mut order = tool_io::read_order_index(&td);
        order.extend(new_ids);
        let _ = tool_io::write_order_index(&td, &order).await;
    }
    Ok(serde_json::json!({"canceled": false, "count": count}))
}

// ── quick ───────────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn quick_get(user_data_dir: State<'_, UserDataDir>) -> Result<String, String> {
    let ud = lock_or_recover!(&user_data_dir.0).clone();
    Ok(tool_io::quick_get(&ud).await)
}

#[tauri::command]
pub async fn quick_save(
    user_data_dir: State<'_, UserDataDir>,
    md: String,
) -> Result<(), String> {
    let ud = lock_or_recover!(&user_data_dir.0).clone();
    tool_io::quick_save(&ud, &md)
        .await
        .map_err(|e| e.to_string())
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
    use super::validate_tool_id;

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
}
