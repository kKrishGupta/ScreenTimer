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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendUrl {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub base_path: String,
}

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
    #[error("sync interval must be between 5 and 3600 seconds")]
    SyncIntervalOutOfRange,
    #[error("invalid backend URL: {0}")]
    InvalidBackendUrl(String),
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
        let allow_remote = lookup("DP_ALLOW_REMOTE_BACKEND")
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        cfg.validate_with_remote(allow_remote)?;
        Ok(cfg)
    }

    /// Validates invariants.
    pub fn validate(&self) -> Result<(), ConfigError> {
        let allow_remote = std::env::var("DP_ALLOW_REMOTE_BACKEND")
            .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        self.validate_with_remote(allow_remote)
    }

    fn validate_with_remote(&self, allow_remote: bool) -> Result<(), ConfigError> {
        if !(5..=3600).contains(&self.idle_threshold.as_secs()) {
            return Err(ConfigError::IdleThresholdOutOfRange);
        }
        if !(5..=3600).contains(&self.sync_interval.as_secs()) {
            return Err(ConfigError::SyncIntervalOutOfRange);
        }
        parse_backend_url(&self.backend_url, allow_remote)?;
        Ok(())
    }
}

pub fn parse_backend_url(raw: &str, allow_remote: bool) -> Result<BackendUrl, ConfigError> {
    let invalid = |message: &str| ConfigError::InvalidBackendUrl(message.to_owned());
    let (scheme, stripped) = raw
        .strip_prefix("http://")
        .map(|value| ("http", value))
        .or_else(|| raw.strip_prefix("https://").map(|value| ("https", value)))
        .ok_or_else(|| invalid("an explicit http:// or https:// scheme is required"))?;
    let (host_port, path) = stripped.find('/').map_or((stripped, ""), |index| {
        (&stripped[..index], &stripped[index..])
    });
    if host_port.contains(['?', '#', '@', '\\'])
        || path.contains(['?', '#', '\\'])
        || raw.chars().any(char::is_whitespace)
    {
        return Err(invalid(
            "credentials, whitespace, query strings, fragments and backslashes are forbidden",
        ));
    }
    let (host, port) = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (host, suffix) = bracketed
            .split_once(']')
            .ok_or_else(|| invalid("invalid IPv6 host"))?;
        let port = if suffix.is_empty() {
            if scheme == "https" {
                443
            } else {
                80
            }
        } else {
            suffix
                .strip_prefix(':')
                .ok_or_else(|| invalid("invalid IPv6 port"))?
                .parse::<u16>()
                .map_err(|_| invalid("invalid port"))?
        };
        (host.to_ascii_lowercase(), port)
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) => (
                host.to_ascii_lowercase(),
                port.parse::<u16>().map_err(|_| invalid("invalid port"))?,
            ),
            None => (
                host_port.to_ascii_lowercase(),
                if scheme == "https" { 443 } else { 80 },
            ),
        }
    };
    if host.is_empty() || port == 0 {
        return Err(invalid("host and non-zero port are required"));
    }
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if !loopback && scheme != "https" {
        return Err(invalid("remote backends require HTTPS"));
    }
    if !loopback && !allow_remote {
        return Err(invalid(
            "remote HTTPS requires DP_ALLOW_REMOTE_BACKEND=true",
        ));
    }
    Ok(BackendUrl {
        scheme: scheme.into(),
        host,
        port,
        base_path: path.trim_end_matches('/').to_owned(),
    })
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
            Err(ConfigError::InvalidBackendUrl(_))
        ));
    }

    #[test]
    fn backend_url_policy_is_exact_and_shared() {
        assert!(parse_backend_url("http://localhost.evil.test", false).is_err());
        assert!(parse_backend_url("http://10.0.0.2:3001", true).is_err());
        assert!(parse_backend_url("https://api.example.test/base", false).is_err());
        let remote = parse_backend_url("https://API.Example.test/base/", true)
            .expect("remote HTTPS fixture must be accepted with explicit opt-in");
        assert_eq!(remote.host, "api.example.test");
        assert_eq!(remote.base_path, "/base");
        assert!(parse_backend_url("https://user@api.example.test", true).is_err());
    }

    #[test]
    fn sync_interval_rejects_busy_polling_and_excessive_delays() {
        for value in ["0", "1", "4", "3601", "18446744073709551615"] {
            assert_eq!(
                AgentConfig::from_lookup(lookup(&[("DP_SYNC_INTERVAL_SECS", value)])),
                Err(ConfigError::SyncIntervalOutOfRange)
            );
        }
        for value in ["5", "30", "3600"] {
            assert!(AgentConfig::from_lookup(lookup(&[("DP_SYNC_INTERVAL_SECS", value)])).is_ok());
        }
    }
}
