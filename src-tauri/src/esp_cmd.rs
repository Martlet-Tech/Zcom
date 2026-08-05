use crate::encoding_utils;
use crate::state::SerialState;
use std::io::Read;
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

/// Extracts the version tag from an IDF checkout path like
/// `D:\ToolChain\esp\v5.5.2\esp-idf` -> "5.5.2".
fn idf_version_tag(idf_path: &str) -> Option<String> {
    let idf = Path::new(idf_path);
    let version_dir = idf.parent()?.file_name()?.to_str()?;
    let v = version_dir.trim_start_matches('v');
    if v.is_empty() || !v.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    Some(v.to_string())
}

/// Derives the IDF tools root from a venv python path like
/// `<tools>/python_env/<env>/Scripts/python.exe` -> `<tools>`.
///
/// Used to force `IDF_TOOLS_PATH` so activate.py does not pick up a stale
/// global config pointing at a different IDF version.
fn tools_path_from_python(python_path: &str) -> Option<String> {
    let p = Path::new(python_path);
    let env = p.parent()?.parent()?;
    let tools = env.parent()?.parent()?;
    Some(tools.to_string_lossy().to_string())
}

/// Collects `python_env/<env>/Scripts/python.exe` entries under a python_env dir.
fn collect_env_pythons(python_env: &Path, out: &mut Vec<PathBuf>) {
    if !python_env.is_dir() {
        return;
    }
    if let Ok(envs) = std::fs::read_dir(python_env) {
        for env in envs.flatten() {
            let exe = env.path().join("Scripts").join("python.exe");
            if exe.exists() && !out.contains(&exe) {
                out.push(exe);
            }
        }
    }
}

/// Discovers venv pythons commonly placed next to an ESP-IDF checkout:
/// - `<idf>/../../tools-*/python_env`   (D:\ToolChain\esp\tools-5.5.2 layout)
/// - `<idf>/../../python_env`
/// - `<idf>/python_env`
/// - `%USERPROFILE%\.espressif\python_env`
///
/// Version-matched tools dirs (`tools-5.5.2` for an IDF v5.5.2) are preferred.
fn venv_python_candidates(idf_path: &str) -> Vec<PathBuf> {
    let idf = Path::new(idf_path);
    let mut out = Vec::new();
    let tools_root = idf.ancestors().nth(2);
    let version = idf_version_tag(idf_path);
    if let Some(tr) = tools_root {
        if let Ok(entries) = std::fs::read_dir(tr) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect();
            let prefer = version
                .as_ref()
                .map(|v| format!("tools-{}", v))
                .unwrap_or_default();
            dirs.sort_by(|a, b| {
                let na = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let nb = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let ma = !prefer.is_empty() && na == prefer;
                let mb = !prefer.is_empty() && nb == prefer;
                (mb as u8).cmp(&(ma as u8)).then_with(|| na.cmp(nb))
            });
            for d in dirs {
                let name = d.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("tools") {
                    collect_env_pythons(&d.join("python_env"), &mut out);
                }
            }
        }
        collect_env_pythons(&tr.join("python_env"), &mut out);
    }
    collect_env_pythons(&idf.join("python_env"), &mut out);
    if let Ok(profile) = std::env::var("USERPROFILE") {
        collect_env_pythons(
            &Path::new(&profile).join(".espressif").join("python_env"),
            &mut out,
        );
    }
    out
}

