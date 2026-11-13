#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindow,
};
use thiserror::Error;
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const BACKEND_URL: &str = "https://screentimer.onrender.com";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PIPE_NAME: &str = r"\\.\pipe\DigitalPulse.UserControl.v1";
const RUN_VALUE: &str = "DigitalPulse";
const SAFE_CODES: &[&str] = &[
    "INVALID_SECRET_KEY", "SECRET_KEY_CONSUMED", "SECRET_KEY_EXPIRED",
    "SECRET_KEY_IDENTITY_MISMATCH", "DEVICE_ASSIGNMENT_MISMATCH", "DEVICE_REVOKED",
    "DEVICE_ARCHIVED", "DEVICE_NOT_FOUND", "STORAGE_UNAVAILABLE",
    "DEVICE_STORAGE_UNAVAILABLE", "TOO_MANY_ATTEMPTS", "INVALID_CREDENTIALS",
];

#[derive(Default)]
struct Session {
    cookie: Option<String>,
    email: Option<String>,
}

#[derive(Default)]
struct AppState(Mutex<Session>);

#[derive(Debug, Error, Serialize)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
struct CommandError {
    code: String,
    message: String,
}

impl CommandError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
    fn storage(message: impl Into<String>) -> Self { Self::new("STORAGE_UNAVAILABLE", message) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    running: bool,
    enrolled: bool,
    device_id: Option<String>,
    lifecycle: String,
    backend_url: Option<String>,
    pending_queue: usize,
    total_recorded: usize,
    recovery_required: bool,
    storage_available: bool,
    status_detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionView { signed_in: bool, email: Option<String> }

fn local_data_dir() -> Result<PathBuf, CommandError> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| CommandError::storage("Windows local application data is unavailable."))?;
    Ok(root.join("DigitalPulse"))
}

fn database_path() -> Result<PathBuf, CommandError> { Ok(local_data_dir()?.join("agent_storage.db")) }
fn resume_marker() -> Result<PathBuf, CommandError> { Ok(local_data_dir()?.join("monitoring.requested")) }

fn agent_path() -> Result<PathBuf, CommandError> {
    let current = std::env::current_exe().map_err(|_| CommandError::new("AGENT_MISSING", "The application path could not be resolved."))?;
    if let Some(parent) = current.parent() {
        let installed = parent.join("dp-user-agent.exe");
        if installed.is_file() { return Ok(installed); }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../desktop-agent/target/release/dp-user-agent.exe");
    if dev.is_file() { return Ok(dev); }
    Err(CommandError::new("AGENT_MISSING", "The DigitalPulse monitoring agent is not installed."))
}

fn process_is_running() -> bool {
    let Ok(path) = database_path() else { return false };
    if !path.exists() { return false; }
    OpenOptions::new().read(true).write(true).create(true).truncate(false).share_mode(0)
        .open(path.with_extension("monitor.lock")).is_err()
}

fn command_for_agent() -> Result<Command, CommandError> {
    let mut command = Command::new(agent_path()?);
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("DP_BACKEND_URL", BACKEND_URL).env("DP_ALLOW_REMOTE_BACKEND", "1");
    Ok(command)
}

fn run_agent(args: &[&str], stdin_value: Option<&[u8]>, timeout: Duration) -> Result<Output, CommandError> {
    let mut command = command_for_agent()?;
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_value.is_some() { command.stdin(Stdio::piped()); }
    let mut child = command.spawn().map_err(|_| CommandError::new("AGENT_START_FAILED", "The monitoring agent could not be launched."))?;
    if let Some(value) = stdin_value {
        if let Some(mut input) = child.stdin.take() {
            input.write_all(value).map_err(|_| CommandError::new("AGENT_INPUT_FAILED", "Secure device verification input could not be delivered."))?;
        }
    }
    let started = Instant::now();
    while started.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|_| CommandError::new("AGENT_RESPONSE_FAILED", "The monitoring agent response could not be read.")),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err(CommandError::new("AGENT_RESPONSE_FAILED", "The monitoring agent stopped unexpectedly.")),
        }
    }
    let _ = child.kill();
    Err(CommandError::new("AGENT_TIMEOUT", "The monitoring agent did not respond in time. Monitoring remains stopped."))
}

