use crate::net_cmd;
use crate::serial_cmd;
use crate::state::{NetIo, NetState, SerialState, MODE_SERIAL};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};

pub const MODE_SSH: u8 = 5;
pub const MODE_MAX: u8 = MODE_SSH;

pub fn validate_mode(mode: u8) -> bool {
    (MODE_SERIAL..=MODE_MAX).contains(&mode)
}

const IO_STATS_INTERVAL: Duration = Duration::from_millis(250);

/// 收发字节计数：连接管线上的非侵入装饰（计数 + 节流 io-stats 事件内聚）。
/// 兄弟连接（串口/TCP/UDP/未来 SSH）共享同一实例；`info()` 与前端状态栏
/// 均从它取值，清空按钮经 `reset_and_emit` 联动归零。
pub struct Meter {
    tx: AtomicU64,
    rx: AtomicU64,
    app: StdMutex<Option<tauri::AppHandle>>,
    last_emit: StdMutex<Instant>,
}

impl Default for Meter {
    fn default() -> Self {
        Self {
            tx: AtomicU64::new(0),
            rx: AtomicU64::new(0),
            app: StdMutex::new(None),
            last_emit: StdMutex::new(Instant::now()),
        }
    }
}

impl Meter {
    pub fn attach(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }

    pub fn tx(&self) -> u64 {
        self.tx.load(Ordering::SeqCst)
    }

    pub fn rx(&self) -> u64 {
        self.rx.load(Ordering::SeqCst)
    }

    pub fn add_tx(&self, n: u64) {
        self.tx.fetch_add(n, Ordering::SeqCst);
        self.maybe_emit();
    }

    pub fn add_rx(&self, n: u64) {
        self.rx.fetch_add(n, Ordering::SeqCst);
        self.maybe_emit();
    }

    pub fn reset(&self) {
        self.tx.store(0, Ordering::SeqCst);
        self.rx.store(0, Ordering::SeqCst);
    }

    /// 清零并立即发射一次 io-stats（清除按钮联动：前端状态栏即刻归零）。
    pub fn reset_and_emit(&self) {
        self.reset();
        self.emit_now();
    }

    fn maybe_emit(&self) {
        let mut last = self.last_emit.lock().unwrap_or_else(|e| e.into_inner());
        if last.elapsed() >= IO_STATS_INTERVAL {
            *last = Instant::now();
            drop(last);
            self.emit_now();
        }
    }

    fn emit_now(&self) {
        let app = self.app.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(app) = app.as_ref() {
            let _ = app.emit(
                "io-stats",
                serde_json::json!({ "tx": self.tx(), "rx": self.rx() }),
            );
        }
    }
}

/// 读装饰器：read 通过它自动计数，连接实现无需感知计数逻辑。
pub struct MeteredReader<R> {
    inner: R,
    meter: Arc<Meter>,
}

impl<R> MeteredReader<R> {
    pub fn new(inner: R, meter: Arc<Meter>) -> Self {
        Self { inner, meter }
    }
}

impl<R: Read> Read for MeteredReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.meter.add_rx(n as u64);
        Ok(n)
    }
}

/// 工具独占闸门：插件（Lua）运行期间持有锁，主读循环停车、收发被禁。
pub struct ToolGate {
    lock: AsyncMutex<()>,
}

impl Default for ToolGate {
    fn default() -> Self {
        Self {
            lock: AsyncMutex::new(()),
        }
    }
}

impl ToolGate {
    pub fn is_busy(&self) -> bool {
        self.lock.try_lock().is_err()
    }

    /// 工具（P2 Lua 插件）运行期间持有锁。
    #[allow(dead_code)]
    pub fn try_acquire(&self) -> Result<AsyncMutexGuard<'_, ()>, ()> {
        self.lock.try_lock().map_err(|_| ())
    }

    #[allow(dead_code)]
    pub async fn acquire(&self) -> AsyncMutexGuard<'_, ()> {
        self.lock.lock().await
    }
}

/// 兄弟连接：Serial / Net（TCP、UDP 各模式共用一个 Net 实现）/ Ssh。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Conn {
    Serial,
    Net,
    Ssh,
}

#[derive(Clone, Default)]
pub struct ConnParams {
    pub mode: u8,
    pub path: Option<String>,
    pub baud: Option<u32>,
    pub char_size: Option<u8>,
    pub stop_bits: Option<u8>,
    pub parity: Option<String>,
    pub flow_control: Option<String>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub local_port: Option<u16>,
}

