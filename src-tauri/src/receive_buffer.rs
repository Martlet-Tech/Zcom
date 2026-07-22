use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ReceiveBuffer {
    inner: Arc<Mutex<BufferInner>>,
}

struct BufferInner {
    lines: VecDeque<String>,
    max_lines: usize,
}

impl ReceiveBuffer {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BufferInner {
                lines: VecDeque::new(),
                max_lines: 100000,
            })),
        }
    }

    pub async fn push_lines(&self, new_lines: Vec<String>) {
        let mut inner = self.inner.lock().await;
        for line in new_lines {
            if inner.lines.len() >= inner.max_lines {
                inner.lines.pop_front();
            }
            inner.lines.push_back(line);
        }
    }

    pub async fn read_all(&self) -> Vec<String> {
        let inner = self.inner.lock().await;
        inner.lines.iter().cloned().collect()
    }

    pub async fn clear(&self) {
        let mut inner = self.inner.lock().await;
        inner.lines.clear();
    }
}

#[tauri::command]
pub async fn mcp_push_lines(
    buffer: tauri::State<'_, ReceiveBuffer>,
    lines: Vec<String>,
) -> Result<(), String> {
    buffer.push_lines(lines).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_clear_buffer(
    buffer: tauri::State<'_, ReceiveBuffer>,
) -> Result<(), String> {
    buffer.clear().await;
    Ok(())
}
