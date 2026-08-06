use crate::conn::{validate_mode, ConnHandle};
use crate::state::{
    ConnState, NetIo, NetState, MODE_TCP_CLIENT, MODE_TCP_SERVER, MODE_UDP_CLIENT,
    MODE_UDP_SERVER,
};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::Ordering;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

const GAP_TIMEOUT: Duration = Duration::from_millis(5);

fn set_conn_state(state: &NetState, s: ConnState) {
    *state.conn.state.lock().unwrap_or_else(|e| e.into_inner()) = s;
}

fn stale(state: &NetState, gen: u32) -> bool {
    state.generation.load(Ordering::SeqCst) != gen
}

fn tool_parked(state: &NetState) -> bool {
    state.tool.is_busy()
}

fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve {}:{}: {}", host, port, e))?
        .next()
        .ok_or_else(|| format!("Cannot resolve {}:{}", host, port))
}

#[tauri::command]
pub async fn set_conn_mode(
    state: tauri::State<'_, NetState>,
    mode: u8,
) -> Result<(), String> {
    let state = state.inner();
    if !validate_mode(mode) {
        return Err("Unknown connection mode".into());
    }
    state.mode.store(mode, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn net_open(
    handle: tauri::State<'_, ConnHandle>,
    app: tauri::AppHandle,
    mode: u8,
    remote_host: Option<String>,
    remote_port: Option<u16>,
    local_port: Option<u16>,
) -> Result<(), String> {
    handle
        .open(
            &app,
            crate::conn::ConnParams {
                mode,
                remote_host,
                remote_port,
                local_port,
                ..Default::default()
            },
        )
        .await
}

pub(crate) async fn net_open_inner(
    state: &NetState,
    app: &tauri::AppHandle,
    mode: u8,
    remote_host: Option<String>,
    remote_port: Option<u16>,
    local_port: Option<u16>,
) -> Result<(), String> {
    if state.connected.load(Ordering::SeqCst) {
        return Err("Connection already open".into());
    }
    state.stop_reading.store(false, Ordering::SeqCst);
    state.meter.reset();
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let c_state = state.clone();
    let c_app = app.clone();

    match mode {
        MODE_TCP_CLIENT => {
            let host = remote_host.ok_or("Remote host required")?;
            let port = remote_port.ok_or("Remote port required")?;
            let addr = resolve(&host, port)?;
            let stream = TcpStream::connect(addr)
                .map_err(|e| format!("Connect {}:{} failed: {}", host, port, e))?;
            stream.set_read_timeout(Some(Duration::from_millis(1))).ok();
            register_io(&state, NetIo::Stream(stream), Some(format!("{}:{}", host, port)));
            set_conn_state(&state, ConnState::Reading);
            std::thread::spawn(move || tcp_client_manager(c_state, c_app, addr, gen));
        }
        MODE_TCP_SERVER => {
            let port = local_port.ok_or("Local port required")?;
            let listener = TcpListener::bind(("0.0.0.0", port))
                .map_err(|e| format!("Bind port {} failed: {}", port, e))?;
            *state
                .local
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(format!("0.0.0.0:{}", port));
            set_conn_state(&state, ConnState::Reading);
            std::thread::spawn(move || tcp_server_manager(c_state, c_app, listener, gen));
        }
        MODE_UDP_CLIENT => {
            let host = remote_host.ok_or("Remote host required")?;
            let port = remote_port.ok_or("Remote port required")?;
            let addr = resolve(&host, port)?;
            let sock = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| format!("Bind failed: {}", e))?;
            sock.connect(addr).map_err(|e| format!("Connect failed: {}", e))?;
            sock.set_read_timeout(Some(Duration::from_millis(1))).ok();
            register_io(
                &state,
                NetIo::Datagram {
                    sock,
                    peer: StdMutex::new(Some(addr)),
                },
                Some(format!("{}:{}", host, port)),
            );
            set_conn_state(&state, ConnState::Reading);
            std::thread::spawn(move || udp_read_loop(c_state, c_app, gen));
        }
        MODE_UDP_SERVER => {
            let port = local_port.ok_or("Local port required")?;
            let sock = UdpSocket::bind(("0.0.0.0", port))
                .map_err(|e| format!("Bind port {} failed: {}", port, e))?;
            sock.set_read_timeout(Some(Duration::from_millis(1))).ok();
            register_io(
                &state,
                NetIo::Datagram {
                    sock,
                    peer: StdMutex::new(None),
                },
                None,
            );
            *state
                .local
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(format!("0.0.0.0:{}", port));
            set_conn_state(&state, ConnState::Reading);
            std::thread::spawn(move || udp_read_loop(c_state, c_app, gen));
        }
        _ => return Err("Unknown connection mode".into()),
    }

    state.connected.store(true, Ordering::SeqCst);
    Ok(())
}

fn register_io(state: &NetState, io: NetIo, remote: Option<String>) {
    *state.io.lock().unwrap_or_else(|e| e.into_inner()) = Some(io);
    if let Some(r) = remote {
        *state.remote.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
    }
}

#[tauri::command]
pub async fn net_close(handle: tauri::State<'_, ConnHandle>) -> Result<(), String> {
    handle.close(crate::conn::Conn::Net).await
}

pub(crate) async fn net_close_inner(state: &NetState) -> Result<(), String> {
    state.stop_reading.store(true, Ordering::SeqCst);
    state.connected.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.conn.wake.notify_all();
    *state.io.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.remote.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

pub async fn net_send_bytes(state: &NetState, bytes: &[u8]) -> Result<(), String> {
    let io = state.io.lock().unwrap_or_else(|e| e.into_inner());
    match io.as_ref() {
        Some(NetIo::Stream(s)) => {
            let mut s = s.try_clone().map_err(|e| format!("Send error: {}", e))?;
            s.write_all(bytes).map_err(|e| format!("Write error: {}", e))?;
            s.flush().ok();
        }
        Some(NetIo::Datagram { sock, peer }) => {
            let addr = peer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .cloned();
            match addr {
                Some(addr) => {
                    sock.send_to(bytes, addr).map_err(|e| format!("Send error: {}", e))?;
                }
                None => return Err("No peer to send to".into()),
            }
        }
        None => return Err("Connection not open".into()),
    }
    Ok(())
}

enum NetReadEnd {
    Stopped,
    Lost,
}

fn emit_serial_data(app: &tauri::AppHandle, data: Vec<u8>, frame_end: bool) {
    let _ = app.emit(
        "serial-data",
        serde_json::json!({ "bytes": data, "frameEnd": frame_end }),
    );
}

fn stream_read_loop(
    stream: &mut TcpStream,
    state: &NetState,
    app: &tauri::AppHandle,
    gen: u32,
) -> NetReadEnd {
    // 非侵入计数：流句柄包 MeteredReader 装饰器，循环逻辑不感知计数。
    let mut reader = crate::conn::MeteredReader::new(stream, state.meter.clone());
    let mut buf = [0u8; 4096];
    let mut acc: Vec<u8> = Vec::new();
    let mut last_time = Instant::now();

    loop {
        if state.stop_reading.load(Ordering::SeqCst) || stale(state, gen) {
            if !acc.is_empty() {
                emit_serial_data(app, acc.clone(), true);
            }
            return NetReadEnd::Stopped;
        }
        if tool_parked(state) {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        match reader.read(&mut buf) {
            Ok(n) if n > 0 => {
                acc.extend_from_slice(&buf[..n]);
                last_time = Instant::now();
                if acc.len() >= 4096 {
                    let data = std::mem::take(&mut acc);
                    emit_serial_data(app, data, false);
                }
            }
            Ok(0) => {
                log::info!("TCP peer closed connection");
                return NetReadEnd::Lost;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                if !acc.is_empty() && last_time.elapsed() >= GAP_TIMEOUT {
                    let data = std::mem::take(&mut acc);
                    emit_serial_data(app, data, true);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                log::warn!("TCP read error: {}", e);
                return NetReadEnd::Lost;
            }
            _ => {}
        }
    }
}

fn tcp_client_manager(state: NetState, app: tauri::AppHandle, addr: SocketAddr, gen: u32) {
    loop {
        let phase = *state.conn.state.lock().unwrap_or_else(|e| e.into_inner());
        match phase {
            ConnState::Closed => return,
            ConnState::Reading => {
                let stream = {
                    let io = state.io.lock().unwrap_or_else(|e| e.into_inner());
                    match io.as_ref() {
                        Some(NetIo::Stream(s)) => s.try_clone().ok(),
                        _ => None,
                    }
                };
                let mut stream = match stream {
                    Some(s) => s,
                    None => {
                        set_conn_state(&state, ConnState::Closed);
                        return;
                    }
                };
                match stream_read_loop(&mut stream, &state, &app, gen) {
                    NetReadEnd::Stopped => {
                        set_conn_state(&state, ConnState::Closed);
                        return;
                    }
                    NetReadEnd::Lost => {
                        if stale(&state, gen) {
                            return;
                        }
                        *state.io.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        state.connected.store(false, Ordering::SeqCst);
                        if !state.auto_reconnect.load(Ordering::SeqCst) {
                            let _ = app.emit("port-closed", ());
                            set_conn_state(&state, ConnState::Closed);
                            return;
                        }
                        let _ = app.emit(
                            "port-reconnecting",
                            serde_json::json!({ "name": addr.to_string(), "baud": 0 }),
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

                if state.stop_reading.load(Ordering::SeqCst) || stale(&state, gen) {
                    *guard = ConnState::Closed;
                    return;
                }
                drop(guard);

                match TcpStream::connect(addr) {
                    Ok(stream) => {
                        if state.stop_reading.load(Ordering::SeqCst) || stale(&state, gen) {
                            set_conn_state(&state, ConnState::Closed);
                            return;
                        }
                        stream.set_read_timeout(Some(Duration::from_millis(1))).ok();
                        *state.io.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(NetIo::Stream(stream));
                        state.connected.store(true, Ordering::SeqCst);
                        let _ = app.emit("port-reconnected", ());
                        set_conn_state(&state, ConnState::Reading);
                    }
                    Err(_) => {
                        // stay in Reconnecting, retry next interval
                    }
                }
            }
        }
    }
}

fn tcp_server_manager(state: NetState, app: tauri::AppHandle, listener: TcpListener, gen: u32) {
    let _ = listener.set_nonblocking(true);
    loop {
        if state.stop_reading.load(Ordering::SeqCst) || stale(&state, gen) {
            cleanup_and_close(&state, &app);
            return;
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                log::info!("TCP client connected: {}", peer);
                let _ = app.emit("net-peer-connected", peer.to_string());
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_millis(1)));
                *state.io.lock().unwrap_or_else(|e| e.into_inner()) = Some(NetIo::Stream(stream));
                *state.remote.lock().unwrap_or_else(|e| e.into_inner()) = Some(peer.to_string());
                state.meter.reset();

                let stopped = loop {
                    if state.stop_reading.load(Ordering::SeqCst) || stale(&state, gen) {
                        break true;
                    }
                    let stream = {
                        let io = state.io.lock().unwrap_or_else(|e| e.into_inner());
                        match io.as_ref() {
                            Some(NetIo::Stream(s)) => s.try_clone().ok(),
                            _ => None,
                        }
                    };
                    let mut stream = match stream {
                        Some(s) => s,
                        None => break true,
                    };
                    match stream_read_loop(&mut stream, &state, &app, gen) {
                        NetReadEnd::Lost => break false,
                        NetReadEnd::Stopped => break true,
                    }
                };

                *state.remote.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if stopped {
                    cleanup_and_close(&state, &app);
                    return;
                }
                // client disconnected: keep listening (静默等待下个连接)
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn udp_read_loop(state: NetState, app: tauri::AppHandle, gen: u32) {
    let mut buf = [0u8; 65536];
    loop {
        if state.stop_reading.load(Ordering::SeqCst) || stale(&state, gen) {
            cleanup_and_close(&state, &app);
            return;
        }
        if tool_parked(&state) {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        let sock = {
            let io = state.io.lock().unwrap_or_else(|e| e.into_inner());
            match io.as_ref() {
                Some(NetIo::Datagram { sock, .. }) => sock.try_clone().ok(),
                _ => None,
            }
        };
        let sock = match sock {
            Some(s) => s,
            None => {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                {
                    let io = state.io.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(NetIo::Datagram { peer, .. }) = io.as_ref() {
                        *peer.lock().unwrap_or_else(|e| e.into_inner()) = Some(from);
                    }
                }
                state.meter.add_rx(n as u64);
                emit_serial_data(&app, buf[..n].to_vec(), true);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn cleanup_and_close(state: &NetState, app: &tauri::AppHandle) {
    *state.io.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *state.remote.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.connected.store(false, Ordering::SeqCst);
    let _ = app.emit("port-closed", ());
    set_conn_state(state, ConnState::Closed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_host_port() {
        let addr = resolve("127.0.0.1", 8080).unwrap();
        assert_eq!(addr, "127.0.0.1:8080".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn resolve_failure_returns_error() {
        assert!(resolve("no.such.host.invalid", 80).is_err());
    }
}
