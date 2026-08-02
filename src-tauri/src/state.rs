use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

pub const MODE_SERIAL: u8 = 0;
pub const MODE_TCP_CLIENT: u8 = 1;
pub const MODE_TCP_SERVER: u8 = 2;
pub const MODE_UDP_CLIENT: u8 = 3;
pub const MODE_UDP_SERVER: u8 = 4;

pub enum NetIo {
    Stream(std::net::TcpStream),
    Datagram {
        sock: std::net::UdpSocket,
        peer: Mutex<Option<SocketAddr>>,
    },
}

pub struct NetState {
    pub io: Arc<Mutex<Option<NetIo>>>,
    pub local: Arc<Mutex<Option<String>>>,
    pub remote: Arc<Mutex<Option<String>>>,
    pub tx_bytes: Arc<AtomicU64>,
    pub rx_bytes: Arc<AtomicU64>,
    pub connected: Arc<AtomicBool>,
    pub stop_reading: Arc<AtomicBool>,
    pub op_lock: Arc<AsyncMutex<()>>,
    pub mode: Arc<AtomicU8>,
    pub auto_reconnect: Arc<AtomicBool>,
    pub reconnect_interval_ms: Arc<AtomicU32>,
    pub generation: Arc<AtomicU32>,
    pub conn: Arc<ConnCore>,
}

impl Clone for NetState {
    fn clone(&self) -> Self {
        self.inner_clone()
    }
}

impl NetState {
    pub fn new() -> Self {
        Self {
            io: Arc::new(Mutex::new(None)),
            local: Arc::new(Mutex::new(None)),
            remote: Arc::new(Mutex::new(None)),
            tx_bytes: Arc::new(AtomicU64::new(0)),
            rx_bytes: Arc::new(AtomicU64::new(0)),
            connected: Arc::new(AtomicBool::new(false)),
            stop_reading: Arc::new(AtomicBool::new(true)),
            op_lock: Arc::new(AsyncMutex::new(())),
            mode: Arc::new(AtomicU8::new(MODE_SERIAL)),
            auto_reconnect: Arc::new(AtomicBool::new(true)),
            reconnect_interval_ms: Arc::new(AtomicU32::new(1000)),
            generation: Arc::new(AtomicU32::new(0)),
            conn: Arc::new(ConnCore::default()),
        }
    }

    pub fn inner_clone(&self) -> Self {
        Self {
            io: self.io.clone(),
            local: self.local.clone(),
            remote: self.remote.clone(),
            tx_bytes: self.tx_bytes.clone(),
            rx_bytes: self.rx_bytes.clone(),
            connected: self.connected.clone(),
            stop_reading: self.stop_reading.clone(),
            op_lock: self.op_lock.clone(),
            mode: self.mode.clone(),
            auto_reconnect: self.auto_reconnect.clone(),
            reconnect_interval_ms: self.reconnect_interval_ms.clone(),
            generation: self.generation.clone(),
            conn: self.conn.clone(),
        }
    }
}

pub struct LocaleState(pub std::sync::Mutex<String>);

