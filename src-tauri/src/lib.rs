mod serial_cmd;
mod checksum;
mod state;

use state::SerialState;
use tauri::Manager;

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
            open_devtools,
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
