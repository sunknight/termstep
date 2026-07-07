// Tauri v2 推荐 lib/bin 分离：lib 持有 app 构造逻辑（便于将来 #[cfg(test)] 单测），
// main.rs 只是薄入口。本阶段无 command、无 setup，只创建窗口加载前端。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