impl Default for LocaleState {
    fn default() -> Self {
        Self(std::sync::Mutex::new("zh-CN".to_string()))
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ConnState {
    Closed,
    Reading,
    Reconnecting,
}

pub struct ConnCore {
    pub state: std::sync::Mutex<ConnState>,
    pub wake: std::sync::Condvar,
}

impl Default for ConnCore {
    fn default() -> Self {
        Self {
            state: std::sync::Mutex::new(ConnState::Closed),
            wake: std::sync::Condvar::new(),
        }
    }
}

pub struct SerialState {
    pub port: Arc<Mutex<Option<serial2::SerialPort>>>,
    pub port_name: Arc<Mutex<Option<String>>>,
    pub baud_rate: Arc<AtomicU32>,
    pub suppress_close_event: Arc<AtomicBool>,
    pub stop_reading: Arc<AtomicBool>,
    pub tx_bytes: Arc<AtomicU64>,
    pub rx_bytes: Arc<AtomicU64>,
    pub connected: Arc<AtomicBool>,
    pub op_lock: Arc<AsyncMutex<()>>,
    pub char_size: Arc<AtomicU8>,
    pub stop_bits: Arc<AtomicU8>,
    pub parity: Arc<AsyncMutex<String>>,
    pub flow_control: Arc<AsyncMutex<String>>,
    pub auto_reconnect: Arc<AtomicBool>,
    pub reconnect_interval_ms: Arc<AtomicU32>,
    pub generation: Arc<AtomicU32>,
    pub conn: Arc<ConnCore>,
    pub net: NetState,
}

impl Clone for SerialState {
    fn clone(&self) -> Self {
        self.inner_clone()
    }
}

use std::sync::atomic::Ordering;

impl SerialState {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::new_with_net(NetState::new())
    }

    pub fn new_with_net(net: NetState) -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            port_name: Arc::new(Mutex::new(None)),
            baud_rate: Arc::new(AtomicU32::new(115200)),
            suppress_close_event: Arc::new(AtomicBool::new(false)),
            stop_reading: Arc::new(AtomicBool::new(true)),
            tx_bytes: Arc::new(AtomicU64::new(0)),
            rx_bytes: Arc::new(AtomicU64::new(0)),
            connected: Arc::new(AtomicBool::new(false)),
            op_lock: Arc::new(AsyncMutex::new(())),
            char_size: Arc::new(AtomicU8::new(8)),
            stop_bits: Arc::new(AtomicU8::new(1)),
            parity: Arc::new(AsyncMutex::new("none".to_string())),
            flow_control: Arc::new(AsyncMutex::new("none".to_string())),
            auto_reconnect: Arc::new(AtomicBool::new(true)),
            reconnect_interval_ms: Arc::new(AtomicU32::new(1000)),
            generation: Arc::new(AtomicU32::new(0)),
            conn: Arc::new(ConnCore::default()),
            net,
        }
    }

    pub fn inner_clone(&self) -> Self {
        Self {
            port: self.port.clone(),
            port_name: self.port_name.clone(),
            baud_rate: self.baud_rate.clone(),
            suppress_close_event: self.suppress_close_event.clone(),
            stop_reading: self.stop_reading.clone(),
            tx_bytes: self.tx_bytes.clone(),
            rx_bytes: self.rx_bytes.clone(),
            connected: self.connected.clone(),
            op_lock: self.op_lock.clone(),
            char_size: self.char_size.clone(),
            stop_bits: self.stop_bits.clone(),
            parity: self.parity.clone(),
            flow_control: self.flow_control.clone(),
            auto_reconnect: self.auto_reconnect.clone(),
            reconnect_interval_ms: self.reconnect_interval_ms.clone(),
            generation: self.generation.clone(),
            conn: self.conn.clone(),
            net: self.net.clone(),
        }
    }

    pub async fn to_port_info(&self) -> serde_json::Value {
        if self.net.mode.load(Ordering::SeqCst) != MODE_SERIAL {
            let remote = self
                .net
                .remote
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_default();
            let local = self
                .net
                .local
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_default();
            return serde_json::json!({
                "mode": self.net.mode.load(Ordering::SeqCst),
                "name": remote,
                "local": local,
                "connected": self.net.connected.load(Ordering::SeqCst),
                "tx": self.net.tx_bytes.load(Ordering::SeqCst),
                "rx": self.net.rx_bytes.load(Ordering::SeqCst),
            });
        }
        let name = self.port_name.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
        let connected = self.connected.load(Ordering::SeqCst);
        let tx = self.tx_bytes.load(Ordering::SeqCst);
        let rx = self.rx_bytes.load(Ordering::SeqCst);
        serde_json::json!({
            "mode": MODE_SERIAL,
            "name": name,
            "connected": connected,
            "tx": tx,
            "rx": rx,
            "baud": self.baud_rate.load(Ordering::SeqCst),
            "dataBits": self.char_size.load(Ordering::SeqCst),
            "parity": self.parity.lock().await.clone(),
            "stopBits": self.stop_bits.load(Ordering::SeqCst),
        })
    }
}
