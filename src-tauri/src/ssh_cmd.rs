use crate::conn::{ConnHandle, Meter, MODE_SSH};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;

use russh::client;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::PrivateKeyWithHashAlg;
use russh::ChannelId;

const GAP_TIMEOUT: Duration = Duration::from_millis(5);
const HOST_KEY_PENDING: &str = "HOST_KEY_PENDING";
const FLUSH_CHUNK: usize = 4096;

/// SSH 连接状态（兄弟连接之一，独立持有；op_lock/tool/meter 与 ConnHandle 共享）。
/// 值管理（.manage(SshState)），命令以 State<'_, SshState> 提取；
/// Clone 为浅拷贝，所有字段 Arc 共享同一底层数据。
#[derive(Clone)]
pub struct SshState {
    /// 通道写半（发送 + resize）；tokio 锁以便跨 await 持有（发送/调整窗口）。
    pub write: Arc<AsyncMutex<Option<russh::ChannelWriteHalf<russh::client::Msg>>>>,
    /// 帧聚合缓冲（data 回调写入，5ms 空闲 flush）。
    pub acc: Arc<StdMutex<(Vec<u8>, Instant)>>,
    pub connected: Arc<AtomicBool>,
    pub stop_reading: Arc<AtomicBool>,
    pub suppress_close_event: Arc<AtomicBool>,
    /// 待用户确认的主机密钥 (host, port, fingerprint)。
    pub pending_key: Arc<StdMutex<Option<(String, u16, String)>>>,
    pub host: Arc<StdMutex<Option<String>>>,
    pub port: Arc<StdMutex<u16>>,
    pub op_lock: Arc<AsyncMutex<()>>,
    pub meter: Arc<Meter>,
}

impl SshState {
    pub fn new(op_lock: Arc<AsyncMutex<()>>, meter: Arc<Meter>) -> Self {
        Self {
            write: Arc::new(AsyncMutex::new(None)),
            acc: Arc::new(StdMutex::new((Vec::new(), Instant::now()))),
            connected: Arc::new(AtomicBool::new(false)),
            stop_reading: Arc::new(AtomicBool::new(true)),
            suppress_close_event: Arc::new(AtomicBool::new(false)),
            pending_key: Arc::new(StdMutex::new(None)),
            host: Arc::new(StdMutex::new(None)),
            port: Arc::new(StdMutex::new(22)),
            op_lock,
            meter,
        }
    }

    pub fn host_port(&self) -> String {
        let host = self
            .host
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_default();
        let port = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        format!("{}:{}", host, port)
    }

    pub fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "mode": MODE_SSH,
            "name": self.host_port(),
            "connected": self.connected.load(Ordering::SeqCst),
            "tx": self.meter.tx(),
            "rx": self.meter.rx(),
        })
    }
}

/// russh 客户端 handler：主机密钥校验 + 数据回调。
pub struct SshHandler {
    pub state: Arc<SshState>,
    pub app: tauri::AppHandle,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    /// 主机密钥闸门：known_hosts 命中放行；未知则发事件 + 拒绝密钥（连接中止，
    /// 等待用户确认后重连）。connect 返回 Error::UnknownKey 且 pending 已设置
    /// 时，命令层把它翻译为 HOST_KEY_PENDING。
    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, russh::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let host = self
            .state
            .host
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_default();
        let port = *self.state.port.lock().unwrap_or_else(|e| e.into_inner());
        if known_hosts_contains(&host, port, &fingerprint) {
            return Ok(true);
        }
        *self
            .state
            .pending_key
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some((host.clone(), port, fingerprint.clone()));
        let _ = self.app.emit(
            "ssh-host-key",
            serde_json::json!({ "host": host, "port": port, "fingerprint": fingerprint }),
        );
        Ok(false)
    }

    /// 服务端数据 → 帧聚合（5ms 空闲间隙语义与串口/TCP 一致）。
    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), russh::Error> {
        self.state.meter.add_rx(data.len() as u64);
        let mut guard = self.state.acc.lock().unwrap_or_else(|e| e.into_inner());
        guard.0.extend_from_slice(data);
        guard.1 = Instant::now();
        if guard.0.len() >= FLUSH_CHUNK {
            let chunk = std::mem::take(&mut guard.0);
            drop(guard);
            emit_serial_data(&self.app, chunk, false);
        }
        Ok(())
    }
}

