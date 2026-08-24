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
mod vcs;
mod watcher;

use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 用户数据根：~/.config/TermStep（XDG 风格，macOS 上也固定此路径）。
            // 用 dirs::home_dir 拼接而非 app.path().config_dir()——后者在 macOS
            // 返回 ~/Library/Application Support，与目标不符。
            // 历史：Electron→Tauri 时代曾用 ~/Library/Application Support/TermStep
            // （当时刻意与 Electron userData 一致求零迁移），该目录混入了 Chromium
            // 运行时残留，现启动时自动搬迁到新根并清理（migrate_legacy_root）。
            let user_data_dir = dirs::home_dir()
                .expect("no home dir")
                .join(".config")
                .join("TermStep");
            // 迁移时序（全部同步、幂等，在任何 scan/seed/pty 之前）：
            // 0) 根搬迁：旧根（~/Library/Application Support/TermStep，派生方式与
            //    老代码一致）的自有数据 → 新根；搬空后清理旧根。必须最先执行，
            //    后续所有迁移作用于新根。
            let legacy_root = app
                .path()
                .config_dir()
                .expect("no config_dir")
                .join("TermStep");
            let _ = tool_io::migrate_legacy_root_blocking(&legacy_root, &user_data_dir);
            // 1) 再把旧布局（tools/ + quick-commands.md 直接在 user_data_dir 下）
            //    搬到 configs/ 子目录（configs 成为 git 仓库根）。
            let _ = tool_io::migrate_to_configs_blocking(&user_data_dir);
            let configs_dir = user_data_dir.join("configs");
            // 2) tools_dir 现在指向 configs/tools——下游所有消费者（scan/watcher/
            //    commands/seed/旧迁移）都把它当不透明 &Path，自动跟随。
            let tools_dir = configs_dir.join("tools");
            let state_file = user_data_dir.join("update-state.json");
            std::fs::create_dir_all(&tools_dir).ok();
            let app_version = app.package_info().version.to_string();

            // seed 默认 git 工具（仅当 toolsDir 空）—— 对偶 seed.ts
            {
                // 再迁移旧 slug 目录名 → UUID，把旧 per-tool order 字段迁到 order.json
                // 索引（同步，在任何 scan/seed/pty 之前）。顺序：UUID 先、order 后
                // （索引存的是迁移后的 UUID 目录名）。
                let _ = tool_io::migrate_to_uuid_ids_blocking(&tools_dir);
                let _ = tool_io::migrate_order_to_index_blocking(&tools_dir);
                // 给存量工具补 sourceId（跨导入去重的稳定匹配键）。只动 tool.json
                // 内容，放最后，UUID/order 迁移之后。
                let _ = tool_io::migrate_add_source_id_blocking(&tools_dir);
                // 把旧 type 字段迁到 layout + terminalHidden（统一布局系统）。
                // 放最后：依赖前面迁移把 tool.json 整理干净后再做字段转换。
                let _ = tool_io::migrate_layout_fields_blocking(&tools_dir);
                let td = tools_dir.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(mut entries) = tokio::fs::read_dir(&td).await {
                        if entries.next_entry().await.ok().flatten().is_none() {
                            let _ = seed::seed_default_tool(&td).await;
                        }
                    }
                });
            }

            // git 版本控制初始化（降级安全）：检测不到 git 则跳过，应用其余功能不受影响。
            let vcs_available = vcs::git_available();
            if vcs_available {
                if let Err(e) = vcs::ensure_repo(&configs_dir) {
                    eprintln!("vcs ensure_repo failed: {}", e);
                }
            }

            // 共享状态（各 command 用 State<'_, T> 取）。
            // tools_dir / configs_dir / state_file 各装一个 Mutex<PathBuf>；
            // updater 与 watcher 装各自的 Arc<Mutex<...>>。
            let watcher_state = Arc::new(Mutex::new(watcher::WatcherState::default()));
            let updater_state = Arc::new(Mutex::new(updater::UpdaterState::default()));

            app.manage(commands::ToolsDir(Mutex::new(tools_dir.clone())));
            app.manage(commands::ConfigsDir(Mutex::new(configs_dir.clone())));
            app.manage(commands::VcsState {
                available: vcs_available,
            });
            app.manage(commands::UpdateStateFile(Mutex::new(state_file.clone())));
            app.manage(updater_state.clone());

            // 导入预检缓存（两阶段导入：dry_run 预检 → 确认 → commit 落盘）。
            app.manage(std::sync::Arc::new(std::sync::Mutex::new(None))
                as commands::ImportPreviewArc);

            // PTY 服务池（Arc<Mutex<PtyService>>，读线程通过 try_state 取它做
            // generation guard）。
            let pty_service = Arc::new(Mutex::new(pty::PtyService::new()));
            app.manage(pty_service.clone());

            // 启动 watcher（初始 scan + emit tools:changed + notify + auto-tick）。
            // watcher_state 用同一 Arc 让 refresh_md command 也能访问 lastTools。
            app.manage(watcher_state.clone());
            watcher::start_watcher(app.handle().clone(), tools_dir.clone(), watcher_state);

            // auto-update check（启动 5s 后静默，沿用现有延迟）。
            // 复用 manage 的 updater_state（与 manual check / command 共享 checking 标志
            // 和 notified_version，防重入正确）。
            {
                let h = app.handle().clone();
                let av = app_version.clone();
                let sf = state_file.clone();
                let ust = updater_state.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let _ = updater::check_for_updates(h, ust, av, sf, false).await;
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
            commands::tool_append_md,
            commands::tool_create,
            commands::tool_delete,
            commands::tool_reorder,
            commands::tool_move,
            commands::fetch_md_preview,
            commands::pick_md_file,
            commands::tools_export,
            commands::export_one,
            commands::tools_import,
            commands::quick_get,
            commands::quick_save,
            commands::vcs_log,
            commands::vcs_diff,
            commands::vcs_log_tool,
            commands::vcs_diff_tool,
            commands::open_external,
            commands::clipboard_read,
            commands::clipboard_write,
            commands::update_check,
            commands::pty_write,
            commands::pty_open,
            commands::pty_restart,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_probe,
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
                // state_file 从 manage 的 UpdateStateFile 取（不能用 app_data_dir——
                // 那会按 identifier 派生出 .../local.termstep，而非
                // ~/.config/TermStep 数据根）。
                let sf = app
                    .state::<commands::UpdateStateFile>()
                    .inner()
                    .0
                    .lock()
                    .unwrap()
                    .clone();
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

