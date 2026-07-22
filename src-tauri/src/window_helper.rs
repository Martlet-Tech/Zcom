use std::path::PathBuf;
use tauri::{AppHandle, WebviewWindow, WebviewUrl};
use tauri::WebviewWindowBuilder;

pub struct WindowConfig<'a> {
    pub label: &'a str,
    pub path: &'a str,
    pub title: &'a str,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub resizable: bool,
    pub decorations: bool,
    pub center: bool,
}

pub fn create_window(app: &AppHandle, config: WindowConfig) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        config.label,
        WebviewUrl::App(PathBuf::from(config.path)),
    )
    .title(config.title)
    .inner_size(config.width, config.height)
    .min_inner_size(config.min_width, config.min_height)
    .resizable(config.resizable)
    .decorations(config.decorations)
    .visible(false);

    if config.center {
        builder = builder.center();
    }

    builder.build().map_err(|e| e.to_string())
}