fn parse_field<'a>(text: &'a str, label: &str) -> Option<&'a str> {
    text.lines().find_map(|line| line.strip_prefix(label).map(str::trim))
}

fn parse_count(text: &str, label: &str) -> usize {
    parse_field(text, label).and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse().ok()).unwrap_or(0)
}

fn empty_agent_status(detail: &str) -> AgentStatus {
    AgentStatus { running: false, enrolled: false, device_id: None, lifecycle: "NOT_ENROLLED".into(),
        backend_url: None, pending_queue: 0, total_recorded: 0, recovery_required: false,
        storage_available: true, status_detail: detail.into() }
}

#[tauri::command]
fn agent_status() -> Result<AgentStatus, CommandError> {
    let running = process_is_running();
    let db = database_path()?;
    if !db.exists() {
        let mut status = empty_agent_status("Ready for first-time enrollment");
        status.running = running;
        return Ok(status);
    }
    let output = run_agent(&["--status"], None, Duration::from_secs(10))?;
    if !output.status.success() {
        return Ok(AgentStatus { running, enrolled: false, device_id: None, lifecycle: "UNKNOWN".into(), backend_url: None,
            pending_queue: 0, total_recorded: 0, recovery_required: false, storage_available: false,
            status_detail: "Local storage could not be inspected safely".into() });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let enrollment = parse_field(&text, "Enrollment:").unwrap_or_default();
    let recovery = parse_field(&text, "Recovery:").unwrap_or_default();
    Ok(AgentStatus {
        running, enrolled: enrollment == "ENROLLED",
        device_id: parse_field(&text, "Device ID:").filter(|v| !v.is_empty()).map(str::to_owned),
        lifecycle: parse_field(&text, "Lifecycle:").unwrap_or("UNKNOWN").to_owned(),
        backend_url: parse_field(&text, "Backend URL:").filter(|v| !v.is_empty()).map(str::to_owned),
        pending_queue: parse_count(&text, "Pending Queue:"), total_recorded: parse_count(&text, "Total Recorded:"),
        recovery_required: recovery.contains("ADMIN ACTION REQUIRED"), storage_available: true,
        status_detail: if running { "Independent user-session agent is running" } else { "Independent user-session agent is stopped" }.into(),
    })
}

fn backend_request(method: &str, endpoint: &str, headers: Vec<(String, String)>, body: &[u8])
    -> Result<dp_platform_windows::http::HttpResponse, CommandError>
{
    dp_platform_windows::http::request(method, "screentimer.onrender.com", 443, endpoint, &headers, body, true)
        .map_err(|_| CommandError::new("BACKEND_UNREACHABLE", "DigitalPulse could not reach the secure server."))
}

fn backend_error(status: u16, body: &[u8], fallback: &str) -> CommandError {
    let parsed = serde_json::from_slice::<serde_json::Value>(body).ok();
    let raw_code = parsed.as_ref().and_then(|v| v.pointer("/error/code")).and_then(|v| v.as_str()).unwrap_or(fallback);
    let code = if SAFE_CODES.contains(&raw_code) { raw_code } else if status == 401 || status == 403 { "INVALID_CREDENTIALS" } else { fallback };
    let message = match code {
        "INVALID_CREDENTIALS" => "Check your employee email and password.",
        "INVALID_SECRET_KEY" => "The Employee Secret Key is invalid.",
        "SECRET_KEY_CONSUMED" => "This Employee Secret Key has already been used. Request a new key from an administrator.",
        "SECRET_KEY_EXPIRED" => "This Employee Secret Key has expired. Request a new key from an administrator.",
        "SECRET_KEY_IDENTITY_MISMATCH" | "DEVICE_ASSIGNMENT_MISMATCH" => "This key or device is assigned to a different employee.",
        "DEVICE_REVOKED" => "This device was revoked by an administrator. Monitoring remains stopped.",
        "STORAGE_UNAVAILABLE" | "DEVICE_STORAGE_UNAVAILABLE" => "Secure device storage is temporarily unavailable. No credentials were changed.",
        "TOO_MANY_ATTEMPTS" => "Too many attempts. Wait before trying again.",
        _ => "The secure server rejected this request. Monitoring remains stopped.",
    };
    CommandError::new(code, message)
}

fn code_from_agent_error(stderr: &[u8]) -> CommandError {
    let text = String::from_utf8_lossy(stderr);
    let code = SAFE_CODES.iter().find(|code| text.contains(**code)).copied().unwrap_or("DEVICE_VERIFICATION_FAILED");
    backend_error(if code == "DEVICE_VERIFICATION_FAILED" { 400 } else { 403 }, &serde_json::to_vec(&serde_json::json!({"error":{"code":code}})).unwrap_or_default(), code)
}

#[tauri::command]
fn employee_login(email: String, mut password: String, mut secret_key: String, state: State<'_, AppState>) -> Result<SessionView, CommandError> {
    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() || !email.contains('@') || password.is_empty() {
        return Err(CommandError::new("INVALID_CREDENTIALS", "Enter a valid employee email and password."));
    }
    let mut body = serde_json::to_vec(&serde_json::json!({"email":email,"password":password,"rememberMe":false}))
        .map_err(|_| CommandError::new("REQUEST_FAILED", "The sign-in request could not be prepared."))?;
    password.clear();
    let response_result = backend_request("POST", "/api/v1/auth/login", vec![("Content-Type".into(), "application/json".into())], &body);
    body.fill(0);
    let response = response_result?;
    if !(200..300).contains(&response.status) { secret_key.clear(); return Err(backend_error(response.status, &response.body, "LOGIN_FAILED")); }
    let cookie = response.session_cookie.ok_or_else(|| CommandError::new("SESSION_UNAVAILABLE", "The authenticated employee session could not be established."))?;
    let mut agent_input = Vec::with_capacity(cookie.len() + secret_key.len() + 2);
    agent_input.extend_from_slice(cookie.as_bytes()); agent_input.push(b'\n');
    agent_input.extend_from_slice(secret_key.as_bytes()); agent_input.push(b'\n');
    secret_key.clear();
    let verification = run_agent(&["employee-sign-in", "--server", BACKEND_URL], Some(&agent_input), Duration::from_secs(60));
    agent_input.fill(0);
    match verification {
        Ok(output) if output.status.success() && output.stdout.windows(b"EMPLOYEE_DEVICE_SIGN_IN_OK".len()).any(|v| v == b"EMPLOYEE_DEVICE_SIGN_IN_OK") => {
            let mut session = state.0.lock().map_err(|_| CommandError::new("SESSION_UNAVAILABLE", "The local session lock is unavailable."))?;
            session.cookie = Some(cookie); session.email = Some(email.clone());
            Ok(SessionView { signed_in: true, email: Some(email) })
        }
        Ok(output) => { let _ = backend_request("POST", "/api/v1/auth/logout", vec![("Cookie".into(), cookie), ("X-DigitalPulse-Native-Client".into(), "control-center".into())], &[]); Err(code_from_agent_error(&output.stderr)) }
        Err(error) => { let _ = backend_request("POST", "/api/v1/auth/logout", vec![("Cookie".into(), cookie), ("X-DigitalPulse-Native-Client".into(), "control-center".into())], &[]); Err(error) }
    }
}

#[tauri::command]
fn session_state(state: State<'_, AppState>) -> Result<SessionView, CommandError> {
    let session = state.0.lock().map_err(|_| CommandError::new("SESSION_UNAVAILABLE", "The local session lock is unavailable."))?;
    Ok(SessionView { signed_in: session.cookie.is_some(), email: session.email.clone() })
}

fn write_resume_marker() -> Result<(), CommandError> {
    let marker = resume_marker()?;
    std::fs::create_dir_all(marker.parent().unwrap_or(Path::new("."))).map_err(|_| CommandError::storage("The monitoring preference directory is unavailable."))?;
    std::fs::write(marker, b"authorized-start-request-v1\n").map_err(|_| CommandError::storage("The monitoring restart preference could not be saved."))
}
fn remove_resume_marker() { if let Ok(path) = resume_marker() { let _ = std::fs::remove_file(path); } }

fn spawn_monitor() -> Result<(), CommandError> {
    if process_is_running() { return Ok(()); }
    let mut command = command_for_agent()?;
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| CommandError::new("AGENT_START_FAILED", "The monitoring agent could not be started."))?;
    std::thread::sleep(Duration::from_millis(900));
    if let Ok(Some(_)) = child.try_wait() { return Err(CommandError::new("AUTHORIZATION_REQUIRED", "The agent did not remain active. Check enrollment, consent, administrator approval, schedule, and server connection.")); }
    Ok(())
}

