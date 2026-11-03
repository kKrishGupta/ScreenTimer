//! Agent configuration.
//!
//! Stage 1 uses compiled defaults that may be overridden through environment variables.
//! A persisted configuration managed by the service arrives with the IPC milestone.

use std::time::Duration;

use thiserror::Error;

/// Default idle threshold mandated by the Stage 1 specification.
pub const DEFAULT_IDLE_THRESHOLD: Duration = Duration::from_secs(60);
/// Default local backend (development only, loopback).
pub const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:3001";

/// Runtime configuration for the user-session agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    /// Time without keyboard/mouse input after which the user is considered idle.
    pub idle_threshold: Duration,
    /// Sampling resolution for idle checks and foreground fallback polling.
    pub sample_interval: Duration,
    /// Base URL of the local backend.
    pub backend_url: String,
    /// Interval between synchronisation attempts.
    pub sync_interval: Duration,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            idle_threshold: DEFAULT_IDLE_THRESHOLD,
            sample_interval: Duration::from_secs(1),
            backend_url: DEFAULT_BACKEND_URL.to_owned(),
            sync_interval: Duration::from_secs(30),
        }
    }
}

/// Configuration errors.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("environment variable {name} has invalid value '{value}'")]
    InvalidEnv { name: &'static str, value: String },
    #[error("idle threshold must be between 5 and 3600 seconds")]
    IdleThresholdOutOfRange,
    #[error("backend URL must target the loopback interface in Stage 1: '{0}'")]
    NonLocalBackend(String),
}

impl AgentConfig {
    /// Builds configuration from defaults plus `DP_*` environment overrides.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Testable variant of [`AgentConfig::from_env`] with an injectable lookup.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let mut cfg = Self::default();
        if let Some(raw) = lookup("DP_IDLE_THRESHOLD_SECS") {
            cfg.idle_threshold = parse_secs("DP_IDLE_THRESHOLD_SECS", &raw)?;
        }
        if let Some(raw) = lookup("DP_SYNC_INTERVAL_SECS") {
            cfg.sync_interval = parse_secs("DP_SYNC_INTERVAL_SECS", &raw)?;
        }
        if let Some(url) = lookup("DP_BACKEND_URL") {
            cfg.backend_url = url.trim_end_matches('/').to_owned();
        }
        cfg.validate()?;
        Ok(cfg)
    }

    /// Validates invariants.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if !(5..=3600).contains(&self.idle_threshold.as_secs()) {
            return Err(ConfigError::IdleThresholdOutOfRange);
        }
        let local = ["http://127.0.0.1", "http://localhost", "http://[::1]"]
            .iter()
            .any(|prefix| self.backend_url.starts_with(prefix));
        let allow_remote = std::env::var("DP_ALLOW_REMOTE_BACKEND")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !local && !allow_remote {
            return Err(ConfigError::NonLocalBackend(self.backend_url.clone()));
        }
        Ok(())
    }
}

fn parse_secs(name: &'static str, raw: &str) -> Result<Duration, ConfigError> {
    raw.trim()
        .parse::<u64>()
        .map(Duration::from_secs)
        .map_err(|_| ConfigError::InvalidEnv {
            name,
            value: raw.to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn defaults_match_specification() {
        let cfg = AgentConfig::from_lookup(lookup(&[])).expect("defaults are valid");
        assert_eq!(cfg.idle_threshold, Duration::from_secs(60));
        assert_eq!(cfg.backend_url, "http://127.0.0.1:3001");
    }

    #[test]
    fn env_overrides_apply() {
        let cfg = AgentConfig::from_lookup(lookup(&[
            ("DP_IDLE_THRESHOLD_SECS", "120"),
            ("DP_BACKEND_URL", "http://localhost:4000/"),
        ]))
        .expect("valid overrides");
        assert_eq!(cfg.idle_threshold, Duration::from_secs(120));
        assert_eq!(cfg.backend_url, "http://localhost:4000");
    }

    #[test]
    fn invalid_values_rejected() {
        assert!(matches!(
            AgentConfig::from_lookup(lookup(&[("DP_IDLE_THRESHOLD_SECS", "abc")])),
            Err(ConfigError::InvalidEnv { .. })
        ));
        assert_eq!(
            AgentConfig::from_lookup(lookup(&[("DP_IDLE_THRESHOLD_SECS", "1")])),
            Err(ConfigError::IdleThresholdOutOfRange)
        );
        assert!(matches!(
            AgentConfig::from_lookup(lookup(&[("DP_BACKEND_URL", "https://example.com")])),
            Err(ConfigError::NonLocalBackend(_))
        ));
    }
}