/// 连接层统一入口：单一分发点 + 统一互斥 + 三通道互斥 + 工具闸门。
#[derive(Clone)]
pub struct ConnHandle {
    pub serial: Arc<SerialState>,
    pub net: Arc<NetState>,
    pub ssh: Arc<crate::ssh_cmd::SshState>,
    pub op_lock: Arc<AsyncMutex<()>>,
    pub tool: Arc<ToolGate>,
    pub meter: Arc<Meter>,
}

impl ConnHandle {
    pub fn new(
        serial: Arc<SerialState>,
        net: Arc<NetState>,
        ssh: Arc<crate::ssh_cmd::SshState>,
        op_lock: Arc<AsyncMutex<()>>,
        tool: Arc<ToolGate>,
        meter: Arc<Meter>,
    ) -> Self {
        Self {
            serial,
            net,
            ssh,
            op_lock,
            tool,
            meter,
        }
    }

    /// 注入 AppHandle 供 Meter 发射 io-stats 事件（setup 时调用；单测跳过）。
    pub fn attach(&self, app: tauri::AppHandle) {
        self.meter.attach(app);
    }

    pub fn active(&self) -> Conn {
        match self.net.mode.load(Ordering::SeqCst) {
            MODE_SERIAL => Conn::Serial,
            MODE_SSH => Conn::Ssh,
            _ => Conn::Net,
        }
    }

    fn ensure_idle(&self) -> Result<(), String> {
        if self.serial.connected.load(Ordering::SeqCst) {
            return Err("Serial port is open, close it first".into());
        }
        if self.net.connected.load(Ordering::SeqCst) {
            return Err("Network connection is open, close it first".into());
        }
        if self.ssh.connected.load(Ordering::SeqCst) {
            return Err("SSH connection is open, close it first".into());
        }
        Ok(())
    }

    /// SSH 连接专用入口（认证参数不同，不走 ConnParams）。
    pub async fn open_ssh(
        &self,
        app: &tauri::AppHandle,
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        key_path: Option<&str>,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        self.ensure_idle()?;
        crate::ssh_cmd::ssh_connect_inner(self, app, host, port, user, password, key_path, cols, rows).await
    }

    pub async fn open(&self, app: &tauri::AppHandle, params: ConnParams) -> Result<(), String> {
        let _guard = self.op_lock.lock().await;
        if self.tool.is_busy() {
            return Err("Tool is running, close it first".into());
        }
        match params.mode {
            MODE_SERIAL => {
                if self.serial.connected.load(Ordering::SeqCst) {
                    return Err("Port already open".into());
                }
                if self.net.connected.load(Ordering::SeqCst) {
                    return Err("Network connection is open, close it first".into());
                }
                if self.ssh.connected.load(Ordering::SeqCst) {
                    return Err("SSH connection is open, close it first".into());
                }
                self.net.mode.store(MODE_SERIAL, Ordering::SeqCst);
                let path = params.path.as_deref().ok_or("Port path required")?;
                let baud = params.baud.unwrap_or(115200);
                let char_size = params.char_size.unwrap_or(8);
                let stop_bits = params.stop_bits.unwrap_or(1);
                let parity = params.parity.unwrap_or_else(|| "none".to_string());
                let flow_control = params.flow_control.unwrap_or_else(|| "none".to_string());
                serial_cmd::open_port_inner(
                    &self.serial,
                    app,
                    path,
                    baud,
                    char_size,
                    stop_bits,
                    &parity,
                    &flow_control,
                )
                .await
            }
            mode if validate_mode(mode) && mode != MODE_SSH => {
                if self.net.connected.load(Ordering::SeqCst) {
                    return Err("Connection already open".into());
                }
                if self.serial.connected.load(Ordering::SeqCst) {
                    return Err("Serial port is open, close it first".into());
                }
                if self.ssh.connected.load(Ordering::SeqCst) {
                    return Err("SSH connection is open, close it first".into());
                }
                self.net.mode.store(mode, Ordering::SeqCst);
                net_cmd::net_open_inner(
                    &self.net,
                    app,
                    mode,
                    params.remote_host,
                    params.remote_port,
                    params.local_port,
                )
                .await
            }
            _ => Err("Unknown connection mode".into()),
        }
    }

    pub async fn close(&self, target: Conn) -> Result<(), String> {
        let _guard = self.op_lock.lock().await;
        if self.tool.is_busy() {
            return Err("Tool is running, cannot close".into());
        }
        match target {
            Conn::Serial => serial_cmd::close_port_inner(&self.serial).await,
            Conn::Net => net_cmd::net_close_inner(&self.net).await,
            Conn::Ssh => crate::ssh_cmd::ssh_disconnect_inner(&self.ssh).await,
        }
    }

