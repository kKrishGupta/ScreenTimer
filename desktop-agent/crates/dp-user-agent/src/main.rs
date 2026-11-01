//! DigitalPulse user-session agent.
//!
//! Runs in the interactive Windows session. Milestone 1 provides the executable skeleton:
//! logging, configuration loading and a platform check. Collectors are added in
//! Milestone 2 and the session manager plus SQLite persistence in Milestone 3.

use anyhow::{bail, Context, Result};
use dp_core::{AgentConfig, AGENT_VERSION};
use tracing::info;
use tracing_subscriber::EnvFilter;

fn main() -> Result<()> {
    init_logging();

    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("dp-user-agent {AGENT_VERSION}");
        return Ok(());
    }

    if !dp_platform_windows::is_supported_platform() {
        bail!("DigitalPulse user agent only supports Windows");
    }

    let config = AgentConfig::from_env().context("invalid agent configuration")?;
    info!(
        version = AGENT_VERSION,
        idle_threshold_secs = config.idle_threshold.as_secs(),
        sample_interval_ms = config.sample_interval.as_millis() as u64,
        backend = %config.backend_url,
        storage_schema = dp_storage::STORED_SCHEMA_VERSION,
        "DigitalPulse user agent initialised"
    );
    info!("foreground and idle collectors are introduced in Milestone 2; exiting");
    Ok(())
}

fn init_logging() {
    let filter = EnvFilter::try_from_env("DP_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}