pub(crate) async fn ssh_connect_inner(
    handle: &ConnHandle,
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    key_path: Option<&str>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let ssh = &handle.ssh;
    let _guard = ssh.op_lock.lock().await;
    if ssh.connected.load(Ordering::SeqCst) {
        return Err("SSH already connected".into());
    }
    if handle.tool.is_busy() {
        return Err("Tool is running, close it first".into());
    }
    handle.net.mode.store(MODE_SSH, Ordering::SeqCst);
    *ssh.host.lock().unwrap_or_else(|e| e.into_inner()) = Some(host.to_string());
    *ssh.port.lock().unwrap_or_else(|e| e.into_inner()) = port;
    *ssh.pending_key.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let mut config = client::Config::default();
    config.keepalive_interval = Some(Duration::from_secs(15));
    config.keepalive_max = 3;
    config.nodelay = true;
    let config = Arc::new(config);

    let handler = SshHandler {
        state: ssh.clone(),
        app: app.clone(),
    };
    let mut session = client::connect(config, (host, port), handler)
        .await
        .map_err(|e| {
            if matches!(e, russh::Error::UnknownKey)
                && ssh
                    .pending_key
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_some()
            {
                HOST_KEY_PENDING.to_string()
            } else {
                format!("连接 {}:{} 失败: {}", host, port, e)
            }
        })?;

    let auth_result = if !password.is_empty() {
        session
            .authenticate_password(user, password)
            .await
            .map_err(|e| format!("认证失败: {}", e))?
    } else if let Some(key) = key_path {
        if key.trim().is_empty() {
            return Err("需要密码或私钥路径".into());
        }
        let secret = russh::keys::load_secret_key(key.trim(), None)
            .map_err(|e| format!("私钥解析失败 ({}): {}", key, e))?;
        session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(secret), None))
            .await
            .map_err(|e| format!("私钥认证失败: {}", e))?
    } else {
        return Err("需要密码或私钥路径".into());
    };
    if !auth_result.success() {
        return Err("认证失败 (用户名/密码/密钥错误)".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开会话失败: {}", e))?;
    channel
        .request_pty(false, "xterm-256color", cols.max(2), rows.max(2), 0, 0, &[])
        .await
        .map_err(|e| format!("PTY 请求失败: {}", e))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("Shell 请求失败: {}", e))?;
    let (_read_half, write_half) = channel.split();
    *ssh.write.lock().await = Some(write_half);

    ssh.connected.store(true, Ordering::SeqCst);
    ssh.stop_reading.store(false, Ordering::SeqCst);
    ssh.suppress_close_event.store(false, Ordering::SeqCst);
    ssh.meter.reset();

    spawn_ssh_driver(app.clone(), ssh.clone(), session);
    Ok(())
}

/// 协议驱动任务：轮询 handle future（驱动收发）+ 5ms 空闲 flush。
fn spawn_ssh_driver(app: tauri::AppHandle, state: Arc<SshState>, mut session: client::Handle<SshHandler>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(GAP_TIMEOUT);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let mut f = std::pin::pin!(&mut session);
            tokio::select! {
                _ = &mut f => break,
                _ = interval.tick() => {}
            }
            drop(f);
            if state.stop_reading.load(Ordering::SeqCst) {
                break;
            }
            flush_if_idle(&state, &app);
        }
        // 收尾：清空残余帧 + 状态复位 + 断线事件
        let tail = {
            let mut guard = state.acc.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut guard.0)
        };
        if !tail.is_empty() {
            emit_serial_data(&app, tail, true);
        }
        state.connected.store(false, Ordering::SeqCst);
        state.stop_reading.store(true, Ordering::SeqCst);
        *state.write.lock().await = None;
        if !state.suppress_close_event.swap(false, Ordering::SeqCst) {
            let _ = app.emit("port-closed", ());
        }
    });
}

fn flush_if_idle(state: &SshState, app: &tauri::AppHandle) {
    let mut guard = state.acc.lock().unwrap_or_else(|e| e.into_inner());
    if guard.0.is_empty() {
        return;
    }
    if guard.1.elapsed() >= GAP_TIMEOUT {
        let data = std::mem::take(&mut guard.0);
        drop(guard);
        emit_serial_data(app, data, true);
    }
}

