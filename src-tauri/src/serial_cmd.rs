use crate::checksum;
use crate::state::SerialState;
use serial2::{CharSize, FlowControl, Parity, StopBits};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
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
    let ports = serial2::SerialPort::available_ports().map_err(|e| e.to_string())?;
    let infos: Vec<PortInfo> = ports
        .into_iter()
        .map(|path| {
            let name = port_name_from_path(&path);
            let desc = get_port_description(&name).unwrap_or_else(|| name.clone());
            PortInfo {
                name,
                description: desc,
            }
        })
        .collect();
    Ok(infos)
}

fn port_name_from_path(path: &std::path::Path) -> String {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        let s = s.trim_start_matches("\\\\.\\");
        s.to_string()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().to_string()
    }
}

fn decode_oem_text(bytes: &[u8]) -> String {
    #[cfg(windows)]
    {
        extern "system" {
            fn GetOEMCP() -> u32;
        }
        let cp = unsafe { GetOEMCP() };
        match cp {
            936 => encoding_rs::GBK.decode(bytes).0.into_owned(),
            932 => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
            949 => encoding_rs::EUC_KR.decode(bytes).0.into_owned(),
            950 => encoding_rs::BIG5.decode(bytes).0.into_owned(),
            1250 | 1252 | 1254 | 1257 => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
            1251 => encoding_rs::WINDOWS_1251.decode(bytes).0.into_owned(),
            1253 => encoding_rs::ISO_8859_7.decode(bytes).0.into_owned(),
            1255 => encoding_rs::WINDOWS_1255.decode(bytes).0.into_owned(),
            1256 => encoding_rs::WINDOWS_1256.decode(bytes).0.into_owned(),
            1258 => encoding_rs::WINDOWS_1258.decode(bytes).0.into_owned(),
            _ => String::from_utf8_lossy(bytes).into_owned(),
        }
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn get_port_description(name: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("wmic");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .args([
            "path", "Win32_SerialPort",
            "where", &format!("DeviceID='{}'", name),
            "get", "Name", "/format:value",
        ])
        .output()
        .ok()?;
    let text = decode_oem_text(&output.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(value) = line.strip_prefix("Name=") {
            let value: String = value.chars().filter(|c| !c.is_control()).collect();
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn open_port(
    state: tauri::State<'_, SerialState>,
    app: tauri::AppHandle,
    path: String,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    parity: String,
    flow_control: String,
) -> Result<(), String> {
    let _guard = state.op_lock.lock().await;
    open_port_inner(&state, &app, &path, baud, char_size, stop_bits, &parity, &flow_control).await
}

async fn open_port_inner(
    state: &SerialState,
    app: &tauri::AppHandle,
    path: &str,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    parity: &str,
    flow_control: &str,
) -> Result<(), String> {
    if state.connected.load(Ordering::SeqCst) {
        return Err("Port already open".into());
    }

    let port = serial2::SerialPort::open(path, |mut s: serial2::Settings| {
        s.set_baud_rate(baud)?;
        s.set_char_size(match char_size {
            5 => CharSize::Bits5,
            6 => CharSize::Bits6,
            7 => CharSize::Bits7,
            _ => CharSize::Bits8,
        });
        s.set_stop_bits(match stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        });
        s.set_parity(match parity {
            "odd" => Parity::Odd,
            "even" => Parity::Even,
            _ => Parity::None,
        });
        s.set_flow_control(match flow_control {
            "hardware" => FlowControl::RtsCts,
            "software" => FlowControl::XonXoff,
            _ => FlowControl::None,
        });
        Ok(s)
    }).map_err(|e| format!("Failed to open {}: {}", path, e))?;

    let mut reader = port.try_clone()
        .map_err(|e| format!("Cannot clone port: {}", e))?;
    reader.set_read_timeout(Duration::from_millis(1))
        .ok();

    *state.port.lock().await = Some(port);
    *state.port_name.lock().await = Some(path.to_string());
    state.baud_rate.store(baud, Ordering::SeqCst);
    state.char_size.store(char_size, Ordering::SeqCst);
    state.stop_bits.store(stop_bits, Ordering::SeqCst);
    *state.parity.lock().await = parity.to_string();
    *state.flow_control.lock().await = flow_control.to_string();
    state.connected.store(true, Ordering::SeqCst);
    state.stop_reading.store(false, Ordering::SeqCst);
    state.tx_bytes.store(0, Ordering::SeqCst);
    state.rx_bytes.store(0, Ordering::SeqCst);

    let stop_flag = state.stop_reading.clone();
    let rx_count = state.rx_bytes.clone();
    let connected_flag = state.connected.clone();
    let suppress_emit = state.suppress_close_event.clone();
    let app_handle = app.clone();

    let handle = tokio::task::spawn_blocking(move || {
        const GAP_TIMEOUT: Duration = Duration::from_millis(5);
        let mut buf = [0u8; 4096];
        let mut acc: Vec<u8> = Vec::new();
        let mut last_time = Instant::now();

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                if !acc.is_empty() {
                    let _ = app_handle.emit("serial-data", acc.clone());
                }
                break;
            }
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    acc.extend_from_slice(&buf[..n]);
                    last_time = Instant::now();
                    rx_count.fetch_add(n as u64, Ordering::SeqCst);
                    if acc.len() >= 4096 {
                        let data = std::mem::take(&mut acc);
                        let _ = app_handle.emit("serial-data", data);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    if !acc.is_empty() && last_time.elapsed() >= GAP_TIMEOUT {
                        let data = std::mem::take(&mut acc);
                        let _ = app_handle.emit("serial-data", data);
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    log::error!("Serial read error: {}", e);
                    break;
                }
                _ => {}
            }
        }
        connected_flag.store(false, Ordering::SeqCst);
        if !suppress_emit.load(Ordering::SeqCst) {
            let _ = app_handle.emit("port-closed", ());
        }
    });

    *state.read_handle.lock().await = Some(handle);

    Ok(())
}

#[tauri::command]
pub async fn close_port(
    state: tauri::State<'_, SerialState>,
) -> Result<(), String> {
    let _guard = state.op_lock.lock().await;
    close_port_inner(&state).await
}

async fn close_port_inner(
    state: &SerialState,
) -> Result<(), String> {
    state.stop_reading.store(true, Ordering::SeqCst);
    state.connected.store(false, Ordering::SeqCst);

    let handle = state.read_handle.lock().await.take();
    if let Some(h) = handle {
        if let Err(e) = h.await {
            log::error!("Read task panicked: {:?}", e);
        }
    }

    let mut port = state.port.lock().await;
    if let Some(ref p) = *port {
        let _ = p.discard_buffers();
    }
    *port = None;
    *state.port_name.lock().await = None;

    Ok(())
}

#[tauri::command]
pub async fn set_baud_rate(
    state: tauri::State<'_, SerialState>,
    app: tauri::AppHandle,
    path: String,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    parity: String,
    flow_control: String,
) -> Result<(), String> {
    let _guard = state.op_lock.lock().await;

    state.suppress_close_event.store(true, Ordering::SeqCst);

    let result = async {
        close_port_inner(&state).await?;
        open_port_inner(&state, &app, &path, baud, char_size, stop_bits, &parity, &flow_control).await
    }.await;

    state.suppress_close_event.store(false, Ordering::SeqCst);

    result
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

pub async fn send_data_internal(
    state: &SerialState,
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
pub async fn send_data(
    state: tauri::State<'_, SerialState>,
    data: String,
    hex_mode: bool,
    encoding: Option<String>,
) -> Result<String, String> {
    send_data_internal(&state, data, hex_mode, encoding).await
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
        "baud": state.baud_rate.load(Ordering::SeqCst),
        "dataBits": state.char_size.load(Ordering::SeqCst),
        "parity": state.parity.lock().await.clone(),
        "stopBits": state.stop_bits.load(Ordering::SeqCst),
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
