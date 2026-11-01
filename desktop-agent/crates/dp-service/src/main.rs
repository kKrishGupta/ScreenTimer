//! DigitalPulse Windows Service.
//!
//! Will run in Session 0 and must never show UI (the tray icon belongs to the user agent).
//! Following the Stage 1 plan, the service is introduced only after the user-session
//! collector is verified, and it is never installed automatically during development.
//! This binary currently only reports its intended IPC endpoint.

use anyhow::Result;
use dp_core::AGENT_VERSION;
use tracing::info;
use tracing_subscriber::EnvFilter;

fn main() -> Result<()> {
    let filter = EnvFilter::try_from_env("DP_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();

    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("dp-service {AGENT_VERSION}");
        return Ok(());
    }

    info!(
        version = AGENT_VERSION,
        pipe = dp_ipc::PIPE_NAME,
        "dp-service is not yet active in Stage 1 Milestone 1; no service is installed"
    );
    Ok(())
}
