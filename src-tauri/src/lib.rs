mod serial_cmd;
mod checksum;
mod state;
mod mcp_buffer;
mod mcp_server;

use state::SerialState;
use mcp_buffer::McpBuffer;
use mcp_server::McpServerHandle;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[tauri::command]
fn open_devtools(webview: tauri::Webview) {
    webview.open_devtools();
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
        .manage(McpBuffer::new())
        .manage(McpServerHandle::new())
        .invoke_handler(tauri::generate_handler![
            serial_cmd::list_ports,
            serial_cmd::open_port,
            serial_cmd::close_port,
            serial_cmd::send_data,
            serial_cmd::send_data_raw,
            serial_cmd::send_raw_bytes,
            serial_cmd::get_port_info,
            serial_cmd::calculate_checksum,
            serial_cmd::open_multi_string_window,
            serial_cmd::load_multi_strings,
            serial_cmd::save_multi_strings,
            serial_cmd::decode_bytes,
            serial_cmd::set_baud_rate,
            mcp_server::mcp_start,
            mcp_server::mcp_stop,
            mcp_server::mcp_get_status,
            mcp_buffer::mcp_push_lines,
            mcp_buffer::mcp_clear_buffer,
            open_devtools,
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
