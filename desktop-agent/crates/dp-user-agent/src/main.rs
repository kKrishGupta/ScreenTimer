//! DigitalPulse user-session agent.
//!
//! Milestone 2: Native Windows foreground application detection, process
//! identification, idle detection, and resource profiling.

use anyhow::{bail, Context, Result};
use dp_core::{AgentConfig, AGENT_VERSION};
use dp_platform_windows::{
    get_current_foreground_app, get_current_process_metrics, get_system_idle_duration,
    ActivityMonitor, PlatformEvent,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

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
    info!(
        version = AGENT_VERSION,
        idle_threshold_secs = config.idle_threshold.as_secs(),
        sample_interval_ms = config.sample_interval.as_millis() as u64,
        "Starting DigitalPulse user-session monitor"
    );

    let running = Arc::new(AtomicBool::new(true));
    dp_platform_windows::register_console_ctrl_handler(running.clone());

    let mut monitor = ActivityMonitor::new(config.idle_threshold);
    let start_time = Instant::now();
    let mut total_ticks: u64 = 0;
    let mut app_switches: u64 = 0;
    let mut idle_events: u64 = 0;

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
            match event {
                PlatformEvent::AppFocused { previous, current } => {
                    app_switches += 1;
                    let prev_name = previous
                        .map(|p| p.executable_name)
                        .unwrap_or_else(|| "none".into());
                    info!(
                        from = %prev_name,
                        to = %current.executable_name,
                        pid = current.process_id,
                        path = current.executable_path.as_deref().unwrap_or(""),
                        "Application focused"
                    );
                }
                PlatformEvent::IdleStarted { idle_duration } => {
                    idle_events += 1;
                    info!(idle_secs = idle_duration.as_secs(), "User is now idle");
                }
                PlatformEvent::UserResumed { total_idle } => {
                    info!(idle_secs = total_idle.as_secs(), "User resumed activity");
                }
            }
        }

        thread::sleep(sample_interval);
    }

    // Benchmark & resource profiling report
    let elapsed = start_time.elapsed();
    let metrics = get_current_process_metrics();

    info!("=== Performance & Profile Summary ===");
    info!(
        elapsed_secs = elapsed.as_secs_f64(),
        total_ticks = total_ticks,
        app_switches = app_switches,
        idle_events = idle_events,
        "Run statistics"
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

        if m.peak_working_set_mb > 15.0 {
            warn!("Working set exceeded 15 MB engineering target");
        }
        if cpu_percentage > 1.0 {
            warn!("Average CPU exceeded 1% engineering target");
        }
    }

    Ok(())
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
