use crate::window_helper;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize)]
pub struct MultiStringItem {
    pub text: String,
    pub delay: u32,
    pub hex: bool,
    #[serde(default)]
    pub name: String,
}

fn multi_strings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".zcom");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .zcom dir: {}", e))?;
    Ok(dir.join("multi-strings.json"))
}

#[tauri::command]
pub async fn load_multi_strings(app: tauri::AppHandle) -> Result<Vec<MultiStringItem>, String> {
    let path = multi_strings_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read multi-strings.json: {}", e))?;
    let items: Vec<MultiStringItem> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse multi-strings.json: {}", e))?;
    Ok(items)
}

#[tauri::command]
pub async fn save_multi_strings(app: tauri::AppHandle, items: Vec<MultiStringItem>) -> Result<(), String> {
    let path = multi_strings_path(&app)?;
    let content = serde_json::to_string_pretty(&items)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write multi-strings.json: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn open_multi_string_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("multi-string") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        window_helper::create_window(&app, window_helper::WindowConfig {
            label: "multi-string",
            path: "multi.html",
            title: "多字符串发送",
            width: 520.0,
            height: 560.0,
            min_width: 400.0,
            min_height: 400.0,
            resizable: true,
            decorations: false,
            center: true,
        })?;
    }
    Ok(())
}
