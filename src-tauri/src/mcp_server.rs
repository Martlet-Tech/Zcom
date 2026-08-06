use crate::receive_buffer::ReceiveBuffer;
use crate::serial_cmd;
use axum::{
    extract::State,
    http::StatusCode,
    routing::post,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{oneshot, Mutex};

pub struct McpServerHandle {
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    join_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    running: Arc<Mutex<bool>>,
    port: Arc<Mutex<u16>>,
}

impl McpServerHandle {
    pub fn new() -> Self {
        Self {
            shutdown_tx: Arc::new(Mutex::new(None)),
            join_handle: Arc::new(Mutex::new(None)),
            running: Arc::new(Mutex::new(false)),
            port: Arc::new(Mutex::new(9876)),
        }
    }
}

struct AppState {
    buffer: ReceiveBuffer,
    conn: crate::conn::ConnHandle,
    esp: crate::esp_cmd::EspHandle,
    app_handle: tauri::AppHandle,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            buffer: self.buffer.clone(),
            conn: self.conn.clone(),
            esp: self.esp.clone(),
            app_handle: self.app_handle.clone(),
        }
    }
}

fn jsonrpc_error(code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "error": { "code": code, "message": message },
        "id": null,
    })
}

fn jsonrpc_success(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "result": result,
        "id": id,
    })
}

async fn handle_initialize(body: &Value, id: Value) -> (StatusCode, Json<Value>) {
    let version = body["params"]["protocolVersion"]
        .as_str()
        .unwrap_or("2025-03-26");

    let resp = jsonrpc_success(id, json!({
        "protocolVersion": version,
        "capabilities": {
            "resources": {},
            "tools": {}
        },
        "serverInfo": {
            "name": "zcom-mcp",
            "version": "0.1.0"
        }
    }));
    (StatusCode::OK, Json(resp))
}

async fn handle_resources_list(id: Value) -> (StatusCode, Json<Value>) {
    let resp = jsonrpc_success(id, json!({
        "resources": [
            {
                "uri": "serial://receive/content",
                "name": "接收区内容",
                "description": "串口助手的全部接收数据",
                "mimeType": "text/plain"
            },
            {
                "uri": "serial://port",
                "name": "串口状态",
                "description": "当前串口连接状态信息",
                "mimeType": "application/json"
            }
        ]
    }));
    (StatusCode::OK, Json(resp))
}

async fn handle_resources_read(state: &AppState, body: &Value, id: Value) -> (StatusCode, Json<Value>) {
    let uri = body["params"]["uri"].as_str().unwrap_or("");

    match uri {
        "serial://receive/content" => {
            let lines = state.buffer.read_all().await;
            let text = lines.join("\n");
            let resp = jsonrpc_success(id, json!({
                "contents": [{
                    "uri": "serial://receive/content",
                    "mimeType": "text/plain",
                    "text": text
                }]
            }));
            (StatusCode::OK, Json(resp))
        }
        "serial://port" => {
            let info = state.conn.info().await;
            let resp = jsonrpc_success(id, json!({
                "contents": [{
                    "uri": "serial://port",
                    "mimeType": "application/json",
                    "text": info.to_string()
                }]
            }));
            (StatusCode::OK, Json(resp))
        }
        _ => {
            let resp = jsonrpc_error(-32602, &format!("Resource not found: {}", uri));
            (StatusCode::NOT_FOUND, Json(resp))
        }
    }
}

