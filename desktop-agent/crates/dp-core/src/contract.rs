//! Activity event contract (v1).
//!
//! Mirrors `shared/contracts/schemas/activity-event.v1.schema.json` and
//! `activity-batch.v1.schema.json`. The integration test `tests/contract_fixtures.rs`
//! round-trips the shared JSON fixtures through these types to keep Rust, JavaScript and
//! the backend in agreement.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Current contract version.
pub const SCHEMA_VERSION: u32 = 1;
/// Collectors must split intervals longer than this.
pub const MAX_EVENT_DURATION_SECONDS: f64 = 86_400.0;
/// Upper bound on events per batch accepted by the backend.
pub const MAX_BATCH_SIZE: usize = 500;
/// Tolerance when comparing the reported duration with the wall-clock interval.
const DURATION_TOLERANCE_SECONDS: f64 = 1.0;

/// Which collector produced an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    DesktopAgent,
    BrowserExtension,
}

/// Kind of activity interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    AppSession,
    WebSession,
    IdleSession,
}

/// Supported browsers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Browser {
    Chrome,
    Edge,
}

/// Foreground application metadata. Deliberately excludes window titles and content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppInfo {
    pub name: String,
    pub executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
}

/// Website metadata. Domain only: never a path, query string or fragment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebInfo {
    pub domain: String,
    pub browser: Browser,
}

/// A completed, immutable activity interval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityEvent {
    pub schema_version: u32,
    pub event_id: Uuid,
    pub device_id: Uuid,
    pub source: EventSource,
    #[serde(rename = "type")]
    pub event_type: EventType,
    #[serde(with = "utc_millis")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "utc_millis")]
    pub ended_at: DateTime<Utc>,
    pub duration_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<AppInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<WebInfo>,
}

/// Collector identity sent with each batch (enables local auto-registration in Stage 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceInfo {
    pub id: Uuid,
    pub kind: EventSource,
    pub name: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<Browser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
}

/// Request body for `POST /api/v1/activity/events/batch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityBatch {
    pub device: DeviceInfo,
    pub events: Vec<ActivityEvent>,
}

/// Contract violations detected before an event is persisted or transmitted.
#[derive(Debug, Error, PartialEq)]
pub enum ContractError {
    #[error("unsupported schema version {0}")]
    UnsupportedVersion(u32),
    #[error("endedAt precedes startedAt")]
    NegativeInterval,
    #[error("durationSeconds {0} is outside the allowed range")]
    DurationOutOfRange(f64),
    #[error("durationSeconds exceeds the wall-clock interval")]
    DurationExceedsInterval,
    #[error("{0:?} event has missing or unexpected app/web metadata")]
    MetadataMismatch(EventType),
    #[error("invalid domain '{0}'")]
    InvalidDomain(String),
    #[error("app metadata field '{0}' is empty or too long")]
    InvalidAppField(&'static str),
    #[error("batch must contain between 1 and {MAX_BATCH_SIZE} events, got {0}")]
    InvalidBatchSize(usize),
}

impl ActivityEvent {
    /// Validates the semantic rules of the contract that serde cannot express.
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(ContractError::UnsupportedVersion(self.schema_version));
        }
        if self.ended_at < self.started_at {
            return Err(ContractError::NegativeInterval);
        }
        if !(0.0..=MAX_EVENT_DURATION_SECONDS).contains(&self.duration_seconds) {
            return Err(ContractError::DurationOutOfRange(self.duration_seconds));
        }
        let interval = (self.ended_at - self.started_at).num_milliseconds() as f64 / 1000.0;
        if self.duration_seconds > interval + DURATION_TOLERANCE_SECONDS {
            return Err(ContractError::DurationExceedsInterval);
        }
        match (self.event_type, &self.app, &self.web) {
            (EventType::AppSession, Some(app), None) => validate_app(app),
            (EventType::WebSession, None, Some(web)) => validate_domain(&web.domain),
            (EventType::IdleSession, None, None) => Ok(()),
            (t, _, _) => Err(ContractError::MetadataMismatch(t)),
        }
    }
}

