use crate::state::SerialState;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

#[derive(Clone)]
pub struct EspConfig {
    pub idf_path: String,
    pub python_path: String,
    pub baud: u32,
}

#[derive(Clone)]
pub struct EspHandle {
    pub config: Arc<Mutex<EspConfig>>,
    pub child: Arc<Mutex<Option<Child>>>,
    pub busy: Arc<Mutex<bool>>,
}

impl Default for EspHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl EspHandle {
    pub fn new() -> Self {
        Self {
            config: Arc::new(Mutex::new(EspConfig {
                idf_path: String::new(),
                python_path: String::new(),
                baud: 921600,
            })),
            child: Arc::new(Mutex::new(None)),
            busy: Arc::new(Mutex::new(false)),
        }
    }
}

fn idf_py_path(idf_path: &str) -> PathBuf {
    Path::new(idf_path).join("tools").join("idf.py")
}

fn export_bat_path(idf_path: &str) -> PathBuf {
    Path::new(idf_path).join("export.bat")
}

fn build_script(cfg: &EspConfig, step_args: &[String]) -> String {
    let export = export_bat_path(&cfg.idf_path);
    if cfg.python_path.trim().is_empty() {
        format!(
            "call \"{}\" >nul 2>&1 && idf.py {}",
            export.to_string_lossy(),
            step_args.join(" ")
        )
    } else {
        let idf_py = idf_py_path(&cfg.idf_path);
        format!(
            "call \"{}\" >nul 2>&1 && \"{}\" \"{}\" {}",
            export.to_string_lossy(),
            cfg.python_path,
            idf_py.to_string_lossy(),
            step_args.join(" ")
        )
    }
}

#[derive(Clone, serde::Serialize)]
struct EspLogPayload {
    stage: String,
    line: String,
}

#[derive(Clone, serde::Serialize)]
struct EspDonePayload {
    ok: bool,
    stage: String,
}

fn emit_line(app: &tauri::AppHandle, stage: &str, line: &str) {
    let _ = app.emit(
        "esp-log",
        EspLogPayload {
            stage: stage.to_string(),
            line: line.to_string(),
        },
    );
}

fn emit_done(app: &tauri::AppHandle, ok: bool, stage: &str) {
    let _ = app.emit(
        "esp-done",
        EspDonePayload {
            ok,
            stage: stage.to_string(),
        },
    );
}

/// Runs one idf.py step (blocking). Returns:
/// - Ok(true)  success (exit 0)
/// - Ok(false) non-zero exit
/// - Err(msg)  spawn/wait failure
fn run_step(
    app: &tauri::AppHandle,
    handle: &EspHandle,
    cfg: &EspConfig,
    stage: &str,
    step_args: Vec<String>,
    cwd: &str,
) -> Result<bool, String> {
    let script = build_script(cfg, &step_args);
    let mut child = Command::new("cmd")
        .arg("/C")
        .arg(&script)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", stage, e))?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    *handle.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    if let Some(out) = stdout.take() {
        let reader = BufReader::new(out);
        for line in reader.lines() {
            if let Ok(l) = line {
                emit_line(app, stage, &l);
            }
        }
    }
    if let Some(err) = stderr.take() {
        let reader = BufReader::new(err);
        for line in reader.lines() {
            if let Ok(l) = line {
                emit_line(app, stage, &l);
            }
        }
    }

    let child = handle
        .child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let ok = match child {
        Some(mut c) => {
            let status = c.wait().map_err(|e| format!("Wait error: {}", e))?;
            status.success()
        }
        None => false,
    };
    Ok(ok)
}

#[tauri::command]
pub async fn set_esp_config(
    handle: tauri::State<'_, EspHandle>,
    idf_path: String,
    python_path: String,
    baud: u32,
) -> Result<(), String> {
    let mut cfg = handle.config.lock().unwrap_or_else(|e| e.into_inner());
    cfg.idf_path = idf_path;
    cfg.python_path = python_path;
    cfg.baud = if baud > 0 { baud } else { 921600 };
    Ok(())
}

#[tauri::command]
pub async fn esp_build_flash_start(
    handle: tauri::State<'_, EspHandle>,
    app: tauri::AppHandle,
    serial: tauri::State<'_, SerialState>,
    project_dir: String,
    port: Option<String>,
    baud: Option<u32>,
) -> Result<(), String> {
    let port = match port {
        Some(p) if !p.is_empty() => p,
        _ => serial
            .port_name
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("No port selected")?,
    };

    let cfg = {
        let c = handle.config.lock().unwrap_or_else(|e| e.into_inner());
        EspConfig {
            idf_path: c.idf_path.clone(),
            python_path: c.python_path.clone(),
            baud: baud.unwrap_or(c.baud),
        }
    };
    if cfg.idf_path.trim().is_empty() {
        return Err("ESP-IDF path not configured".into());
    }
    if !idf_py_path(&cfg.idf_path).exists() {
        return Err(format!("idf.py not found in {}", cfg.idf_path));
    }

    {
        let mut busy = handle.busy.lock().unwrap_or_else(|e| e.into_inner());
        if *busy {
            return Err("ESP flash already running".into());
        }
        *busy = true;
    }

    let h = handle.inner().clone();
    let a = app.clone();
    std::thread::spawn(move || {
        let result = run_worker(&h, &a, &cfg, &project_dir, &port);
        let mut busy = h.busy.lock().unwrap_or_else(|e| e.into_inner());
        *busy = false;
        let _ = result;
    });

    Ok(())
}