#[tauri::command]
fn start_monitoring(consent_acknowledged: bool, state: State<'_, AppState>) -> Result<String, CommandError> {
    if !consent_acknowledged { return Err(CommandError::new("CONSENT_REQUIRED", "Explicit employee acknowledgement is required before requesting monitoring.")); }
    if state.0.lock().map_err(|_| CommandError::new("SESSION_UNAVAILABLE", "The local session lock is unavailable."))?.cookie.is_none() {
        return Err(CommandError::new("SIGN_IN_REQUIRED", "Sign in and verify this device before starting monitoring."));
    }
    spawn_monitor()?;
    write_resume_marker()?;
    Ok("The agent is running. Collection occurs only while server authorization, consent, and schedule gates remain valid.".into())
}

fn send_control(command: &str) -> Result<String, CommandError> {
    if !process_is_running() { return Ok("OK".into()); }
    let wide: Vec<u16> = PIPE_NAME.encode_utf16().chain(std::iter::once(0)).collect();
    if unsafe { WaitNamedPipeW(wide.as_ptr(), 5000) } == 0 { return Err(CommandError::new("AGENT_NOT_RESPONDING", "The agent did not make its protected control channel available.")); }
    let mut pipe = OpenOptions::new().read(true).write(true).open(PIPE_NAME)
        .map_err(|_| CommandError::new("AGENT_NOT_RESPONDING", "The protected agent control channel could not be opened."))?;
    pipe.write_all(command.as_bytes()).map_err(|_| CommandError::new("AGENT_CONTROL_FAILED", "The stop request could not be delivered."))?;
    pipe.flush().ok();
    let mut reply = [0u8; 128];
    let count = pipe.read(&mut reply).map_err(|_| CommandError::new("AGENT_CONTROL_FAILED", "The agent did not acknowledge the request."))?;
    Ok(String::from_utf8_lossy(&reply[..count]).trim().to_owned())
}