async fn handle_tools_list(id: Value) -> (StatusCode, Json<Value>) {
    let resp = jsonrpc_success(id, json!({
        "tools": [
            {
                "name": "get_receive_content",
                "description": "获取串口接收到的全部文本数据",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "get_port_status",
                "description": "获取当前串口连接状态",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "send_serial_data",
                "description": "通过串口发送数据",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "要发送的文本"
                        },
                        "encoding": {
                            "type": "string",
                            "description": "编码方式: utf-8 或 gbk",
                            "default": "utf-8"
                        }
                    },
                    "required": ["text"]
                }
            },
            {
                "name": "clear_receive",
                "description": "清空接收区",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "esp_build_flash",
                "description": "对 ESP-IDF 项目执行 build + flash(等同于主界面的火焰按钮),完成后芯片自动复位运行",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project_dir": {
                            "type": "string",
                            "description": "ESP-IDF 项目根目录(含 CMakeLists.txt)"
                        },
                        "port": {
                            "type": "string",
                            "description": "串口, 缺省用当前选中的串口",
                            "default": ""
                        },
                        "baud": {
                            "type": "integer",
                            "description": "烧录波特率, 缺省用设置里的值",
                            "default": 0
                        }
                    },
                    "required": ["project_dir"]
                }
            }
        ]
    }));
    (StatusCode::OK, Json(resp))
}

async fn handle_tools_call(state: &AppState, body: &Value, id: Value) -> (StatusCode, Json<Value>) {
    let tool_name = body["params"]["name"].as_str().unwrap_or("");
    let args = body["params"]["arguments"].as_object().cloned().unwrap_or_default();

    match tool_name {
        "get_receive_content" => {
            let lines = state.buffer.read_all().await;
            let text = lines.join("\n");
            let resp = jsonrpc_success(id, json!({
                "content": [{
                    "type": "text",
                    "text": text
                }]
            }));
            (StatusCode::OK, Json(resp))
        }
        "get_port_status" => {
            let info = state.conn.info().await;
            let resp = jsonrpc_success(id, json!({
                "content": [{
                    "type": "text",
                    "text": info.to_string()
                }]
            }));
            (StatusCode::OK, Json(resp))
        }
        "send_serial_data" => {
            let text = args.get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let encoding = args.get("encoding")
                .and_then(|v| v.as_str())
                .unwrap_or("utf-8");

            if text.is_empty() {
                let resp = jsonrpc_error(-32602, "text cannot be empty");
                return (StatusCode::BAD_REQUEST, Json(resp));
            }

            match serial_cmd::send_data_internal(
                &state.conn,
                text.to_string(),
                false,
                Some(encoding.to_string()),
            ).await {
                Ok(hex) => {
                    let resp = jsonrpc_success(id, json!({
                        "content": [{
                            "type": "text",
                            "text": format!("已发送: {}", hex)
                        }]
                    }));
                    (StatusCode::OK, Json(resp))
                }
                Err(e) => {
                    let resp = jsonrpc_error(-32603, &format!("发送失败: {}", e));
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(resp))
                }
            }
        }
        "clear_receive" => {
            let _ = state.app_handle.emit("clear-receive", ());
            let resp = jsonrpc_success(id, json!({
                "content": [{
                    "type": "text",
                    "text": "接收区已清空"
                }]
            }));
            (StatusCode::OK, Json(resp))
        }
        "esp_build_flash" => {
            let project_dir = args.get("project_dir")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let port = args.get("port")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let baud = args.get("baud").and_then(|v| v.as_u64()).map(|v| v as u32);

            if project_dir.is_empty() {
                let resp = jsonrpc_error(-32602, "project_dir cannot be empty");
                return (StatusCode::BAD_REQUEST, Json(resp));
            }

            let cfg = {
                let c = state.esp.config.lock().unwrap_or_else(|e| e.into_inner());
                crate::esp_cmd::EspConfig {
                    idf_path: c.idf_path.clone(),
                    python_path: c.python_path.clone(),
                    baud: baud.unwrap_or(c.baud),
                }
            };
            if cfg.idf_path.trim().is_empty() {
                let resp = jsonrpc_error(-32603, "ESP-IDF 路径未配置, 请先在系统设置里填写");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(resp));
            }

            {
                let mut busy = state.esp.busy.lock().unwrap_or_else(|e| e.into_inner());
                if *busy {
                    let resp = jsonrpc_error(-32603, "已有烧录任务在运行");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(resp));
                }
                *busy = true;
            }

            let esp = state.esp.clone();
            let app_handle = state.app_handle.clone();
            let serial_name = state
                .conn
                .serial
                .port_name
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .unwrap_or_default();
            let port = if port.is_empty() { serial_name } else { port };
            let result = tokio::task::spawn_blocking(move || {
                let r = crate::esp_cmd::run_worker(&esp, &app_handle, &cfg, &project_dir, &port);
                let mut busy = esp.busy.lock().unwrap_or_else(|e| e.into_inner());
                *busy = false;
                r
            })
            .await;

            match result {
                Ok(Ok(())) => {
                    let resp = jsonrpc_success(id, json!({
                        "content": [{
                            "type": "text",
                            "text": "build + flash 成功, 芯片已复位运行"
                        }]
                    }));
                    (StatusCode::OK, Json(resp))
                }
                Ok(Err(e)) => {
                    let resp = jsonrpc_error(-32603, &format!("烧录失败: {}", e));
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(resp))
                }
                Err(e) => {
                    let resp = jsonrpc_error(-32603, &format!("任务异常: {}", e));
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(resp))
                }
            }
        }
        _ => {
            let resp = jsonrpc_error(-32602, &format!("Tool not found: {}", tool_name));
            (StatusCode::NOT_FOUND, Json(resp))
        }
    }
}

