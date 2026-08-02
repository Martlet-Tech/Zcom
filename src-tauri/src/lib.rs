mod serial_cmd;
mod checksum;
mod state;
mod receive_buffer;
mod mcp_server;
mod window_helper;
mod encoding_utils;
mod multi_string;

use state::SerialState;
use receive_buffer::ReceiveBuffer;
use mcp_server::McpServerHandle;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[tauri::command]
fn open_devtools(webview: tauri::Webview) {
    webview.open_devtools();
}

#[tauri::command]
fn set_window_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("Window not found".to_string())?
        .set_title(&title)
        .map_err(|e| e.to_string())
}

fn tray_labels(lang: &str) -> (&'static str, &'static str) {
    if lang.starts_with("en") {
        ("Show Main Window", "Quit")
    } else {
        ("显示主窗口", "退出")
    }
}

fn rebuild_tray_menu(app: &tauri::AppHandle) -> Result<(), String> {
    let locale = app.state::<state::LocaleState>();
    let lang = locale.0.lock().map_err(|e| e.to_string())?;
    let (show_text, quit_text) = tray_labels(&lang);
    let show_item = MenuItemBuilder::with_id("show", show_text)
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", quit_text)
        .build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&quit_item)
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_tray_menu_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let locale = app.state::<state::LocaleState>();
    let mut current = locale.0.lock().map_err(|e| e.to_string())?;
    *current = lang;
    drop(current);
    rebuild_tray_menu(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(SerialState::new())
        .manage(ReceiveBuffer::new())
        .manage(McpServerHandle::new())
        .manage(state::LocaleState::default())
        .invoke_handler(tauri::generate_handler![
            serial_cmd::list_ports,
            serial_cmd::open_port,
            serial_cmd::close_port,
            serial_cmd::send_data,
            serial_cmd::send_data_raw,
            serial_cmd::send_raw_bytes,
            serial_cmd::reset_io_counters,
            serial_cmd::get_port_info,
            serial_cmd::calculate_checksum,
            serial_cmd::set_baud_rate,
            multi_string::open_multi_string_window,
            multi_string::load_multi_strings,
            multi_string::save_multi_strings,
            encoding_utils::decode_bytes,
            mcp_server::mcp_start,
            mcp_server::mcp_stop,
            mcp_server::mcp_get_status,
            receive_buffer::mcp_push_lines,
            receive_buffer::mcp_clear_buffer,
            open_devtools,
            set_window_title,
            set_tray_menu_language,
        ])
        .setup(|app| {
            let show_item = MenuItemBuilder::with_id("show", "显示主窗口")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出")
                .build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .item(&quit_item)
                .build()?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            w.show().ok();
                            w.set_focus().ok();
                        }
                    }
                })
                .build(app)?;

            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
