use crate::checksum;
use crate::state::SerialState;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{Emitter, Manager};
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

#[derive(Serialize)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let infos: Vec<PortInfo> = ports
        .into_iter()
        .map(|p| {
            let desc = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let product = info.product.as_deref().unwrap_or("");
                    let manufacturer = info.manufacturer.as_deref().unwrap_or("");
                    format!("{} {}", manufacturer, product).trim().to_string()
                }
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                _ => String::new(),
            };
            PortInfo {
                name: p.port_name,
                description: desc,
            }
        })
        .collect();
    Ok(infos)
}

#[tauri::command]
pub async fn open_port(
    state: tauri::State<'_, SerialState>,
    app: tauri::AppHandle,
    path: String,
    baud: u32,
) -> Result<(), String> {
    let _guard = state.op_lock.lock().await;

    if state.connected.load(Ordering::SeqCst) {
        return Err("Port already open".into());
    }

    let port = serialport::new(&path, baud)
        .data_bits(serialport::DataBits::Eight)
        .flow_control(serialport::FlowControl::None)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", path, e))?;

    let reader = port.try_clone().map_err(|e| format!("Cannot clone port: {}", e))?;

    *state.port.lock().await = Some(port);
    *state.port_name.lock().await = Some(path.clone());
    state.connected.store(true, Ordering::SeqCst);
    state.stop_reading.store(false, Ordering::SeqCst);
    state.tx_bytes.store(0, Ordering::SeqCst);
    state.rx_bytes.store(0, Ordering::SeqCst);

    let stop_flag = state.stop_reading.clone();
    let rx_count = state.rx_bytes.clone();
    let connected_flag = state.connected.clone();
    let app_handle = app.clone();

    let handle = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        let mut serial = reader;
        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            match serial.read(&mut buf) {
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Ok(n) => {
                    rx_count.fetch_add(n as u64, Ordering::SeqCst);
                    let data = buf[..n].to_vec();
                    let _ = app_handle.emit("serial-data", data);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    continue;
                }
                Err(e) => {
                    log::error!("Serial read error: {}", e);
                    break;
                }
            }
        }
        connected_flag.store(false, Ordering::SeqCst);
        let _ = app_handle.emit("port-closed", ());
    });

    *state.read_handle.lock().await = Some(handle);

    Ok(())
}

#[tauri::command]
pub async fn close_port(
    state: tauri::State<'_, SerialState>,
) -> Result<(), String> {
    let _guard = state.op_lock.lock().await;

    state.stop_reading.store(true, Ordering::SeqCst);
    state.connected.store(false, Ordering::SeqCst);

    let handle = state.read_handle.lock().await.take();
    if let Some(h) = handle {
        if let Err(e) = h.await {
            log::error!("Read task panicked: {:?}", e);
        }
    }

    let mut port = state.port.lock().await;
    if let Some(ref mut p) = *port {
        let _ = p.clear(serialport::ClearBuffer::All);
    }
    *port = None;
    *state.port_name.lock().await = None;

    Ok(())
}

fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        "gbk" => {
            let (cow, _, _) = encoding_rs::GBK.encode(text);
            cow.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    }
}