async fn handle_mcp(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let method = body["method"].as_str().unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => handle_initialize(&body, id).await,
        "resources/list" => handle_resources_list(id).await,
        "resources/read" => handle_resources_read(&state, &body, id).await,
        "tools/list" => handle_tools_list(id).await,
        "tools/call" => handle_tools_call(&state, &body, id).await,
        "ping" => {
            let resp = jsonrpc_success(id, json!({}));
            (StatusCode::OK, Json(resp))
        }
        "notifications/initialized" => {
            (StatusCode::ACCEPTED, Json(Value::Null))
        }
        _ => {
            let resp = jsonrpc_error(-32601, &format!("Method not found: {}", method));
            (StatusCode::NOT_FOUND, Json(resp))
        }
    }
}

#[tauri::command]
pub async fn mcp_start(
    app_handle: tauri::AppHandle,
    handle: tauri::State<'_, McpServerHandle>,
    buffer: tauri::State<'_, ReceiveBuffer>,
    conn: tauri::State<'_, crate::conn::ConnHandle>,
    esp: tauri::State<'_, crate::esp_cmd::EspHandle>,
    port: u16,
) -> Result<(), String> {
    let mut running = handle.running.lock().await;
    if *running {
        return Err("MCP server already running".into());
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let state = AppState {
        buffer: (*buffer).clone(),
        conn: (*conn).clone(),
        esp: (*esp).clone(),
        app_handle: app_handle.clone(),
    };

    let app = axum::Router::new()
        .route("/mcp", post(handle_mcp))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await
        .map_err(|e| format!("Failed to bind {}: {}", addr, e))?;

    let jh = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async { shutdown_rx.await.ok(); })
            .await
            .ok();
    });

    *handle.shutdown_tx.lock().await = Some(shutdown_tx);
    *handle.join_handle.lock().await = Some(jh);
    *handle.port.lock().await = port;
    *running = true;

    Ok(())
}

#[tauri::command]
pub async fn mcp_stop(
    handle: tauri::State<'_, McpServerHandle>,
) -> Result<(), String> {
    let mut running = handle.running.lock().await;
    if !*running {
        return Ok(());
    }

    if let Some(tx) = handle.shutdown_tx.lock().await.take() {
        let _ = tx.send(());
    }
    if let Some(jh) = handle.join_handle.lock().await.take() {
        let _ = jh.await;
    }

    *running = false;
    Ok(())
}

#[tauri::command]
pub async fn mcp_get_status(
    handle: tauri::State<'_, McpServerHandle>,
) -> Result<serde_json::Value, String> {
    let running = *handle.running.lock().await;
    let port = *handle.port.lock().await;
    Ok(serde_json::json!({
        "running": running,
        "port": port,
    }))
}
