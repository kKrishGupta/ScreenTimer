//! DigitalPulse user-session agent.
//!
//! Milestone 3: Activity session management and SQLite persistence.

use anyhow::{bail, Context, Result};
use chrono::Utc;
use dp_core::{
    ActivityEvent, AgentConfig, DeviceInfo, EventSource, EventType, SessionManager, AGENT_VERSION,
};
use dp_platform_windows::{
    get_current_foreground_app, get_current_process_metrics, get_system_idle_duration,
    is_workstation_locked, ActivityMonitor, PlatformEvent,
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

mod screenshot;
mod sync;
use sync::sync_pending_events;

fn main() -> Result<()> {
    init_logging();

    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("dp-user-agent {AGENT_VERSION}");
        return Ok(());
    }

    if !dp_platform_windows::is_supported_platform() {
        bail!("DigitalPulse user agent only supports Windows 11");
    }

    if let Some(server) = parse_arg_value("--server").or_else(|| parse_arg_value("--backend-url")) {
        std::env::set_var("DP_BACKEND_URL", server);
    }

    if std::env::args().nth(1).as_deref() == Some("enroll")
        || std::env::args().any(|a| a == "--enroll")
    {
        return run_enroll();
    }

    if std::env::args().any(|a| a == "--status" || a == "status") {
        return run_status();
    }

    if std::env::args().any(|a| a == "--oneshot") {
        return run_oneshot();
    }

    if std::env::args().any(|a| a == "--sync-now") {
        return run_sync_now();
    }

    let run_duration_secs = parse_arg_value("--run-duration").and_then(|s| s.parse::<u64>().ok());
    run_monitor(run_duration_secs)
}

fn load_stored_credentials(storage: &mut Storage, device_id: &Uuid) -> Result<Option<String>> {
    if let Ok(secret) = std::env::var("DP_DEVICE_SECRET") {
        if !secret.trim().is_empty() {
            return Ok(Some(secret));
        }
    }
    if let Some(secret) = dp_platform_windows::credential_store::read_device_secret(
        &device_id.to_string(),
    )
    .map_err(|_| {
        anyhow::anyhow!("Windows Credential Manager could not be read; monitoring is paused")
    })? {
        std::env::set_var("DP_DEVICE_SECRET", &secret);
        if std::env::var("DP_BACKEND_URL").is_err() {
            if let Ok(Some(url)) = storage.get_state("backend_url") {
                std::env::set_var("DP_BACKEND_URL", url);
            }
        }
        return Ok(Some(secret));
    }
    if let Some(legacy) = storage.get_state("device_secret")? {
        if !legacy.trim().is_empty() {
            dp_platform_windows::credential_store::store_device_secret(&device_id.to_string(), &legacy)
                .map_err(|_| anyhow::anyhow!("Could not migrate the device secret to Windows Credential Manager; monitoring is paused"))?;
            storage
                .delete_state("device_secret")
                .context("failed to remove the migrated device secret from SQLite")?;
            std::env::set_var("DP_DEVICE_SECRET", &legacy);
            if std::env::var("DP_BACKEND_URL").is_err() {
                if let Ok(Some(url)) = storage.get_state("backend_url") {
                    std::env::set_var("DP_BACKEND_URL", url);
                }
            }
            return Ok(Some(legacy));
        }
    }
    if std::env::var("DP_BACKEND_URL").is_err() {
        if let Ok(Some(url)) = storage.get_state("backend_url") {
            if !url.trim().is_empty() {
                std::env::set_var("DP_BACKEND_URL", url);
            }
        }
    }
    Ok(None)
}

