use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct SerialState {
    pub port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
    pub port_name: Arc<Mutex<Option<String>>>,
    pub read_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub stop_reading: Arc<AtomicBool>,
    pub tx_bytes: Arc<AtomicU64>,
    pub rx_bytes: Arc<AtomicU64>,
    pub connected: Arc<AtomicBool>,
    pub op_lock: Mutex<()>,
}

impl SerialState {
    pub fn new() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            port_name: Arc::new(Mutex::new(None)),
            read_handle: Arc::new(Mutex::new(None)),
            stop_reading: Arc::new(AtomicBool::new(true)),
            tx_bytes: Arc::new(AtomicU64::new(0)),
            rx_bytes: Arc::new(AtomicU64::new(0)),
            connected: Arc::new(AtomicBool::new(false)),
            op_lock: Mutex::new(()),
        }
    }
}