pub(crate) fn run_worker(
    handle: &EspHandle,
    app: &tauri::AppHandle,
    cfg: &EspConfig,
    project_dir: &str,
    port: &str,
) -> Result<(), String> {
    emit_line(app, "build", "===== idf.py build =====");
    match run_step(app, handle, cfg, "build", vec!["build".to_string()], project_dir) {
        Ok(true) => {}
        Ok(false) => {
            emit_done(app, false, "build");
            return Err("build failed".into());
        }
        Err(e) => {
            emit_done(app, false, "build");
            return Err(e);
        }
    }

    emit_line(app, "flash", "===== idf.py flash =====");
    let mut flash_args = vec!["-p".to_string(), port.to_string()];
    if cfg.baud > 0 {
        flash_args.push("-b".to_string());
        flash_args.push(cfg.baud.to_string());
    }
    flash_args.push("flash".to_string());
    match run_step(app, handle, cfg, "flash", flash_args, project_dir) {
        Ok(true) => {
            emit_done(app, true, "flash");
            Ok(())
        }
        Ok(false) => {
            emit_done(app, false, "flash");
            Err("flash failed".into())
        }
        Err(e) => {
            emit_done(app, false, "flash");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn esp_flash_cancel(handle: tauri::State<'_, EspHandle>) -> Result<(), String> {
    let child = handle
        .child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(mut c) = child {
        let pid = c.id();
        let _ = c.kill();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    Ok(())
}

#[tauri::command]
pub async fn esp_reset(serial: tauri::State<'_, SerialState>) -> Result<(), String> {
    let port = {
        let p = serial.port.lock().unwrap_or_else(|e| e.into_inner());
        p.as_ref().and_then(|p| p.try_clone().ok())
    };
    let port = match port {
        Some(p) => p,
        None => return Err("Serial port not open".into()),
    };
    let _ = port.set_dtr(false);
    let _ = port.set_rts(true);
    std::thread::sleep(Duration::from_millis(100));
    let _ = port.set_rts(false);
    Ok(())
}

#[tauri::command]
pub async fn detect_esp_paths() -> Result<serde_json::Value, String> {
    let mut idf_paths: Vec<String> = Vec::new();
    let mut python_paths: Vec<String> = Vec::new();

    let mut push_idf = |p: PathBuf| {
        let s = p.to_string_lossy().to_string();
        if !idf_paths.contains(&s) {
            idf_paths.push(s);
        }
    };

    if let Ok(p) = std::env::var("IDF_PATH") {
        if idf_py_path(&p).exists() {
            push_idf(PathBuf::from(&p));
        }
    }

    for base in ["D:\\Programs", "C:\\Espressif", "C:\\Espressif\\frameworks"] {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                if p.join("tools").join("idf.py").exists() {
                    push_idf(p.clone());
                } else if p.join("esp-idf").join("tools").join("idf.py").exists() {
                    push_idf(p.join("esp-idf"));
                }
                let py_dir = p.join("python_env");
                if py_dir.is_dir() {
                    if let Ok(envs) = std::fs::read_dir(&py_dir) {
                        for env in envs.flatten() {
                            let exe = env.path().join("Scripts").join("python.exe");
                            if exe.exists() {
                                python_paths.push(exe.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    if let Ok(profile) = std::env::var("USERPROFILE") {
        let pdir = Path::new(&profile).join(".espressif").join("python_env");
        if pdir.is_dir() {
            if let Ok(envs) = std::fs::read_dir(&pdir) {
                for env in envs.flatten() {
                    let exe = env.path().join("Scripts").join("python.exe");
                    if exe.exists() {
                        python_paths.push(exe.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({
        "idfPaths": idf_paths,
        "pythonPaths": python_paths,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(idf: &str, python: &str) -> EspConfig {
        EspConfig {
            idf_path: idf.to_string(),
            python_path: python.to_string(),
            baud: 921600,
        }
    }

    #[test]
    fn script_with_python_path() {
        let s = build_script(
            &cfg(
                r"D:\Programs\esp-idf\v5.5.3\esp-idf",
                r"D:\Programs\esp-idf-tools\python_env\idf5.4_py3.11_env\Scripts\python.exe",
            ),
            &["-p".into(), "COM3".into(), "flash".into()],
        );
        assert!(s.contains(r#"call "D:\Programs\esp-idf\v5.5.3\esp-idf\export.bat" >nul"#));
        assert!(s.contains("python.exe"));
        assert!(s.contains("idf.py"));
        assert!(s.contains("-p COM3 flash"));
    }

    #[test]
    fn script_without_python_uses_path_idf() {
        let s = build_script(&cfg(r"D:\esp-idf", ""), &["build".into()]);
        assert!(s.ends_with("&& idf.py build"));
        assert!(!s.contains("python.exe"));
    }

    #[test]
    fn idf_py_located_under_tools() {
        assert_eq!(
            idf_py_path(r"D:\esp-idf"),
            PathBuf::from(r"D:\esp-idf\tools\idf.py")
        );
    }
}
