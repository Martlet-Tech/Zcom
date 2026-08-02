use crate::checksum;
use crate::checksum::ChecksumAlgo;
use crate::encoding_utils;
use crate::state::{ConnState, SerialState};
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

#[derive(Clone, Copy, PartialEq)]
enum ReadLoopEnd {
    Stopped,
    DeviceLost,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn port_name_strips_win32_device_namespace() {
        assert_eq!(port_name_from_path(std::path::Path::new(r"\\.\COM10")), "COM10");
        assert_eq!(port_name_from_path(std::path::Path::new("COM3")), "COM3");
    }

    #[test]
    fn unknown_baud_algo_parsing_is_irrelevant_to_serial_state() {
        let st = crate::state::SerialState::new();
        assert!(!st.connected.load(Ordering::SeqCst));
        assert_eq!(
            *st.conn.state.lock().unwrap(),
            crate::state::ConnState::Closed
        );
        assert_eq!(st.generation.load(Ordering::SeqCst), 0);
    }
}

fn open_port_sync(
    path: &str,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    parity: &str,
    flow_control: &str,
) -> Result<serial2::SerialPort, String> {
    serial2::SerialPort::open(path, |mut s: serial2::Settings| {
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
    })
    .map_err(|e| format!("Failed to open {}: {}", path, e))
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

    let port = open_port_sync(path, baud, char_size, stop_bits, parity, flow_control)?;

    register_port(state, path, baud, char_size, stop_bits, port);
    *state.parity.lock().await = parity.to_string();
    *state.flow_control.lock().await = flow_control.to_string();
    state.connected.store(true, Ordering::SeqCst);
    state.stop_reading.store(false, Ordering::SeqCst);
    *state.conn.state.lock().unwrap_or_else(|e| e.into_inner()) = ConnState::Reading;
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let c_state = state.clone();
    let c_app = app.clone();
    let c_path = path.to_string();
    let c_parity = parity.to_string();
    let c_flow_control = flow_control.to_string();
    tokio::task::spawn_blocking(move || {
        run_port_manager(
            c_state,
            c_app,
            c_path,
            baud,
            char_size,
            stop_bits,
            c_parity,
            c_flow_control,
            gen,
        );
    });

    Ok(())
}

fn register_port(
    state: &SerialState,
    path: &str,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    port: serial2::SerialPort,
) {
    *state.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(port);
    *state.port_name.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.to_string());
    state.baud_rate.store(baud, Ordering::SeqCst);
    state.char_size.store(char_size, Ordering::SeqCst);
    state.stop_bits.store(stop_bits, Ordering::SeqCst);
    state.tx_bytes.store(0, Ordering::SeqCst);
    state.rx_bytes.store(0, Ordering::SeqCst);
}

fn set_conn_state(state: &SerialState, s: ConnState) {
    *state.conn.state.lock().unwrap_or_else(|e| e.into_inner()) = s;
}

fn run_port_manager(
    state: SerialState,
    app: tauri::AppHandle,
    path: String,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    parity: String,
    flow_control: String,
    gen: u32,
) {
    let stale = || state.generation.load(Ordering::SeqCst) != gen;
    let emit_closed_if_needed = |app: &tauri::AppHandle| {
        if !state.suppress_close_event.load(Ordering::SeqCst) {
            let _ = app.emit("port-closed", ());
        }
    };

    loop {
        let phase = *state.conn.state.lock().unwrap_or_else(|e| e.into_inner());
        match phase {
            ConnState::Closed => return,
            ConnState::Reading => {
                let reader = {
                    let port = state.port.lock().unwrap_or_else(|e| e.into_inner());
                    match port.as_ref().and_then(|p| p.try_clone().ok()) {
                        Some(r) => r,
                        None => {
                            emit_closed_if_needed(&app);
                            set_conn_state(&state, ConnState::Closed);
                            return;
                        }
                    }
                };
                let mut reader = reader;
                reader.set_read_timeout(Duration::from_millis(1)).ok();

                match read_loop(reader, &state, &app, gen) {
                    ReadLoopEnd::Stopped => {
                        if !stale() {
                            emit_closed_if_needed(&app);
                        }
                        set_conn_state(&state, ConnState::Closed);
                        return;
                    }
                    ReadLoopEnd::DeviceLost => {
                        if stale() {
                            return;
                        }
                        *state.port.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        *state.port_name.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        state.connected.store(false, Ordering::SeqCst);
                        if state.suppress_close_event.load(Ordering::SeqCst)
                            || !state.auto_reconnect.load(Ordering::SeqCst)
                        {
                            emit_closed_if_needed(&app);
                            set_conn_state(&state, ConnState::Closed);
                            return;
                        }
                        let _ = app.emit(
                            "port-reconnecting",
                            serde_json::json!({ "name": path, "baud": baud }),
                        );
                        set_conn_state(&state, ConnState::Reconnecting);
                    }
                }
            }
            ConnState::Reconnecting => {
                let interval = state.reconnect_interval_ms.load(Ordering::SeqCst).max(100);
                let guard = state.conn.state.lock().unwrap_or_else(|e| e.into_inner());
                let (mut guard, _) = state
                    .conn
                    .wake
                    .wait_timeout(guard, Duration::from_millis(interval as u64))
                    .unwrap_or_else(|e| e.into_inner());

                if state.stop_reading.load(Ordering::SeqCst) {
                    if !stale() {
                        emit_closed_if_needed(&app);
                    }
                    *guard = ConnState::Closed;
                    return;
                }
                if stale() || state.connected.load(Ordering::SeqCst) {
                    *guard = ConnState::Closed;
                    return;
                }
                drop(guard);

                match open_port_sync(&path, baud, char_size, stop_bits, &parity, &flow_control) {
                    Ok(port) => {
                        if state.stop_reading.load(Ordering::SeqCst) || stale() {
                            drop(port);
                            if state.stop_reading.load(Ordering::SeqCst) && !stale() {
                                emit_closed_if_needed(&app);
                            }
                            set_conn_state(&state, ConnState::Closed);
                            return;
                        }
                        register_port(&state, &path, baud, char_size, stop_bits, port);
                        state.connected.store(true, Ordering::SeqCst);
                        state.stop_reading.store(false, Ordering::SeqCst);
                        let _ = app.emit("port-reconnected", ());
                        set_conn_state(&state, ConnState::Reading);
                    }
                    Err(_) => {
                        if stale() || state.connected.load(Ordering::SeqCst) {
                            set_conn_state(&state, ConnState::Closed);
                            return;
                        }
                    }
                }
            }
        }
    }
}