    pub async fn send(&self, bytes: &[u8]) -> Result<(), String> {
        if self.tool.is_busy() {
            return Err("Tool is running, sending disabled".into());
        }
        self.meter.add_tx(bytes.len() as u64);
        match self.active() {
            Conn::Serial => {
                if !self.serial.connected.load(Ordering::SeqCst) {
                    return Err("Port not open".into());
                }
                let mut port = self.serial.port.lock().unwrap_or_else(|e| e.into_inner());
                let port = port.as_mut().ok_or("Port not open")?;
                port.write_all(bytes)
                    .map_err(|e| format!("Write error: {}", e))?;
                port.flush().map_err(|e| format!("Flush error: {}", e))?;
                Ok(())
            }
            Conn::Net => net_cmd::net_send_bytes(&self.net, bytes).await,
            Conn::Ssh => {
                if !self.ssh.connected.load(Ordering::SeqCst) {
                    return Err("SSH not connected".into());
                }
                let write = self.ssh.write.lock().await;
                match write.as_ref() {
                    Some(w) => w
                        .data_bytes(bytes.to_vec())
                        .await
                        .map_err(|e| format!("SSH send error: {}", e))?,
                    None => return Err("SSH channel not ready".into()),
                }
                Ok(())
            }
        }
    }

    /// 字节级带超时读（工具专用；TimedOut/WouldBlock 返回 0）。P2 起由 Lua 插件使用。
    #[allow(dead_code)]
    pub async fn read(&self, buf: &mut [u8], timeout: Duration) -> Result<usize, String> {
        match self.active() {
            Conn::Serial => {
                let mut port = {
                    let p = self.serial.port.lock().unwrap_or_else(|e| e.into_inner());
                    match p.as_ref().and_then(|p| p.try_clone().ok()) {
                        Some(p) => p,
                        None => return Err("Port not open".into()),
                    }
                };
                port.set_read_timeout(timeout).ok();
                match port.read(buf) {
                    Ok(n) => {
                        self.meter.add_rx(n as u64);
                        Ok(n)
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        Ok(0)
                    }
                    Err(e) => Err(format!("Read error: {}", e)),
                }
            }
            Conn::Net => {
                let io = self.net.io.lock().unwrap_or_else(|e| e.into_inner());
                match io.as_ref() {
                    Some(NetIo::Stream(s)) => {
                        let mut s =
                            s.try_clone().map_err(|e| format!("Read error: {}", e))?;
                        s.set_read_timeout(Some(timeout)).ok();
                        match s.read(buf) {
                            Ok(n) => {
                                self.meter.add_rx(n as u64);
                                Ok(n)
                            }
                            Err(ref e)
                                if e.kind() == std::io::ErrorKind::TimedOut
                                    || e.kind() == std::io::ErrorKind::WouldBlock =>
                            {
                                Ok(0)
                            }
                            Err(e) => Err(format!("Read error: {}", e)),
                        }
                    }
                    Some(NetIo::Datagram { sock, .. }) => {
                        let sock =
                            sock.try_clone().map_err(|e| format!("Read error: {}", e))?;
                        sock.set_read_timeout(Some(timeout)).ok();
                        match sock.recv(buf) {
                            Ok(n) => {
                                self.meter.add_rx(n as u64);
                                Ok(n)
                            }
                            Err(ref e)
                                if e.kind() == std::io::ErrorKind::TimedOut
                                    || e.kind() == std::io::ErrorKind::WouldBlock =>
                            {
                                Ok(0)
                            }
                            Err(e) => Err(format!("Read error: {}", e)),
                        }
                    }
                    None => Err("Connection not open".into()),
                }
            }
            Conn::Ssh => Err("SSH 通道不支持字节级读".into()),
        }
    }

    /// 串口 DTR 控制（网络模式 no-op）。P2 起由 Lua 插件使用。
    #[allow(dead_code)]
    pub fn set_dtr(&self, on: bool) -> Result<(), String> {
        match self.active() {
            Conn::Serial => {
                let port = {
                    let p = self.serial.port.lock().unwrap_or_else(|e| e.into_inner());
                    match p.as_ref().and_then(|p| p.try_clone().ok()) {
                        Some(p) => p,
                        None => return Err("Port not open".into()),
                    }
                };
                port.set_dtr(on).map_err(|e| format!("set_dtr error: {}", e))
            }
            Conn::Net | Conn::Ssh => Ok(()),
        }
    }

