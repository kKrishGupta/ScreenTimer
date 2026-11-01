//! DigitalPulse user-session agent.
//!
//! Milestone 3: Activity session management and SQLite persistence.

use anyhow::{bail, Context, Result};
use chrono::Utc;
use dp_core::{ActivityEvent, AgentConfig, EventType, SessionManager, AGENT_VERSION};
use dp_platform_windows::{
    get_current_foreground_app, get_current_process_metrics, get_system_idle_duration,
    ActivityMonitor, PlatformEvent,
};
use dp_storage::{Storage, StoredActivitySession};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

fn main() -> Result<()> {
    init_logging();

    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("dp-user-agent {AGENT_VERSION}");
        return Ok(());
    }

    if !dp_platform_windows::is_supported_platform() {
        bail!("DigitalPulse user agent only supports Windows 11");
    }

    if std::env::args().any(|a| a == "--oneshot") {
        return run_oneshot();
    }

    let run_duration_secs = parse_arg_value("--run-duration").and_then(|s| s.parse::<u64>().ok());
    run_monitor(run_duration_secs)
}

fn run_oneshot() -> Result<()> {
    let idle = get_system_idle_duration();
    let app = get_current_foreground_app();
    let metrics = get_current_process_metrics();

    println!("=== DigitalPulse Oneshot Query ===");
    println!("System Idle Duration: {:.1}s", idle.as_secs_f64());
    match app {
        Ok(a) => {
            println!("Foreground Executable: {}", a.executable_name);
            println!("Foreground PID:        {}", a.process_id);
            println!(
                "Executable Path:       {}",
                a.executable_path.unwrap_or_else(|| "N/A".into())
            );
        }
        Err(err) => {
            println!("Foreground App:        [Error: {err}]");
        }
    }
    if let Some(m) = metrics {
        println!("Agent Working Set RAM: {:.2} MB", m.working_set_mb);
    }
    Ok(())
}

fn run_monitor(max_duration_secs: Option<u64>) -> Result<()> {
    let config = AgentConfig::from_env().context("invalid agent configuration")?;
    let db_path = get_database_path();
    info!(path = %db_path.display(), "Opening SQLite local storage buffer");

    let mut storage = Storage::open(&db_path).context("failed to initialize SQLite storage")?;
    let device_id = get_or_create_device_id(&mut storage)?;

    info!(
        version = AGENT_VERSION,
        device_id = %device_id,
        idle_threshold_secs = config.idle_threshold.as_secs(),
        sample_interval_ms = config.sample_interval.as_millis() as u64,
        "Starting DigitalPulse user-session monitor"
    );

    let running = Arc::new(AtomicBool::new(true));
    dp_platform_windows::register_console_ctrl_handler(running.clone());

    let mut monitor = ActivityMonitor::new(config.idle_threshold);
    let mut session_manager = SessionManager::new(device_id);

    let start_time = Instant::now();
    let mut total_ticks: u64 = 0;
    let mut recorded_sessions: u64 = 0;

    let sample_interval = config.sample_interval;

    while running.load(Ordering::SeqCst) {
        if let Some(max_secs) = max_duration_secs {
            if start_time.elapsed() >= Duration::from_secs(max_secs) {
                info!("Max run duration of {max_secs}s reached, exiting monitoring loop");
                break;
            }
        }

        total_ticks += 1;
        let events = monitor.tick();

        for event in events {
            let now = Utc::now();
            let completed_session = match event {
                PlatformEvent::AppFocused { current, .. } => session_manager.handle_app_focus(
                    current.executable_name.clone(),
                    current.executable_name,
                    current.process_id,
                    now,
                ),
                PlatformEvent::IdleStarted { idle_duration } => {
                    session_manager.handle_idle_start(idle_duration, now)
                }
                PlatformEvent::UserResumed { total_idle } => {
                    session_manager.handle_idle_return(total_idle, now)
                }
            };

            if let Some(session_event) = completed_session {
                save_completed_event(&mut storage, &session_event);
                recorded_sessions += 1;
            }
        }

        thread::sleep(sample_interval);
    }

    // Flush any pending active session on shutdown
    if let Some(final_event) = session_manager.close_active_session(Utc::now()) {
        save_completed_event(&mut storage, &final_event);
        recorded_sessions += 1;
    }

    // Benchmark & summary report
    let elapsed = start_time.elapsed();
    let metrics = get_current_process_metrics();
    let total_stored = storage.count_sessions().unwrap_or(0);
    let pending_sync = storage.count_pending_sync().unwrap_or(0);

    info!("=== Performance & Profile Summary ===");
    info!(
        elapsed_secs = elapsed.as_secs_f64(),
        total_ticks = total_ticks,
        sessions_recorded_this_run = recorded_sessions,
        total_stored_sessions = total_stored,
        pending_sync_queue = pending_sync,
        "Session accounting & storage status"
    );

    if let Some(m) = metrics {
        let cpu_secs = m.total_cpu_time.as_secs_f64();
        let cpu_percentage = if elapsed.as_secs_f64() > 0.0 {
            (cpu_secs / elapsed.as_secs_f64()) * 100.0
        } else {
            0.0
        };

        info!(
            working_set_mb = m.working_set_mb,
            peak_working_set_mb = m.peak_working_set_mb,
            target_max_ram_mb = 15.0,
            ram_pass = m.peak_working_set_mb <= 15.0,
            cpu_time_secs = cpu_secs,
            average_cpu_pct = cpu_percentage,
            target_max_cpu_pct = 1.0,
            cpu_pass = cpu_percentage <= 1.0,
            "Resource usage verification"
        );
    }

    Ok(())
}