fn emit_serial_data(app: &tauri::AppHandle, data: Vec<u8>, frame_end: bool) {
    let _ = app.emit(
        "serial-data",
        serde_json::json!({ "bytes": data, "frameEnd": frame_end }),
    );
}

pub(crate) async fn ssh_disconnect_inner(ssh: &SshState) -> Result<(), String> {
    ssh.stop_reading.store(true, Ordering::SeqCst);
    ssh.suppress_close_event.store(true, Ordering::SeqCst);
    *ssh.write.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn ssh_connect(
    handle: tauri::State<'_, ConnHandle>,
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    handle
        .open_ssh(&app, &host, port, &user, &password, key_path.as_deref(), cols, rows)
        .await
}

#[tauri::command]
pub async fn ssh_disconnect(handle: tauri::State<'_, ConnHandle>) -> Result<(), String> {
    handle.close(crate::conn::Conn::Ssh).await
}

#[tauri::command]
pub async fn ssh_accept_host_key(
    ssh: tauri::State<'_, SshState>,
    fingerprint: String,
) -> Result<(), String> {
    let ssh = ssh.inner();
    let pending = ssh
        .pending_key
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match pending {
        Some((host, port, fp)) if fp == fingerprint => {
            known_hosts_add(&host, port, &fp)?;
            *ssh.pending_key.lock().unwrap_or_else(|e| e.into_inner()) = None;
            Ok(())
        }
        _ => Err("指纹不匹配或没有待确认的主机密钥".into()),
    }
}

#[tauri::command]
pub async fn ssh_resize(ssh: tauri::State<'_, SshState>, cols: u32, rows: u32) -> Result<(), String> {
    let ssh = ssh.inner();
    if !ssh.connected.load(Ordering::SeqCst) {
        return Ok(());
    }
    let write = ssh.write.lock().await;
    if let Some(w) = write.as_ref() {
        w.window_change(cols.max(2), rows.max(2), 0, 0)
            .await
            .map_err(|e| format!("resize 失败: {}", e))?;
    }
    Ok(())
}

// ===== known_hosts 持久化 =====

fn zcom_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".zcom")
}

fn known_hosts_path() -> PathBuf {
    zcom_dir().join("known_hosts")
}

fn host_line(host: &str, port: u16, fingerprint: &str) -> String {
    format!("{}:{} {}", host, port, fingerprint)
}

fn known_hosts_contains(host: &str, port: u16, fingerprint: &str) -> bool {
    known_hosts_contains_in(&known_hosts_path(), host, port, fingerprint)
}

fn known_hosts_contains_in(path: &std::path::Path, host: &str, port: u16, fingerprint: &str) -> bool {
    let target = host_line(host, port, fingerprint);
    match std::fs::read_to_string(path) {
        Ok(content) => content.lines().any(|l| l.trim() == target),
        Err(_) => false,
    }
}

fn known_hosts_add(host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
    known_hosts_add_in(&known_hosts_path(), host, port, fingerprint)
}

fn known_hosts_add_in(
    path: &std::path::Path,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), String> {
    let line = host_line(host, port, fingerprint);
    let dir = path.parent().ok_or("known_hosts 路径无效")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 {} 失败: {}", dir.display(), e))?;
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    use std::io::Write;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| writeln!(f, "{}", line))
        .map_err(|e| format!("写入 known_hosts 失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_hosts_roundtrip() {
        let dir = std::env::temp_dir().join(format!("zcom-kh-test-{}", std::process::id()));
        let path = dir.join("known_hosts");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!known_hosts_contains_in(&path, "1.2.3.4", 22, "SHA256:abc"));
        known_hosts_add_in(&path, "1.2.3.4", 22, "SHA256:abc").unwrap();
        assert!(known_hosts_contains_in(&path, "1.2.3.4", 22, "SHA256:abc"));
        assert!(!known_hosts_contains_in(&path, "1.2.3.4", 22, "SHA256:def"));
        assert!(!known_hosts_contains_in(&path, "1.2.3.4", 2200, "SHA256:abc"));
        // 幂等
        known_hosts_add_in(&path, "1.2.3.4", 22, "SHA256:abc").unwrap();
        let lines: Vec<String> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(lines.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_key_pending_error_contract() {
        assert_eq!(HOST_KEY_PENDING, "HOST_KEY_PENDING");
    }
}