impl ActivityBatch {
    /// Validates batch size and every contained event.
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.events.is_empty() || self.events.len() > MAX_BATCH_SIZE {
            return Err(ContractError::InvalidBatchSize(self.events.len()));
        }
        self.events.iter().try_for_each(ActivityEvent::validate)
    }
}

fn validate_app(app: &AppInfo) -> Result<(), ContractError> {
    if app.name.is_empty() || app.name.chars().count() > 256 {
        return Err(ContractError::InvalidAppField("name"));
    }
    if app.executable.is_empty() || app.executable.chars().count() > 260 {
        return Err(ContractError::InvalidAppField("executable"));
    }
    Ok(())
}

fn validate_domain(domain: &str) -> Result<(), ContractError> {
    let valid = !domain.is_empty()
        && domain.len() <= 253
        && domain
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(ContractError::InvalidDomain(domain.to_owned()))
    }
}

/// RFC 3339 UTC timestamps with millisecond precision and a `Z` suffix, identical to
/// JavaScript's `Date.prototype.toISOString()`.
pub mod utc_millis {
    use chrono::{DateTime, SecondsFormat, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&value.to_rfc3339_opts(SecondsFormat::Millis, true))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        let raw = String::deserialize(d)?;
        DateTime::parse_from_rfc3339(&raw)
            .map(|dt| dt.with_timezone(&Utc))
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn idle_event(seconds: i64) -> ActivityEvent {
        let start = Utc
            .with_ymd_and_hms(2026, 11, 1, 10, 0, 0)
            .single()
            .expect("valid timestamp");
        ActivityEvent {
            schema_version: SCHEMA_VERSION,
            event_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            source: EventSource::DesktopAgent,
            event_type: EventType::IdleSession,
            started_at: start,
            ended_at: start + chrono::Duration::seconds(seconds),
            duration_seconds: seconds as f64,
            app: None,
            web: None,
        }
    }

    #[test]
    fn valid_idle_event_passes() {
        assert_eq!(idle_event(60).validate(), Ok(()));
    }

    #[test]
    fn negative_interval_rejected() {
        let mut e = idle_event(60);
        std::mem::swap(&mut e.started_at, &mut e.ended_at);
        assert_eq!(e.validate(), Err(ContractError::NegativeInterval));
    }

    #[test]
    fn duration_longer_than_interval_rejected() {
        let mut e = idle_event(60);
        e.duration_seconds = 120.0;
        assert_eq!(e.validate(), Err(ContractError::DurationExceedsInterval));
    }

    #[test]
    fn idle_event_with_app_metadata_rejected() {
        let mut e = idle_event(60);
        e.app = Some(AppInfo {
            name: "x".into(),
            executable: "x.exe".into(),
            process_id: None,
        });
        assert_eq!(
            e.validate(),
            Err(ContractError::MetadataMismatch(EventType::IdleSession))
        );
    }

    #[test]
    fn domain_with_path_rejected() {
        assert!(validate_domain("example.com/path").is_err());
        assert!(validate_domain("Example.com").is_err());
        assert!(validate_domain("sub.example-site.co.uk").is_ok());
    }

    #[test]
    fn timestamps_serialize_like_js_to_iso_string() {
        let json = serde_json::to_value(idle_event(5)).expect("serializable");
        assert_eq!(json["startedAt"], "2026-11-01T10:00:00.000Z");
        assert_eq!(json["endedAt"], "2026-11-01T10:00:05.000Z");
        assert!(json.get("app").is_none());
    }

    #[test]
    fn empty_batch_rejected() {
        let batch = ActivityBatch {
            device: DeviceInfo {
                id: Uuid::new_v4(),
                kind: EventSource::DesktopAgent,
                name: "DEV".into(),
                platform: "windows".into(),
                browser: None,
                agent_version: None,
            },
            events: vec![],
        };
        assert_eq!(batch.validate(), Err(ContractError::InvalidBatchSize(0)));
    }
}
