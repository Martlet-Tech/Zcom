use crate::checksum;
use crate::checksum::ChecksumAlgo;
use crate::encoding_utils;
use crate::state::SerialState;
use serial2::{CharSize, FlowControl, Parity, StopBits};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::Emitter;

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
            let desc = encoding_utils::get_port_description(&name).unwrap_or_else(|| name.clone());
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

pub async fn send_data_internal(
    state: &SerialState,
    data: String,
    hex_mode: bool,
    encoding: Option<String>,
) -> Result<String, String> {
    let bytes = if hex_mode {
        encoding_utils::parse_hex_string(&data).map_err(|e| format!("Hex parse error: {}", e))?
    } else {
        let enc = encoding.as_deref().unwrap_or("utf-8");
        encoding_utils::encode_text(&data, enc)
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
    checksum_lsb: Option<bool>,
) -> Result<(), String> {
    let bytes = if hex_mode {
        encoding_utils::parse_hex_string(&data).map_err(|e| format!("Hex parse error: {}", e))?
    } else {
        let enc = encoding.as_deref().unwrap_or("utf-8");
        encoding_utils::encode_text(&data, enc)
    };

    let bytes = if let Some(ref algo_str) = checksum_algo {
        let algo: ChecksumAlgo = algo_str.parse()?;
        let pos = checksum_pos.unwrap_or(0);
        let lsb = checksum_lsb.unwrap_or(false);
        checksum::apply_checksum(&bytes, algo, pos, lsb)
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
    Ok(state.to_port_info().await)
}

#[tauri::command]
pub async fn calculate_checksum(
    data: String,
    hex_mode: bool,
    algo: String,
    position: i32,
    lsb: Option<bool>,
) -> Result<serde_json::Value, String> {
    let bytes = if hex_mode {
        encoding_utils::parse_hex_string(&data).map_err(|e| format!("Hex parse error: {}", e))?
    } else {
        data.into_bytes()
    };

    let algo: ChecksumAlgo = algo.parse()?;
    let lsb = lsb.unwrap_or(false);
    let result = checksum::calc_checksum(&bytes, algo);
    let applied = checksum::apply_checksum(&bytes, algo, position, lsb);

    Ok(serde_json::json!({
        "checksum": result.hex,
        "appliedHex": applied.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "),
        "appliedLen": applied.len(),
    }))
}