fn read_loop(
    reader: serial2::SerialPort,
    state: &SerialState,
    app: &tauri::AppHandle,
    gen: u32,
) -> ReadLoopEnd {
    const GAP_TIMEOUT: Duration = Duration::from_millis(5);
    let mut buf = [0u8; 4096];
    let mut acc: Vec<u8> = Vec::new();
    let mut last_time = Instant::now();

    loop {
        if state.stop_reading.load(Ordering::SeqCst)
            || state.generation.load(Ordering::SeqCst) != gen
        {
            if !acc.is_empty() {
                let _ = app.emit("serial-data", acc.clone());
            }
            return ReadLoopEnd::Stopped;
        }
        match reader.read(&mut buf) {
            Ok(n) if n > 0 => {
                acc.extend_from_slice(&buf[..n]);
                last_time = Instant::now();
                state.rx_bytes.fetch_add(n as u64, Ordering::SeqCst);
                if acc.len() >= 4096 {
                    let data = std::mem::take(&mut acc);
                    let _ = app.emit("serial-data", data);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                if !acc.is_empty() && last_time.elapsed() >= GAP_TIMEOUT {
                    let data = std::mem::take(&mut acc);
                    let _ = app.emit("serial-data", data);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                log::warn!("Serial read error (device removed?): {}", e);
                return ReadLoopEnd::DeviceLost;
            }
            _ => {}
        }
    }
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
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.conn.wake.notify_all();

    let mut port = state.port.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref p) = *port {
        let _ = p.discard_buffers();
    }
    *port = None;
    *state.port_name.lock().unwrap_or_else(|e| e.into_inner()) = None;

    Ok(())
}

async fn reopen_with_params(
    state: &SerialState,
    app: &tauri::AppHandle,
    path: &str,
    baud: u32,
    char_size: u8,
    stop_bits: u8,
    parity: &str,
    flow_control: &str,
) -> Result<(), String> {
    state.suppress_close_event.store(true, Ordering::SeqCst);

    let result = async {
        close_port_inner(state).await?;
        open_port_inner(state, app, path, baud, char_size, stop_bits, parity, flow_control).await
    }
    .await;

    state.suppress_close_event.store(false, Ordering::SeqCst);

    result
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
    reopen_with_params(&state, &app, &path, baud, char_size, stop_bits, &parity, &flow_control).await
}

#[tauri::command]
pub async fn switch_port(
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
    reopen_with_params(&state, &app, &path, baud, char_size, stop_bits, &parity, &flow_control).await
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
    let mut port = state.port.lock().unwrap_or_else(|e| e.into_inner());
    let port = port.as_mut().ok_or("Port not open")?;
    port.write_all(&bytes).map_err(|e| format!("Write error: {}", e))?;
    port.flush().map_err(|e| format!("Flush error: {}", e))?;
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
    let mut port = state.port.lock().unwrap_or_else(|e| e.into_inner());
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
    let mut port = state.port.lock().unwrap_or_else(|e| e.into_inner());
    let port = port.as_mut().ok_or("Port not open")?;
    port.write_all(&bytes).map_err(|e| format!("Write error: {}", e))?;
    port.flush().map_err(|e| format!("Flush error: {}", e))?;
    state.tx_bytes.fetch_add(bytes.len() as u64, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn reset_io_counters(
    state: tauri::State<'_, SerialState>,
) -> Result<(), String> {
    state.tx_bytes.store(0, Ordering::SeqCst);
    state.rx_bytes.store(0, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn set_reconnect_config(
    state: tauri::State<'_, SerialState>,
    auto: bool,
    interval_ms: u32,
) -> Result<(), String> {
    state.auto_reconnect.store(auto, Ordering::SeqCst);
    state.reconnect_interval_ms.store(interval_ms.max(100), Ordering::SeqCst);
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
