//! 对偶 src/main/menu.ts。原生 macOS 菜单。
//! 第一项 label = "TermStep"（macOS 菜单栏粗体 app 名）。结构：TermStep / 编辑 / 视图 / 窗口。

use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

pub fn set_app_menu(handle: &AppHandle) -> tauri::Result<()> {
    let name = "TermStep";

    // TermStep 菜单（第一项 = 菜单栏粗体 app 名）
    let app_menu = Submenu::with_items(
        handle,
        name,
        true,
        &[
            &PredefinedMenuItem::about(
                handle,
                Some(&format!("关于 {}", name)),
                Some(
                    AboutMetadataBuilder::new()
                        .name(Some(name))
                        .version(Some(env!("CARGO_PKG_VERSION")))
                        .build(),
                ),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, Some(&format!("隐藏 {}", name)))?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, Some(&format!("退出 {}", name)))?,
        ],
    )?;

    // 编辑菜单
    let edit_menu = Submenu::with_items(
        handle,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some("撤销"))?,
            &PredefinedMenuItem::redo(handle, Some("重做"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some("剪切"))?,
            &PredefinedMenuItem::copy(handle, Some("复制"))?,
            &PredefinedMenuItem::paste(handle, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(handle, Some("全选"))?,
        ],
    )?;

    // 视图菜单：「检查更新…」（自定义 id）+ 全屏（自定义，PredefinedMenuItem 无 togglefullscreen）
    let check_update_item =
        MenuItem::with_id(handle, "check_update", "检查更新…", true, None::<&str>)?;
    let fullscreen_item =
        MenuItem::with_id(handle, "toggle_fullscreen", "全屏", true, None::<&str>)?;
    let view_menu = Submenu::with_items(
        handle,
        "视图",
        true,
        &[
            &check_update_item,
            &PredefinedMenuItem::separator(handle)?,
            &fullscreen_item,
        ],
    )?;

    // 窗口菜单
    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, Some("最小化"))?,
            // macOS 的 "缩放"（zoom）—— PredefinedMenuItem 无直接对应，用自定义 item
            &MenuItem::with_id(handle, "zoom", "缩放", true, None::<&str>)?,
            &PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?,
        ],
    )?;

    let menu = Menu::with_items(handle, &[&app_menu, &edit_menu, &view_menu, &window_menu])?;
    handle.set_menu(menu)?;
    Ok(())
}