fn run_enroll() -> Result<()> {
    let token = parse_arg_value("--token")
        .or_else(|| parse_arg_value("-t"))
        .context(
            "Missing required --token argument (e.g. dp-user-agent enroll --token dp_enroll_...)",
        )?;

    let backend_url = parse_arg_value("--server")
        .or_else(|| parse_arg_value("--backend-url"))
        .or_else(|| std::env::var("DP_BACKEND_URL").ok())
        .unwrap_or_else(|| "http://127.0.0.1:3001".to_string());

    let db_path = get_database_path()?;
    let mut storage = Storage::open(&db_path).context("failed to open SQLite storage")?;
    let device_id = get_or_create_device_id(&mut storage)?;
    let device_name = parse_arg_value("--name")
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "Windows Device".into());

    println!("==================================================");
    println!("   DIGITALPULSE ENDPOINT AGENT ENROLLMENT         ");
    println!("==================================================");
    println!("Target Backend:  {}", backend_url);
    println!("Device ID:       {}", device_id);
    println!("Device Name:     {}", device_name);
    println!("Enrolling with token...");

    let secret = sync::enroll_device_token(&backend_url, &token, &device_id, &device_name)
        .context("device enrollment failed")?;

    dp_platform_windows::credential_store::store_device_secret(&device_id.to_string(), &secret)
        .map_err(|_| anyhow::anyhow!("enrollment succeeded but Windows Credential Manager could not store the device secret; do not start monitoring until it is stored securely"))?;
    storage
        .delete_state("device_secret")
        .context("failed to remove a legacy plaintext secret from SQLite")?;
    storage
        .set_state("backend_url", &backend_url)
        .context("failed to store backend URL in local SQLite buffer")?;

    println!("[✓] Device successfully enrolled!");
    println!("Device Secret:   [PROTECTED AND STORED SECURELY]");
    println!("Backend URL:     {}", backend_url);
    println!("Status:          Enrolled; connection requires an authenticated heartbeat.");
    println!("Run 'dp-user-agent' to connect. Collection stays paused until the server confirms consent, administrator approval, and an active schedule.");
    println!("==================================================");

    Ok(())
}

fn run_status() -> Result<()> {
    let db_path = get_database_path()?;
    let mut storage = Storage::open(&db_path).context("failed to open SQLite storage")?;
    let device_id = get_or_create_device_id(&mut storage)?;
    let credentials = load_stored_credentials(&mut storage, &device_id)?;
    let backend_url = storage
        .get_state("backend_url")
        .unwrap_or(None)
        .or_else(|| std::env::var("DP_BACKEND_URL").ok())
        .unwrap_or_else(|| "http://127.0.0.1:3001".into());

    let pending = storage.count_pending_sync().unwrap_or(0);
    let total_stored = storage.count_sessions().unwrap_or(0);
    println!("==================================================");
    println!("   DIGITALPULSE ENDPOINT AGENT STATUS             ");
    println!("==================================================");
    println!("Version:         {}", AGENT_VERSION);
    println!("Storage:         {}", db_path.display());
    println!("Device ID:       {}", device_id);
    println!(
        "Enrollment:      {}",
        if credentials.is_some() {
            "ENROLLED"
        } else {
            "NOT ENROLLED (run 'dp-user-agent enroll --token <token>')"
        }
    );
    println!("Backend URL:     {}", backend_url);
    println!("Pending Queue:   {} sessions", pending);
    println!("Total Recorded:  {} sessions", total_stored);
    println!("Live activity:   Read only during authorized monitoring");
    println!("==================================================");
    Ok(())
}

fn run_sync_now() -> Result<()> {
    let db_path = get_database_path()?;
    let mut storage = Storage::open(&db_path).context("failed to open SQLite storage")?;
    let device_id = get_or_create_device_id(&mut storage)?;
    if load_stored_credentials(&mut storage, &device_id)?.is_none() {
        bail!("device is not enrolled; no activity will be synchronized");
    }
    let config = AgentConfig::from_env().context("invalid agent configuration")?;
    let device_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows Device".into());

    let device = DeviceInfo {
        id: device_id,
        kind: EventSource::DesktopAgent,
        name: device_name,
        platform: "windows_11".into(),
        browser: None,
        agent_version: Some(AGENT_VERSION.to_string()),
    };

    let gate = sync::send_startup_heartbeat(&config.backend_url, &device)?;
    if !gate_is_active(&gate, Utc::now()) {
        bail!(
            "monitoring is paused by server authorization; local queue remains intact ({})",
            gate.reason.as_deref().unwrap_or("policy unavailable")
        );
    }

    let pending_before = storage.count_pending_sync().unwrap_or(0);
    println!("Pending sync queue size before: {}", pending_before);

    let outcome = sync_pending_events(&mut storage, &config.backend_url, &device, 100)?;
    println!(
        "Sync completed: attempted {}, acknowledged {}, rejected {}, quarantined {}",
        outcome.attempted, outcome.synced, outcome.rejected, outcome.quarantined
    );

    let pending_after = storage.count_pending_sync().unwrap_or(0);
    println!("Pending sync queue size after: {}", pending_after);
    Ok(())
}

