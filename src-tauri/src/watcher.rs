//! 对偶 src/main/toolManager.ts。notify 监听 toolsDir，变化触发 scan + emit。
//! auto-refresh tick（30s）检查 mdUrl 工具是否到期。watcher_state 由 lib.rs
//! 创建并 manage，start_watcher 接收 clone（避免返回时序问题）。

use crate::tools::scan_tools;
use crate::types::*;
use notify::{EventKind, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct WatcherState {
    pub last_tools: Vec<Tool>,
    pub last_fetched: std::collections::HashMap<String, Instant>,
}

impl Default for WatcherState {
    fn default() -> Self {
        WatcherState {
            last_tools: vec![],
            last_fetched: std::collections::HashMap::new(),
        }
    }
}

/// 启动 watcher。state 由调用方（lib.rs）创建并 manage，这里接收 clone。
/// 初始 scan 后立即广播一次（让 renderer 启动即有数据），之后 notify 变化触发。
pub fn start_watcher(handle: AppHandle, tools_dir: PathBuf, state: Arc<Mutex<WatcherState>>) {
    // 初始 scan + 广播（同步阻塞，确保 manage 后 renderer 首次 list 有数据）
    {
        let h = handle.clone();
        let td = tools_dir.clone();
        let st = state.clone();
        tauri::async_runtime::spawn(async move {
            refresh(&h, &td, &st).await;
        });
    }

    // notify 监听（debounce，对齐 chokidar awaitWriteFinish ~150-200ms）
    let h1 = handle.clone();
    let td1 = tools_dir.clone();
    let st1 = state.clone();
    std::thread::spawn(move || {
        // notify 6.x: recommended_watcher 接单个回调（返回 Result<Event>）。
        // 用 mpsc channel 把事件转出到循环处理。
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("watcher init failed: {}", e);
                return;
            }
        };
        if let Err(e) = watcher.watch(&td1, RecursiveMode::Recursive) {
            eprintln!("watcher.watch failed: {}", e);
            return;
        }
        let mut last_fire: Option<Instant> = None;
        while let Ok(res) = rx.recv() {
            let ev = match res {
                Ok(e) => e,
                Err(_) => continue,
            };
            match ev.kind {
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
                _ => continue,
            }
            let now = Instant::now();
            // debounce: 自上次触发 < 200ms 则跳过
            if last_fire
                .map(|t| now.duration_since(t) < Duration::from_millis(200))
                .unwrap_or(false)
            {
                continue;
            }
            last_fire = Some(now);
            let h = h1.clone();
            let td = td1.clone();
            let st = st1.clone();
            // 再等 150ms 让连续写入稳定，然后 scan
            std::thread::sleep(Duration::from_millis(150));
            tauri::async_runtime::spawn(async move {
                refresh(&h, &td, &st).await;
            });
        }
    });

    // auto-refresh tick（30s）：有 mdUrl 工具的 autoUpdateMinutes 到期则重扫
    let h2 = handle;
    let td2 = tools_dir;
    let st2 = state;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if maybe_auto_refresh(&h2, &td2, &st2).await {
                refresh(&h2, &td2, &st2).await;
            }
        }
    });
}

/// 扫描 + 广播 + 同步 lastTools/lastFetched。返回 ScanResult。
async fn refresh(handle: &AppHandle, tools_dir: &std::path::Path, state: &Arc<Mutex<WatcherState>>) -> ScanResult {
    let r = scan_tools(tools_dir).await;
    {
        // 中毒锁恢复：若其它线程 panic 导致 Mutex 中毒，取出数据继续而非传播 panic，
        // 避免一处 panic 永久瘫痪整个工具刷新子系统（对齐 commands.rs 的 lock_or_recover）。
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
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

/// 检查是否有 mdUrl 工具的 autoUpdateMinutes 到期。返回是否该重扫。
async fn maybe_auto_refresh(_handle: &AppHandle, _tools_dir: &std::path::Path, state: &Arc<Mutex<WatcherState>>) -> bool {
    let now = Instant::now();
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    let mut due = false;
    for t in &s.last_tools {
        if t.meta.md_url.is_none() {
            continue;
        }
        let mins = t.meta.auto_update_minutes.unwrap_or(0);
        if mins <= 0 {
            continue;
        }
        if let Some(last) = s.last_fetched.get(&t.meta.id) {
            if now.duration_since(*last) >= Duration::from_secs(mins as u64 * 60) {
                due = true;
            }
        }
    }
    due
}