#[tauri::command]
pub async fn send_data(
    state: tauri::State<'_, SerialState>,
    data: String,
    hex_mode: bool,
    encoding: Option<String>,
) -> Result<String, String> {
    let bytes = if hex_mode {
        parse_hex_string(&data).map_err(|e| format!("Hex parse error: {}", e))?
    } else {
        let enc = encoding.as_deref().unwrap_or("utf-8");
        encode_text(&data, enc)
    };

    if !state.connected.load(Ordering::SeqCst) {
        return Err("Port not open".into());
    }
    let mut port = state.port.lock().await;
    let port = port.as_mut().ok_or("Port not open")?;
    port.write_all(&bytes).map_err(|e| format!("Write error: {}", e))?;
    state.tx_bytes.fetch_add(bytes.len() as u64, Ordering::SeqCst);

    Ok(bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "))
}

#[tauri::command]
pub async fn send_data_raw(
    state: tauri::State<'_, SerialState>,
    data: String,
    hex_mode: bool,
    encoding: Option<String>,
    checksum_algo: Option<String>,
    checksum_pos: Option<i32>,
) -> Result<(), String> {
    let bytes = if hex_mode {
        parse_hex_string(&data).map_err(|e| format!("Hex parse error: {}", e))?
    } else {
        let enc = encoding.as_deref().unwrap_or("utf-8");
        encode_text(&data, enc)
    };

    let bytes = if let Some(ref algo) = checksum_algo {
        let pos = checksum_pos.unwrap_or(0);
        checksum::apply_checksum(&bytes, algo, pos)
    } else {
        bytes
    };

    if !state.connected.load(Ordering::SeqCst) {
        return Err("Port not open".into());
    }
    let mut port = state.port.lock().await;
    let port = port.as_mut().ok_or("Port not open")?;
    port.write_all(&bytes).map_err(|e| format!("Write error: {}", e))?;
    state.tx_bytes.fetch_add(bytes.len() as u64, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn send_raw_bytes(
    state: tauri::State<'_, SerialState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if !state.connected.load(Ordering::SeqCst) {
        return Err("Port not open".into());
    }
    let mut port = state.port.lock().await;
    let port = port.as_mut().ok_or("Port not open")?;
    port.write_all(&bytes).map_err(|e| format!("Write error: {}", e))?;
    state.tx_bytes.fetch_add(bytes.len() as u64, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn get_port_info(
    state: tauri::State<'_, SerialState>,
) -> Result<serde_json::Value, String> {
    let name = state.port_name.lock().await.clone().unwrap_or_default();
    let connected = state.connected.load(Ordering::SeqCst);
    let tx = state.tx_bytes.load(Ordering::SeqCst);
    let rx = state.rx_bytes.load(Ordering::SeqCst);

    Ok(serde_json::json!({
        "name": name,
        "connected": connected,
        "tx": tx,
        "rx": rx,
        "baud": 115200,
        "dataBits": 8,
        "parity": "None",
        "stopBits": 1,
    }))
}

#[tauri::command]
pub async fn calculate_checksum(
    data: String,
    hex_mode: bool,
    algo: String,
    position: i32,
) -> Result<serde_json::Value, String> {
    let bytes = if hex_mode {
        parse_hex_string(&data).map_err(|e| format!("Hex parse error: {}", e))?
    } else {
        data.into_bytes()
    };

    let result = checksum::calc_checksum(&bytes, &algo);
    let applied = checksum::apply_checksum(&bytes, &algo, position);

    Ok(serde_json::json!({
        "checksum": result.hex,
        "appliedHex": applied.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "),
        "appliedLen": applied.len(),
    }))
}

#[tauri::command]
pub async fn open_multi_string_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("multi-string") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "multi-string",
            tauri::WebviewUrl::App("multi.html".into()),
        )
        .title("多字符串发送")
        .inner_size(520.0, 560.0)
        .min_inner_size(400.0, 400.0)
        .resizable(true)
        .decorations(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct MultiStringItem {
    pub text: String,
    pub delay: u32,
    pub hex: bool,
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
pub async fn decode_bytes(bytes: Vec<u8>, encoding: String) -> Result<String, String> {
    match encoding.as_str() {
        "gbk" => {
            let (cow, _, _) = encoding_rs::GBK.decode(&bytes);
            Ok(cow.into_owned())
        }
        _ => Ok(String::from_utf8_lossy(&bytes).into_owned()),
    }
}

fn parse_hex_string(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(vec![]);
    }
    let hex_chars: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if hex_chars.len() % 2 != 0 {
        return Err("Hex string must have even number of characters".into());
    }
    let bytes: Result<Vec<u8>, _> = (0..hex_chars.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex_chars[i..i + 2], 16))
        .collect();
    bytes.map_err(|e| format!("Invalid hex: {}", e))
}