/// Chooses the python interpreter for IDF: explicit setting first, then the
/// best auto-discovered venv next to the IDF checkout, else empty (fallback).
fn resolve_python(cfg: &EspConfig) -> String {
    let p = cfg.python_path.trim();
    if !p.is_empty() {
        return p.to_string();
    }
    venv_python_candidates(&cfg.idf_path)
        .first()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Builds the cmd line for an idf.py step.
///
/// Preferred path (venv python available): a previous "env" step wrote
/// `%TEMP%\zcom-idf-env.cmd` via `activate.py --export`; here we just call it
/// and run idf.py with that environment. This avoids export.bat entirely
/// (which silently fails without python/git on PATH and is hostile to MSYS).
///
/// `IDF_TOOLS_PATH` is forced AFTER `call env.cmd` because the exported env
/// does not set it, and the app may have inherited a stale global value
/// (e.g. an older IDF version) which makes idf.py check dependencies against
/// the wrong constraints file.
///
/// Fallback: `call export.bat && idf.py ...` (errors are now visible in the log).
fn build_script(cfg: &EspConfig, step_args: &[String]) -> String {
    let python = resolve_python(cfg);
    let args = step_args.join(" ");

    if python.is_empty() {
        return format!(
            "call \"{}\" && idf.py {}",
            export_bat_path(&cfg.idf_path).to_string_lossy(),
            args
        );
    }

    let idf_py = idf_py_path(&cfg.idf_path);
    let tools = tools_path_from_python(&python).unwrap_or_default();
    format!(
        "call \"%TEMP%\\zcom-idf-env.cmd\" && set \"IDF_TOOLS_PATH={}\" && \"{}\" -u \"{}\" {}",
        tools,
        python,
        idf_py.to_string_lossy(),
        args
    )
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

/// Reads one pipe to EOF, decoding each line (UTF-8 first, OEM/GBK fallback)
/// and emitting it to the UI log. Returns the number of lines emitted.
fn read_pipe_into_log<R: Read>(app: &tauri::AppHandle, stage: &str, mut reader: R) -> usize {
    let mut count = 0usize;
    let mut acc: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                acc.extend_from_slice(&chunk[..n]);
                while let Some(pos) = acc.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = acc.drain(..=pos).collect();
                    let text = encoding_utils::decode_console_text(&line);
                    let text = text.trim_end_matches('\r').to_string();
                    if !text.is_empty() {
                        emit_line(app, stage, &text);
                        count += 1;
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !acc.is_empty() {
        let text = encoding_utils::decode_console_text(&acc);
        let text = text.trim_end_matches('\r').to_string();
        if !text.is_empty() {
            emit_line(app, stage, &text);
            count += 1;
        }
    }
    count
}

/// Writes a script into `%TEMP%\zcom-idf-cmd.bat` and returns its path.
///
/// Running steps via a batch file avoids the Windows `cmd /C` quoting trap:
/// Rust escapes embedded `"` in command-line args as `\"`, which cmd does not
/// understand. Inside a .bat file quotes are parsed natively, so the script
/// content can contain as many quotes as it needs.
fn write_step_bat(script: &str) -> Result<PathBuf, String> {
    let temp = std::env::var("TEMP")
        .or_else(|_| std::env::var("TMP"))
        .map_err(|_| "TEMP environment variable not found".to_string())?;
    let bat = Path::new(&temp).join("zcom-idf-cmd.bat");
    std::fs::write(&bat, script).map_err(|e| format!("Failed to write step script: {}", e))?;
    Ok(bat)
}

/// Runs one raw cmd script (blocking). Returns:
/// - Ok(true)  success (exit 0)
/// - Ok(false) non-zero exit
/// - Err(msg)  spawn/wait failure
///
/// The script is executed through a temp .bat file (see `write_step_bat`).
/// stdout/stderr are drained concurrently (avoids pipe-buffer deadlock) and
/// decoded with GBK fallback so localized cmd errors are never lost. MSYS
/// environment variables are stripped so export/activate scripts cannot
/// refuse to run when the app was launched from Git Bash.
fn run_cmd(
    app: &tauri::AppHandle,
    handle: &EspHandle,
    stage: &str,
    script: &str,
    cwd: &str,
) -> Result<bool, String> {
    let bat = write_step_bat(script)?;
    let bat_path = bat.to_string_lossy().to_string();
    let mut child = Command::new("cmd")
        .arg("/C")
        .arg(&bat_path)
        .current_dir(cwd)
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("MSYSTEM")
        .env_remove("MSYS")
        .env_remove("MINGW_PREFIX")
        .env_remove("MINGW_CHOST")
        .env_remove("MSYSTEM_CHOST")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", stage, e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *handle.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let app2 = app.clone();
        let s = stage.to_string();
        readers.push(std::thread::spawn(move || read_pipe_into_log(&app2, &s, out)));
    }
    if let Some(err) = stderr {
        let app2 = app.clone();
        let s = stage.to_string();
        readers.push(std::thread::spawn(move || read_pipe_into_log(&app2, &s, err)));
    }

    let total_lines: usize = readers
        .into_iter()
        .map(|h| h.join().unwrap_or(0))
        .sum();

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
    if !ok && total_lines == 0 {
        emit_line(
            app,
            stage,
            ">>> 命令失败且无任何输出。请核对设置中的 IDF 路径 / Python 路径是否正确",
        );
    }
    Ok(ok)
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
    run_cmd(app, handle, stage, &script, cwd)
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

/// Environment activation outcome for a step run.
enum EnvResult {
    /// activate.py --export succeeded; `%TEMP%\zcom-idf-env.cmd` is ready.
    Activated,
    /// No venv python / activate.py available; fall back to export.bat flow.
    Fallback,
    /// activate.py exited non-zero; the IDF env on this machine is broken.
    Failed,
}

/// Writes the IDF environment to `%TEMP%\zcom-idf-env.cmd` via
/// `activate.py --export` (stdout = export commands, stderr = progress which
/// is shown in the log). Never touches export.bat.
fn run_env_activate(
    app: &tauri::AppHandle,
    handle: &EspHandle,
    cfg: &EspConfig,
) -> Result<EnvResult, String> {
    let python = resolve_python(cfg);
    if python.is_empty() {
        return Ok(EnvResult::Fallback);
    }
    let activate = Path::new(&cfg.idf_path).join("tools").join("activate.py");
    if !activate.exists() {
        return Ok(EnvResult::Fallback);
    }
    let script = format!(
        "set \"IDF_PATH={}\" && set \"IDF_TOOLS_PATH={}\" && \"{}\" -u \"{}\" --export > \"%TEMP%\\zcom-idf-env.cmd\"",
        cfg.idf_path,
        tools_path_from_python(&python).unwrap_or_default(),
        python,
        activate.to_string_lossy()
    );
    match run_cmd(app, handle, "env", &script, &cfg.idf_path)? {
        true => Ok(EnvResult::Activated),
        false => Ok(EnvResult::Failed),
    }
}

pub(crate) fn run_worker(
    handle: &EspHandle,
    app: &tauri::AppHandle,
    cfg: &EspConfig,
    project_dir: &str,
    port: &str,
) -> Result<(), String> {
    emit_line(app, "env", "===== 初始化 IDF 环境 =====");
    match run_env_activate(app, handle, cfg) {
        Ok(EnvResult::Activated) => {}
        Ok(EnvResult::Fallback) => {
            emit_line(app, "env", ">>> 未找到 Python 虚拟环境，将尝试 export.bat 方式（需 PATH 中有 python 与 git）");
        }
        Ok(EnvResult::Failed) => {
            emit_done(app, false, "env");
            emit_line(app, "env", ">>> IDF 环境初始化失败（见上方错误）。请检查 ESP-IDF 安装与 Python 虚拟环境是否完整");
            return Err("IDF env activation failed".into());
        }
        Err(e) => {
            emit_done(app, false, "env");
            return Err(e);
        }
    }

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

    for base in [
        "D:\\Programs",
        "D:\\ToolChain\\esp",
        "C:\\Espressif",
        "C:\\Espressif\\frameworks",
    ] {
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
                } else if let Ok(subs) = std::fs::read_dir(&p) {
                    for sub in subs.flatten() {
                        let sp = sub.path();
                        if sp.join("esp-idf").join("tools").join("idf.py").exists() {
                            push_idf(sp.join("esp-idf"));
                        }
                    }
                }
                let py_dir = p.join("python_env");
                if py_dir.is_dir() {
                    let mut found = Vec::new();
                    collect_env_pythons(&py_dir, &mut found);
                    for f in found {
                        python_paths.push(f.to_string_lossy().to_string());
                    }
                }
                if p.file_name().and_then(|n| n.to_str()).map_or(false, |n| n.starts_with("tools")) {
                    let py_dir = p.join("python_env");
                    let mut found = Vec::new();
                    collect_env_pythons(&py_dir, &mut found);
                    for f in found {
                        python_paths.push(f.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    if let Ok(profile) = std::env::var("USERPROFILE") {
        let pdir = Path::new(&profile).join(".espressif").join("python_env");
        let mut found = Vec::new();
        collect_env_pythons(&pdir, &mut found);
        for f in found {
            python_paths.push(f.to_string_lossy().to_string());
        }
    }

    python_paths.sort();
    python_paths.dedup();

    Ok(serde_json::json!({
        "idfPaths": idf_paths,
        "pythonPaths": python_paths,
    }))
}

#[derive(serde::Serialize)]
pub struct EspCheckItem {
    pub key: &'static str,
    pub ok: bool,
    pub detail: String,
}

#[derive(serde::Serialize)]
pub struct EspCheckResult {
    pub ok: bool,
    pub items: Vec<EspCheckItem>,
}

/// Validates an IDF path / python path pair and probes whether the environment
/// can actually build (runs `activate.py --export` with a timeout).
#[tauri::command]
pub async fn esp_check_paths(
    idf_path: String,
    python_path: String,
) -> Result<EspCheckResult, String> {
    let idf = Path::new(&idf_path);
    let cfg = EspConfig {
        idf_path: idf_path.clone(),
        python_path: python_path.clone(),
        baud: 921600,
    };
    let python = resolve_python(&cfg);

    let mut items = Vec::new();
    items.push(EspCheckItem {
        key: "idfDir",
        ok: idf.is_dir(),
        detail: idf_path.clone(),
    });
    let idf_py_ok = idf.join("tools").join("idf.py").is_file();
    items.push(EspCheckItem {
        key: "idfPy",
        ok: idf_py_ok,
        detail: idf.join("tools").join("idf.py").to_string_lossy().to_string(),
    });
    let export_ok = idf.join("export.bat").is_file();
    items.push(EspCheckItem {
        key: "exportBat",
        ok: export_ok,
        detail: String::new(),
    });
    let activate_ok = idf.join("tools").join("activate.py").is_file();
    items.push(EspCheckItem {
        key: "activate",
        ok: activate_ok,
        detail: String::new(),
    });
    let python_ok = !python.is_empty() && Path::new(&python).is_file();
    items.push(EspCheckItem {
        key: "python",
        ok: python_ok,
        detail: if python.is_empty() {
            "未找到 venv python，将走 export.bat 兜底".to_string()
        } else {
            python.clone()
        },
    });

    if !idf_py_ok || !python_ok {
        items.push(EspCheckItem {
            key: "probe",
            ok: false,
            detail: "前置检查未通过，跳过环境探针".to_string(),
        });
        return Ok(EspCheckResult { ok: false, items });
    }

    let probe = tokio::task::spawn_blocking({
        let python = python.clone();
        let activate = idf.join("tools").join("activate.py");
        let idf_path = idf_path.clone();
        move || run_probe(&python, &activate, &idf_path)
    })
    .await
    .map_err(|e| e.to_string())?;

    let (ok, detail) = probe;
    items.push(EspCheckItem {
        key: "probe",
        ok,
        detail,
    });

    Ok(EspCheckResult {
        ok,
        items,
    })
}

/// Runs `<python> -u <activate.py> --export` with a 20s timeout, returning
/// (success, diagnostic text).
fn run_probe(python: &str, activate: &Path, idf_path: &str) -> (bool, String) {
    let script = format!(
        "set \"IDF_PATH={}\" && set \"IDF_TOOLS_PATH={}\" && \"{}\" -u \"{}\" --export",
        idf_path,
        tools_path_from_python(python).unwrap_or_default(),
        python,
        activate.to_string_lossy()
    );
    let bat = match write_step_bat(&script) {
        Ok(b) => b,
        Err(e) => return (false, e),
    };
    let bat_path = bat.to_string_lossy().to_string();
    let mut child = match Command::new("cmd")
        .arg("/C")
        .arg(&bat_path)
        .current_dir(idf_path)
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("MSYSTEM")
        .env_remove("MSYS")
        .env_remove("MINGW_PREFIX")
        .env_remove("MINGW_CHOST")
        .env_remove("MSYSTEM_CHOST")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("启动失败: {}", e)),
    };

    let out_handle = child.stdout.take().map(|out| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut std::io::BufReader::new(out), &mut buf);
            encoding_utils::decode_console_text(&buf)
        })
    });
    let err_handle = child.stderr.take().map(|err| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut std::io::BufReader::new(err), &mut buf);
            encoding_utils::decode_console_text(&buf)
        })
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break None,
        }
    };

    let mut out_text = String::new();
    let mut err_text = String::new();
    if let Some(h) = out_handle {
        if let Ok(s) = h.join() {
            out_text = s;
        }
    }
    if let Some(h) = err_handle {
        if let Ok(s) = h.join() {
            err_text = s;
        }
    }

    let detail = {
        let mut tail = String::new();
        for src in [&err_text, &out_text] {
            for line in src.lines().rev().take(12) {
                let l = line.trim();
                if l.is_empty() {
                    continue;
                }
                if tail.contains(l) {
                    continue;
                }
                tail = format!("{}\n{}", l, tail);
                if tail.len() > 1400 {
                    break;
                }
            }
        }
        let tail = tail.trim().to_string();
        if tail.is_empty() {
            "无输出".to_string()
        } else {
            tail
        }
    };

    match status {
        Some(st) if st.success() => (true, detail),
        Some(_) => (false, detail),
        None => (false, format!("超时(20s)：{}", detail)),
    }
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
        assert!(s.contains(r#"call "%TEMP%\zcom-idf-env.cmd""#));
        assert!(s.contains(r#"set "IDF_TOOLS_PATH=D:\Programs\esp-idf-tools""#));
        assert!(s.contains("python.exe"));
        assert!(s.contains("idf.py"));
        assert!(s.contains("-p COM3 flash"));
        assert!(!s.contains("export.bat"));
    }

    #[test]
    fn script_without_python_uses_export_fallback() {
        let s = build_script(&cfg(r"D:\esp-idf", ""), &["build".into()]);
        assert!(s.ends_with("&& idf.py build"));
        assert!(s.contains("export.bat"));
        assert!(!s.contains("zcom-idf-env"));
    }

    #[test]
    fn idf_version_tag_extracted() {
        assert_eq!(idf_version_tag(r"D:\ToolChain\esp\v5.5.2\esp-idf"), Some("5.5.2".into()));
        assert_eq!(idf_version_tag(r"D:\ToolChain\esp\v5\esp-idf"), Some("5".into()));
        assert_eq!(idf_version_tag(r"D:\esp-idf"), None);
    }

    #[test]
    fn tools_path_derived_from_python() {
        assert_eq!(
            tools_path_from_python(
                r"D:\ToolChain\esp\tools-5.5.2\python_env\idf5.5_py3.11_env\Scripts\python.exe"
            ),
            Some(r"D:\ToolChain\esp\tools-5.5.2".to_string())
        );
        assert_eq!(tools_path_from_python(r"D:\python.exe"), None);
    }

    #[test]
    fn resolve_python_prefers_explicit() {
        let c = cfg(
            r"D:\ToolChain\esp\v5.5.2\esp-idf",
            r"D:\ToolChain\esp\tools-5.5.2\python_env\idf5.5_py3.11_env\Scripts\python.exe",
        );
        assert!(resolve_python(&c).contains("idf5.5_py3.11_env"));
    }

    #[test]
    fn decode_console_text_falls_back_to_oem() {
        let gbk = b"'idf.py' \xca\xc7\xb2\xbb\xca\xc7\xc4\xda\xb2\xbf";
        let s = crate::encoding_utils::decode_console_text(gbk);
        assert!(s.contains("idf.py"));
        assert!(s.contains('是'));
        let utf8 = "hello world".as_bytes();
        assert_eq!(crate::encoding_utils::decode_console_text(utf8), "hello world");
    }

    #[test]
    fn idf_py_located_under_tools() {
        assert_eq!(
            idf_py_path(r"D:\esp-idf"),
            PathBuf::from(r"D:\esp-idf\tools\idf.py")
        );
    }
}