#[tauri::command]
fn stop_monitoring() -> Result<String, CommandError> {
    let response = send_control("STOP")?;
    if response != "OK" { return Err(CommandError::new("STOP_NOT_ACKNOWLEDGED", "The agent did not confirm that monitoring stopped.")); }
    remove_resume_marker();
    Ok("Monitoring stopped and will not resume automatically.".into())
}

#[tauri::command]
fn employee_logout(state: State<'_, AppState>) -> Result<String, CommandError> {
    stop_monitoring()?;
    let cookie = { let mut session = state.0.lock().map_err(|_| CommandError::new("SESSION_UNAVAILABLE", "The local session lock is unavailable."))?; session.email = None; session.cookie.take() };
    if let Some(cookie) = cookie {
        let response = backend_request("POST", "/api/v1/auth/logout", vec![("Cookie".into(), cookie), ("X-DigitalPulse-Native-Client".into(), "control-center".into())], &[])?;
        if !(200..300).contains(&response.status) { return Err(backend_error(response.status, &response.body, "LOGOUT_UNAVAILABLE")); }
    }
    Ok("Signed out. Monitoring is stopped.".into())
}

#[tauri::command]
fn sync_now() -> Result<String, CommandError> {
    let output = run_agent(&["--sync-now", "--server", BACKEND_URL], None, Duration::from_secs(60))?;
    if !output.status.success() { return Err(code_from_agent_error(&output.stderr)); }
    Ok("Queued records were synchronized and acknowledged by the server.".into())
}