    /// 串口 RTS 控制（网络模式 no-op）。P2 起由 Lua 插件使用。
    #[allow(dead_code)]
    pub fn set_rts(&self, on: bool) -> Result<(), String> {
        match self.active() {
            Conn::Serial => {
                let port = {
                    let p = self.serial.port.lock().unwrap_or_else(|e| e.into_inner());
                    match p.as_ref().and_then(|p| p.try_clone().ok()) {
                        Some(p) => p,
                        None => return Err("Port not open".into()),
                    }
                };
                port.set_rts(on).map_err(|e| format!("set_rts error: {}", e))
            }
            Conn::Net | Conn::Ssh => Ok(()),
        }
    }

    pub async fn info(&self) -> serde_json::Value {
        match self.active() {
            Conn::Serial => self.serial.to_serial_info().await,
            Conn::Net => self.net.to_net_info().await,
            Conn::Ssh => self.ssh.info(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MODE_TCP_CLIENT, MODE_TCP_SERVER, MODE_UDP_CLIENT, MODE_UDP_SERVER};
    use std::io::Cursor;

    fn test_states() -> (Arc<NetState>, Arc<SerialState>, Arc<ConnHandle>, Arc<Meter>) {
        let tool = Arc::new(ToolGate::default());
        let meter = Arc::new(Meter::default());
        let net = NetState::new(tool.clone(), meter.clone());
        let serial = SerialState::new_with_net(net.clone());
        let op_lock = Arc::new(AsyncMutex::new(()));
        let ssh = Arc::new(crate::ssh_cmd::SshState::new(op_lock.clone(), meter.clone()));
        let handle = ConnHandle::new(
            Arc::new(serial.clone()),
            Arc::new(net.clone()),
            ssh,
            op_lock,
            tool,
            meter.clone(),
        );
        (Arc::new(net), Arc::new(serial), Arc::new(handle), meter)
    }

    #[test]
    fn validate_mode_accepts_known_modes() {
        assert!(validate_mode(MODE_SERIAL));
        assert!(validate_mode(MODE_TCP_CLIENT));
        assert!(validate_mode(MODE_TCP_SERVER));
        assert!(validate_mode(MODE_UDP_CLIENT));
        assert!(validate_mode(MODE_UDP_SERVER));
        assert!(validate_mode(MODE_SSH));
        assert!(!validate_mode(6));
        assert!(!validate_mode(255));
    }

    #[test]
    fn tool_gate_busy_flag() {
        let gate = ToolGate::default();
        assert!(!gate.is_busy());
        let _g = gate.try_acquire().unwrap();
        assert!(gate.is_busy());
        drop(_g);
        assert!(!gate.is_busy());
    }

    #[test]
    fn active_maps_mode_to_conn() {
        let (net, _, handle, _) = test_states();
        assert_eq!(handle.active(), Conn::Serial);
        net.mode.store(MODE_TCP_CLIENT, Ordering::SeqCst);
        assert_eq!(handle.active(), Conn::Net);
        net.mode.store(MODE_UDP_SERVER, Ordering::SeqCst);
        assert_eq!(handle.active(), Conn::Net);
        net.mode.store(MODE_SSH, Ordering::SeqCst);
        assert_eq!(handle.active(), Conn::Ssh);
    }

    #[test]
    fn meter_counts_and_resets() {
        let m = Meter::default();
        m.add_tx(10);
        m.add_rx(5);
        assert_eq!(m.tx(), 10);
        assert_eq!(m.rx(), 5);
        m.reset();
        assert_eq!(m.tx(), 0);
        assert_eq!(m.rx(), 0);
        m.add_tx(2);
        assert_eq!(m.tx(), 2);
    }

    #[test]
    fn metered_reader_counts_read_bytes() {
        let meter = Arc::new(Meter::default());
        let mut reader = MeteredReader::new(Cursor::new(vec![1u8, 2, 3, 4, 5]), meter.clone());
        let mut buf = [0u8; 3];
        assert_eq!(reader.read(&mut buf).unwrap(), 3);
        assert_eq!(meter.rx(), 3);
        assert_eq!(reader.read(&mut buf).unwrap(), 2);
        assert_eq!(meter.rx(), 5);
        assert_eq!(reader.read(&mut buf).unwrap(), 0);
        assert_eq!(meter.rx(), 5);
    }
}
