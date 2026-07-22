use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct SerialState {
    pub port: Arc<Mutex<Option<serial2::SerialPort>>>,
    pub port_name: Arc<Mutex<Option<String>>>,
    pub baud_rate: Arc<AtomicU32>,
    pub suppress_close_event: Arc<AtomicBool>,
    pub read_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub stop_reading: Arc<AtomicBool>,
    pub tx_bytes: Arc<AtomicU64>,
    pub rx_bytes: Arc<AtomicU64>,
    pub connected: Arc<AtomicBool>,
    pub op_lock: Mutex<()>,
    pub char_size: Arc<AtomicU8>,
    pub stop_bits: Arc<AtomicU8>,
    pub parity: Arc<Mutex<String>>,
    pub flow_control: Arc<Mutex<String>>,
}

impl Clone for SerialState {
    fn clone(&self) -> Self {
        self.inner_clone()
    }
}

impl SerialState {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            port_name: Arc::new(Mutex::new(None)),
            baud_rate: Arc::new(AtomicU32::new(115200)),
            suppress_close_event: Arc::new(AtomicBool::new(false)),
            read_handle: Arc::new(Mutex::new(None)),
            stop_reading: Arc::new(AtomicBool::new(true)),
            tx_bytes: Arc::new(AtomicU64::new(0)),
            rx_bytes: Arc::new(AtomicU64::new(0)),
            connected: Arc::new(AtomicBool::new(false)),
            op_lock: Mutex::new(()),
            char_size: Arc::new(AtomicU8::new(8)),
            stop_bits: Arc::new(AtomicU8::new(1)),
            parity: Arc::new(Mutex::new("none".to_string())),
            flow_control: Arc::new(Mutex::new("none".to_string())),
        }
    }

    pub fn inner_clone(&self) -> Self {
        Self {
            port: self.port.clone(),
            port_name: self.port_name.clone(),
            baud_rate: self.baud_rate.clone(),
            suppress_close_event: self.suppress_close_event.clone(),
            read_handle: self.read_handle.clone(),
            stop_reading: self.stop_reading.clone(),
            tx_bytes: self.tx_bytes.clone(),
            rx_bytes: self.rx_bytes.clone(),
            connected: self.connected.clone(),
            op_lock: Mutex::new(()),
            char_size: self.char_size.clone(),
            stop_bits: self.stop_bits.clone(),
            parity: self.parity.clone(),
            flow_control: self.flow_control.clone(),
        }
    }
}