fn run_key() -> Result<RegKey, CommandError> {
    RegKey::predef(HKEY_CURRENT_USER).create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map(|v| v.0).map_err(|_| CommandError::new("SETTINGS_UNAVAILABLE", "Windows startup settings could not be opened."))
}

#[tauri::command]
fn get_launch_on_login() -> Result<bool, CommandError> { Ok(run_key()?.get_value::<String, _>(RUN_VALUE).is_ok()) }

#[tauri::command]
fn set_launch_on_login(enabled: bool) -> Result<(), CommandError> {
    let key = run_key()?;
    if enabled {
        let exe = std::env::current_exe().map_err(|_| CommandError::new("SETTINGS_UNAVAILABLE", "The application path could not be resolved."))?;
        key.set_value(RUN_VALUE, &format!("\"{}\" --background", exe.display())).map_err(|_| CommandError::new("SETTINGS_UNAVAILABLE", "Launch at sign-in could not be enabled."))
    } else {
        match key.delete_value(RUN_VALUE) { Ok(()) => Ok(()), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(_) => Err(CommandError::new("SETTINGS_UNAVAILABLE", "Launch at sign-in could not be disabled.")) }
    }
}

#[tauri::command]
fn update_tray_status(app: AppHandle, running: bool, attention: bool) -> Result<(), CommandError> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let label = if attention { "DigitalPulse — attention required" } else if running { "DigitalPulse — monitoring active" } else { "DigitalPulse — monitoring stopped" };
        tray.set_tooltip(Some(label)).map_err(|_| CommandError::new("TRAY_UNAVAILABLE", "The tray status could not be updated."))?;
    }
    Ok(())
}

fn show_main(window: Option<WebviewWindow>) {
    if let Some(window) = window { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open DigitalPulse", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Monitoring", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Control Center", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &stop, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray").menu(&menu).show_menu_on_left_click(false).tooltip("DigitalPulse — monitoring stopped");
    if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }
    builder.on_menu_event(|app, event| match event.id.as_ref() {
        "open" => show_main(app.get_webview_window("main")),
        "stop" => { let _ = stop_monitoring(); },
        "quit" => app.exit(0),
        _ => {}
    }).on_tray_icon_event(|tray, event| {
        if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
            show_main(tray.app_handle().get_webview_window("main"));
        }
    }).build(app)?;
    Ok(())
}

fn main() {
    if std::env::args().any(|arg| arg == "--smoke-test") {
        std::process::exit(if agent_path().is_ok() { 0 } else { 2 });
    }
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            setup_tray(app)?;
            if resume_marker().map(|p| p.is_file()).unwrap_or(false) { let _ = spawn_monitor(); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close(); let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![agent_status, session_state, employee_login, start_monitoring,
            stop_monitoring, employee_logout, sync_now, get_launch_on_login, set_launch_on_login, update_tray_status])
        .run(tauri::generate_context!())
        .expect("DigitalPulse failed to initialize");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn status_fields_are_parsed_without_secrets() {
        let status = "Device ID:       1234\nEnrollment:      ENROLLED\nPending Queue:   7 sessions\n";
        assert_eq!(parse_field(status, "Device ID:"), Some("1234")); assert_eq!(parse_count(status, "Pending Queue:"), 7);
    }
    #[test] fn unknown_backend_errors_are_not_exposed() {
        let error = backend_error(400, br#"{"error":{"code":"INTERNAL_SECRET_DETAIL","message":"sensitive"}}"#, "REQUEST_FAILED");
        assert_eq!(error.code, "REQUEST_FAILED"); assert!(!error.message.contains("sensitive"));
    }
}