fn save_completed_event(storage: &mut Storage, event: &ActivityEvent) {
    if let Err(err) = event.validate() {
        warn!(error = %err, "Discarding event that fails schema validation");
        return;
    }

    let payload_json = match serde_json::to_string(event) {
        Ok(j) => j,
        Err(err) => {
            error!(error = %err, "Failed to serialize event");
            return;
        }
    };

    let (app_name, exe_name, pid) = match &event.app {
        Some(a) => (
            Some(a.name.clone()),
            Some(a.executable.clone()),
            a.process_id,
        ),
        None => (None, None, None),
    };

    let activity_state = match event.event_type {
        EventType::AppSession => "active".to_string(),
        EventType::IdleSession => "idle".to_string(),
        EventType::WebSession => "active_web".to_string(),
    };

    let record = StoredActivitySession {
        id: event.event_id,
        device_id: event.device_id,
        application_name: app_name,
        executable_name: exe_name,
        process_id: pid,
        started_at: event.started_at,
        ended_at: event.ended_at,
        duration_seconds: event.duration_seconds,
        activity_state,
        created_at: Utc::now(),
    };

    if let Err(err) = storage.record_session_with_event(&record, &payload_json) {
        error!(error = %err, "Failed to persist session to SQLite");
    } else {
        info!(
            event_id = %event.event_id,
            duration_secs = event.duration_seconds,
            event_type = ?event.event_type,
            "Saved session to local SQLite buffer"
        );
    }
}

fn get_or_create_device_id(storage: &mut Storage) -> Result<Uuid> {
    if let Ok(Some(existing)) = storage.get_state("device_id") {
        if let Ok(id) = Uuid::parse_str(&existing) {
            return Ok(id);
        }
    }
    let new_id = Uuid::new_v4();
    storage
        .set_state("device_id", &new_id.to_string())
        .context("failed to persist device_id")?;
    Ok(new_id)
}

fn get_database_path() -> PathBuf {
    if let Ok(custom) = std::env::var("DP_DB_PATH") {
        return PathBuf::from(custom);
    }
    // Local dev: place agent_storage.db in current working directory or user AppData
    let mut path = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    path.push("agent_storage.db");
    path
}

fn parse_arg_value(flag: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}

fn init_logging() {
    let filter = EnvFilter::try_from_env("DP_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}
