// Tauri v2 推荐 lib/bin 分离：lib 持有 app 构造逻辑（便于将来 #[cfg(test)] 单测），
// main.rs 只是薄入口。
mod commands;
mod cwd;
mod menu;
mod pty;
mod seed;
mod tmux;
mod tool_io;
mod tools;
mod types;
mod pure;
mod updater;
mod watcher;

use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 用户数据路径：~/Library/Application Support/TermStep
            // 故意用 productName（"TermStep"）而非 Tauri 默认的 identifier
            // （"local.termstep"）派生，以与 Electron 时代的 userData 路径完全
            // 一致——这样老用户的工具数据零丢失。app_data_dir() 会给出
            // .../local.termstep，是错的。
            let user_data_dir = app
                .path()
                .config_dir()
                .expect("no config_dir")
                .join("TermStep");
            let tools_dir = user_data_dir.join("tools");
            let state_file = user_data_dir.join("update-state.json");
            std::fs::create_dir_all(&tools_dir).ok();
            let app_version = app.package_info().version.to_string();

            // seed 默认 git 工具（仅当 toolsDir 空）—— 对偶 seed.ts
            {
                let td = tools_dir.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(mut entries) = tokio::fs::read_dir(&td).await {
                        if entries.next_entry().await.ok().flatten().is_none() {
                            let _ = seed::seed_default_tool(&td).await;
                        }
                    }
                });
            }

            // 共享状态（各 command 用 State<'_, T> 取）。
            // tools_dir / user_data_dir / state_file 各装一个 Mutex<PathBuf>；
            // updater 与 watcher 装各自的 Arc<Mutex<...>>。
            let watcher_state = Arc::new(Mutex::new(watcher::WatcherState::default()));
            let updater_state = Arc::new(Mutex::new(updater::UpdaterState::default()));

            app.manage(Mutex::new(tools_dir.clone()));
            app.manage(Mutex::new(user_data_dir.clone()));
            app.manage(Mutex::new(state_file.clone()));
            app.manage(updater_state.clone());

            // PTY 服务池（Arc<Mutex<PtyService>>，读线程通过 try_state 取它做
            // generation guard）。
            let pty_service = Arc::new(Mutex::new(pty::PtyService::new()));
            app.manage(pty_service.clone());

            // 启动 watcher（初始 scan + emit tools:changed + notify + auto-tick）。
            // watcher_state 用同一 Arc 让 refresh_md command 也能访问 lastTools。
            app.manage(watcher_state.clone());
            watcher::start_watcher(app.handle().clone(), tools_dir.clone(), watcher_state);

            // auto-update check（启动 5s 后静默，沿用现有延迟）
            {
                let h = app.handle().clone();
                let av = app_version.clone();
                let sf = state_file.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let st = Arc::new(Mutex::new(updater::UpdaterState::default()));
                    let _ = updater::check_for_updates(h, st, av, sf, false).await;
                });
            }

            // 窗口销毁时 kill 所有 pty（近似 Electron before-quit 的 killAll）。
            {
                let ps = pty_service.clone();
                let w = app.get_webview_window("main").expect("main window missing");
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        ps.lock().unwrap().kill_all();
                    }
                });
            }

            // 原生应用菜单（对偶 src/main/menu.ts）+ About 元数据。
            if let Err(e) = menu::set_app_menu(app.handle()) {
                eprintln!("menu setup failed: {}", e);
            }

            // dev：自动开 devtools
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::tools_list,
            commands::refresh_md,
            commands::tool_save,
            commands::tool_append_buttons,
            commands::tool_create,
            commands::tool_delete,
            commands::tool_reorder,
            commands::fetch_md_preview,
            commands::pick_md_file,
            commands::tools_export,
            commands::export_one,
            commands::tools_import,
            commands::quick_get,
            commands::quick_save,
            commands::open_external,
            commands::clipboard_read,
            commands::clipboard_write,
            commands::update_check,
            commands::pty_write,
            commands::pty_open,
            commands::pty_restart,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_cwd,
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "check_update" => {
                // 菜单「检查更新…」→ 手动检查（manual=true，错误暴露给 UI）
                let h = app.clone();
                let st = app
                    .state::<Arc<Mutex<updater::UpdaterState>>>()
                    .inner()
                    .clone();
                let av = app.package_info().version.to_string();
                let sf = app
                    .path()
                    .app_data_dir()
                    .expect("no app_data_dir")
                    .join("update-state.json");
                tauri::async_runtime::spawn(async move {
                    let _ = updater::check_for_updates(h, st, av, sf, true).await;
                });
            }
            "toggle_fullscreen" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
                }
            }
            "zoom" => {
                // macOS 窗口 zoom（绿色按钮行为）：Tauri 无直接 API，用 maximize 近似
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.maximize();
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