fn run_oneshot() -> Result<()> {
    let mut storage =
        Storage::open(get_database_path()?).context("failed to open SQLite storage")?;
    let device_id = get_or_create_device_id(&mut storage)?;
    if load_stored_credentials(&mut storage, &device_id)?.is_none() {
        bail!("device is not enrolled; no live activity data was read");
    }
    let config = AgentConfig::from_env().context("invalid agent configuration")?;
    let device = DeviceInfo {
        id: device_id,
        kind: EventSource::DesktopAgent,
        name: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows Device".into()),
        platform: "windows_11".into(),
        browser: None,
        agent_version: Some(AGENT_VERSION.to_string()),
    };
    let gate = sync::send_startup_heartbeat(&config.backend_url, &device)
        .context("server authorization could not be verified; no live activity data was read")?;
    if !gate_is_active(&gate, Utc::now()) {
        bail!("monitoring is paused by server authorization; no live activity data was read");
    }

    let idle = get_system_idle_duration();
    let app = get_current_foreground_app();
    let metrics = get_current_process_metrics();

    println!("=== DigitalPulse Oneshot Query ===");
    println!("System Idle Duration: {:.1}s", idle.as_secs_f64());
    match app {
        Ok(a) => {
            println!("Foreground Executable: {}", a.executable_name);
            println!("Foreground PID:        {}", a.process_id);
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
    let db_path = get_database_path()?;
    info!(path = %db_path.display(), "Opening SQLite local storage buffer");

    let mut storage = Storage::open(&db_path).context("failed to initialize SQLite storage")?;
    let device_id = get_or_create_device_id(&mut storage)?;
    if load_stored_credentials(&mut storage, &device_id)?.is_none() {
        warn!("Device is not enrolled; monitor will not collect activity");
        return Ok(());
    }
    let config = AgentConfig::from_env().context("invalid agent configuration")?;

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
    let mut screenshot_scheduler = screenshot::ScreenshotScheduler::new(
        db_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    )?;
    let mut screen_monitoring_indicator =
        dp_platform_windows::tray::ScreenMonitoringIndicator::new();

    let device_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows Device".into());
    let device_info = DeviceInfo {
        id: device_id,
        kind: EventSource::DesktopAgent,
        name: device_name,
        platform: "windows_11".into(),
        browser: None,
        agent_version: Some(AGENT_VERSION.to_string()),
    };

    let start_time = Instant::now();
    let mut last_sync_time = Instant::now();
    let mut total_ticks: u64 = 0;
    let mut recorded_sessions: u64 = 0;

    let mut gate = match sync::send_startup_heartbeat(&config.backend_url, &device_info) {
        Ok(gate) => gate,
        Err(err) => {
            warn!(
                error = format!("{:#}", err),
                "Startup heartbeat unavailable; monitoring is paused"
            );
            sync::MonitoringGate {
                allowed: false,
                allowed_from: None,
                allowed_until: None,
                reason: Some("HEARTBEAT_UNAVAILABLE".into()),
            }
        }
    };
    let mut screen_policy = sync::fetch_screen_monitoring_policy(&config.backend_url, &device_info)
        .unwrap_or_else(|error| {
            warn!(error = %error, "Screenshot policy unavailable; work-screen capture remains disabled");
            sync::ScreenMonitoringPolicy { allowed: false, reason: Some("POLICY_UNAVAILABLE".into()), interval_seconds: 300, excluded_applications: Vec::new(), visible_indicator: true, allowed_until: None }
        });
    let mut last_sample_at = Utc::now();
    if gate_is_active(&gate, Utc::now()) {
        match sync_pending_events(&mut storage, &config.backend_url, &device_info, 50) {
            Ok(outcome) if outcome.synced > 0 => info!(
                synced = outcome.synced,
                rejected = outcome.rejected,
                "Flushed acknowledged offline events"
            ),
            Ok(_) => {}
            Err(err) => warn!(error = %err, "Startup sync deferred; pending rows remain in SQLite"),
        }
    } else {
        warn!(reason = gate.reason.as_deref().unwrap_or("MONITORING_CONFIGURATION_UNAVAILABLE"), "Monitoring paused until consent, authorization, organization time zone, and schedule checks pass");
    }

    let sample_interval = config.sample_interval;

    while running.load(Ordering::SeqCst) {
        if let Some(max_secs) = max_duration_secs {
            if start_time.elapsed() >= Duration::from_secs(max_secs) {
                info!("Max run duration of {max_secs}s reached, exiting monitoring loop");
                break;
            }
        }

        total_ticks += 1;
        let now = Utc::now();
        let gap = now - last_sample_at;
        if gate_is_active(&gate, now)
            && gap
                > chrono::Duration::from_std(sample_interval.saturating_mul(3)).unwrap_or_default()
        {
            if let Some(event) = session_manager.close_active_session(last_sample_at) {
                save_completed_event(&mut storage, &event);
                recorded_sessions += 1;
            }
            monitor.reset();
            warn!(gap_seconds = gap.num_seconds(), "System sleep or agent suspension detected; activity interval closed before the gap");
        }
        last_sample_at = now;

        let monitoring_now = gate_is_active(&gate, now);
        if !monitoring_now {
            if let Some(event) =
                session_manager.close_active_session(gate.allowed_until.unwrap_or(now))
            {
                save_completed_event(&mut storage, &event);
                recorded_sessions += 1;
            }
            monitor.reset();
        }

        let events = if monitoring_now {
            monitor.tick()
        } else {
            Vec::new()
        };

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
                    let authorized_idle = gate
                        .allowed_from
                        .and_then(|since| (now - since).to_std().ok())
                        .map(|elapsed| elapsed.min(idle_duration))
                        .unwrap_or(Duration::ZERO);
                    session_manager.handle_idle_start(authorized_idle, now)
                }
                PlatformEvent::UserResumed { total_idle } => {
                    session_manager.handle_idle_return(total_idle, now)
                }
                PlatformEvent::SessionLocked => {
                    info!("Windows session is locked; foreground collection paused");
                    session_manager.close_active_session(now)
                }
                PlatformEvent::SessionUnlocked => {
                    info!("Windows session unlocked; foreground collection resumed");
                    None
                }
            };

            if let Some(session_event) = completed_session {
                save_completed_event(&mut storage, &session_event);
                recorded_sessions += 1;
            }
        }

        let mut effective_screen_policy = screen_policy.clone();
        if !monitoring_now
            || is_workstation_locked()
            || effective_screen_policy
                .allowed_until
                .is_none_or(|until| Utc::now() >= until)
        {
            effective_screen_policy.allowed = false;
        }
        let indicator_visible = screen_monitoring_indicator.set_active(
            effective_screen_policy.allowed && effective_screen_policy.visible_indicator,
        );
        // A server policy that requires a visible indicator is not sufficient by
        // itself: capture must also stop if Windows could not actually add the
        // notification-area icon in the interactive employee session.
        effective_screen_policy.visible_indicator = indicator_visible;
        let foreground_name = get_current_foreground_app()
            .map(|application| application.executable_name)
            .unwrap_or_else(|_| "Windows desktop".into());
        screenshot_scheduler.tick(
            &effective_screen_policy,
            &config.backend_url,
            &device_info,
            &foreground_name,
        );

        // Periodic background synchronization to backend
        if last_sync_time.elapsed() >= config.sync_interval {
            let previous_gate = gate.clone();
            gate = match sync::send_startup_heartbeat(&config.backend_url, &device_info) {
                Ok(value) => value,
                Err(err) => {
                    warn!(
                        error = format!("{:#}", err),
                        "Periodic heartbeat unavailable; monitoring paused"
                    );
                    sync::MonitoringGate {
                        allowed: false,
                        allowed_from: None,
                        allowed_until: None,
                        reason: Some("HEARTBEAT_UNAVAILABLE".into()),
                    }
                }
            };
            screen_policy = sync::fetch_screen_monitoring_policy(&config.backend_url, &device_info)
                .unwrap_or_else(|error| {
                    warn!(error = %error, "Screenshot policy refresh failed; capture paused until policy can be verified");
                    sync::ScreenMonitoringPolicy { allowed: false, reason: Some("POLICY_UNAVAILABLE".into()), interval_seconds: 300, excluded_applications: Vec::new(), visible_indicator: true, allowed_until: None }
                });
            if !gate_is_active(&gate, Utc::now()) && previous_gate.allowed {
                let end = if gate.reason.as_deref() == Some("OUTSIDE_SCHEDULE") {
                    previous_gate.allowed_until.unwrap_or_else(Utc::now)
                } else {
                    Utc::now()
                };
                if let Some(event) = session_manager.close_active_session(end) {
                    save_completed_event(&mut storage, &event);
                    recorded_sessions += 1;
                }
                monitor.reset();
            }
            if gate_is_active(&gate, Utc::now()) {
                match sync_pending_events(&mut storage, &config.backend_url, &device_info, 50) {
                    Ok(outcome) if outcome.synced > 0 => info!(
                        synced = outcome.synced,
                        rejected = outcome.rejected,
                        "Background sync processed acknowledged events"
                    ),
                    Ok(_) => {}
                    Err(err) => warn!(
                        error = format!("{:#}", err),
                        "Periodic sync deferred; pending records remain in SQLite"
                    ),
                }
            } else {
                warn!(
                    reason = gate
                        .reason
                        .as_deref()
                        .unwrap_or("MONITORING_CONFIGURATION_UNAVAILABLE"),
                    "Sync paused; local queue preserved"
                );
            }
            last_sync_time = Instant::now();
        }

        thread::sleep(sample_interval);
    }

    // Flush any pending active session on shutdown
    let shutdown_time = Utc::now();
    let final_end = if gate_is_active(&gate, shutdown_time) {
        shutdown_time
    } else {
        gate.allowed_until.unwrap_or(shutdown_time)
    };
    if let Some(final_event) = session_manager.close_active_session(final_end) {
        save_completed_event(&mut storage, &final_event);
        recorded_sessions += 1;
    }

    // Final synchronization attempt before shutdown
    match if gate_is_active(&gate, shutdown_time) {
        sync_pending_events(&mut storage, &config.backend_url, &device_info, 100)
    } else {
        Ok(sync::SyncOutcome {
            attempted: 0,
            synced: 0,
            rejected: 0,
            quarantined: 0,
        })
    } {
        Ok(outcome) if outcome.synced > 0 => {
            info!(
                synced = outcome.synced,
                rejected = outcome.rejected,
                "Final flush synchronized acknowledged events"
            );
        }
        Ok(_) => {}
        Err(err) => {
            info!(error = %err, "Shutdown sync note: remaining events safely stored in SQLite for next start");
        }
    }

    // Benchmark & summary report
    let elapsed = start_time.elapsed();
    let metrics = get_current_process_metrics();
    let total_stored = storage.count_sessions().unwrap_or(0);
    let pending_sync = storage.count_pending_sync().unwrap_or(0);
    let quarantined_sync = storage.count_quarantined_sync().unwrap_or(0);

    info!("=== Performance & Profile Summary ===");
    info!(
        elapsed_secs = elapsed.as_secs_f64(),
        total_ticks = total_ticks,
        sessions_recorded_this_run = recorded_sessions,
        total_stored_sessions = total_stored,
        pending_sync_queue = pending_sync,
        quarantined_sync_queue = quarantined_sync,
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

fn gate_is_active(gate: &sync::MonitoringGate, now: chrono::DateTime<Utc>) -> bool {
    gate.allowed
        && gate.allowed_from.is_some_and(|start| now >= start)
        && gate.allowed_until.is_some_and(|end| now < end)
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

fn get_database_path() -> Result<PathBuf> {
    let custom = std::env::var_os("DP_DB_PATH").map(PathBuf::from);
    #[cfg(windows)]
    let path = dp_storage::paths::database_path(
        custom.as_deref(),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .as_deref(),
    )
    .context("could not resolve persistent agent storage")?;
    #[cfg(not(windows))]
    let path = custom
        .clone()
        .unwrap_or(std::env::current_dir()?.join("agent_storage.db"));

    let mut legacy = Vec::new();
    if custom.is_none() {
        legacy.push(std::env::current_dir()?.join("agent_storage.db"));
        if let Some(parent) = std::env::current_exe()?.parent() {
            legacy.push(parent.join("agent_storage.db"));
        }
        legacy.retain(|candidate| candidate != &path);
    }
    dp_storage::paths::prepare_database_path(&path, &legacy)
        .map_err(|error| anyhow::anyhow!("Persistent agent storage is unavailable: {error}"))?;
    Ok(path)
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
