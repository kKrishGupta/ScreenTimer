//! Authenticated device enrollment, heartbeats, and offline event synchronization.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use dp_core::{parse_backend_url, ActivityBatch, ActivityEvent, DeviceInfo};
use dp_storage::Storage;
use std::collections::HashSet;
use std::fmt;
#[cfg(not(windows))]
use std::io::{Read, Write};
#[cfg(not(windows))]
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
#[cfg(not(windows))]
use std::time::Duration;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncOutcome {
    pub attempted: usize,
    pub synced: usize,
    pub rejected: usize,
    pub quarantined: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitoringGate {
    pub allowed: bool,
    pub allowed_from: Option<DateTime<Utc>>,
    pub allowed_until: Option<DateTime<Utc>>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenMonitoringPolicy {
    pub allowed: bool,
    pub reason: Option<String>,
    pub interval_seconds: u64,
    pub excluded_applications: Vec<String>,
    pub visible_indicator: bool,
    pub allowed_until: Option<DateTime<Utc>>,
}

#[derive(Debug)]
struct HttpResponse {
    body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendRejection {
    status: u16,
    code: String,
    message: String,
}

impl fmt::Display for BackendRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "backend rejected the device request with HTTP {} ({}): {}",
            self.status, self.code, self.message
        )
    }
}

impl std::error::Error for BackendRejection {}

fn backend_rejection(status: u16, body: &[u8]) -> anyhow::Error {
    let parsed = serde_json::from_slice::<serde_json::Value>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("DEVICE_REQUEST_REJECTED")
        .to_owned();
    let message = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("The backend rejected this device request")
        .to_owned();
    anyhow::Error::new(BackendRejection {
        status,
        code,
        message,
    })
}

/// Attempts to synchronize valid pending events. Invalid rows are retained in a
/// local quarantine so they cannot poison later batches or disappear silently.
pub fn sync_pending_events(
    storage: &mut Storage,
    backend_url: &str,
    device: &DeviceInfo,
    batch_size: usize,
) -> Result<SyncOutcome> {
    let pending = storage
        .get_pending_sync_items(batch_size)
        .context("failed to fetch pending items from SQLite sync queue")?;
    if pending.is_empty() {
        return Ok(SyncOutcome {
            attempted: 0,
            synced: 0,
            rejected: 0,
            quarantined: 0,
        });
    }

    let mut events = Vec::with_capacity(pending.len());
    let mut event_ids = Vec::with_capacity(pending.len());
    let mut malformed_ids = Vec::new();
    for item in &pending {
        match serde_json::from_str::<ActivityEvent>(&item.payload) {
            Ok(event) if event.validate().is_ok() && event.device_id == device.id => {
                events.push(event);
                event_ids.push(item.id);
            }
            Ok(event) => {
                let reason = if event.device_id != device.id {
                    "DEVICE_ID_MISMATCH"
                } else {
                    "INVALID_EVENT"
                };
                warn!(event_id = %item.id, reason, "Quarantining an invalid local activity event; payload is retained");
                storage.quarantine_events(&[item.id], reason)?;
                malformed_ids.push(item.id);
            }
            Err(_) => {
                warn!(event_id = %item.id, reason = "MALFORMED_JSON", "Quarantining malformed local activity data; payload is retained");
                storage.quarantine_events(&[item.id], "MALFORMED_JSON")?;
                malformed_ids.push(item.id);
            }
        }
    }
    if events.is_empty() {
        return Ok(SyncOutcome {
            attempted: pending.len(),
            synced: 0,
            rejected: 0,
            quarantined: malformed_ids.len(),
        });
    }

    let batch = ActivityBatch {
        device: device.clone(),
        events,
    };
    let body = serde_json::to_vec(&batch).context("failed to serialize activity batch")?;
    let response =
        post_batch_response(backend_url, &body).context("failed to post event batch to backend")?;
    let accepted = response
        .get("acceptedEventIds")
        .and_then(serde_json::Value::as_array)
        .context("backend response omitted accepted event IDs; queue retained")?;
    let deduplicated = response
        .get("deduplicatedEventIds")
        .and_then(serde_json::Value::as_array)
        .context("backend response omitted deduplicated event IDs; queue retained")?;
    let rejected = response
        .get("rejectedEventIds")
        .and_then(serde_json::Value::as_array)
        .context("backend response omitted rejected event IDs; queue retained")?;

    let sent: HashSet<String> = event_ids.iter().map(ToString::to_string).collect();
    let mut acked_ids = Vec::new();
    let mut acked_text = HashSet::new();
    for value in accepted.iter().chain(deduplicated.iter()) {
        let text = value
            .as_str()
            .context("backend returned a malformed event acknowledgement")?;
        if !sent.contains(text) || !acked_text.insert(text.to_string()) {
            bail!("backend returned an invalid event acknowledgement; queue retained");
        }
        acked_ids.push(
            text.parse()
                .context("backend returned a non-UUID event acknowledgement")?,
        );
    }
    let mut rejected_ids = Vec::new();
    let mut rejected_text = HashSet::new();
    for value in rejected {
        let text = value
            .as_str()
            .context("backend returned a malformed rejected event ID")?;
        if !sent.contains(text)
            || acked_text.contains(text)
            || !rejected_text.insert(text.to_string())
        {
            bail!("backend returned an invalid rejected event list; queue retained");
        }
        rejected_ids.push(
            text.parse()
                .context("backend returned a non-UUID rejected event ID")?,
        );
    }

    storage
        .mark_events_synced(&acked_ids)
        .context("failed to mark acknowledged events as synchronized")?;
    storage
        .quarantine_events(&rejected_ids, "OUTSIDE_AUTHORIZED_WINDOW")
        .context("failed to quarantine unauthorized activity intervals")?;
    let synced_retention_days = std::env::var("DP_SYNCED_QUEUE_RETENTION_DAYS")
        .ok()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|days| (1..=365).contains(days))
        .unwrap_or(7);
    let _ = storage.prune_synced_events(synced_retention_days);

    let synced = acked_ids.len();
    let rejected_count = rejected_ids.len();
    info!(
        attempted = event_ids.len(),
        synced,
        rejected = rejected_count,
        quarantined = malformed_ids.len(),
        "Activity sync response processed with per-event acknowledgements"
    );
    Ok(SyncOutcome {
        attempted: event_ids.len(),
        synced,
        rejected: rejected_count,
        quarantined: malformed_ids.len(),
    })
}

/// Kept for callers that only need a confirmed HTTP status.
#[allow(dead_code)]
pub fn post_batch_http(backend_url: &str, json_body: &[u8]) -> Result<()> {
    let _ = post_batch_response(backend_url, json_body)?;
    Ok(())
}

fn post_batch_response(backend_url: &str, body: &[u8]) -> Result<serde_json::Value> {
    let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    if let Ok(secret) = std::env::var("DP_DEVICE_SECRET") {
        if !secret.trim().is_empty() && !secret.contains(['\r', '\n']) {
            headers.push(("X-Device-Secret".to_string(), secret.trim().to_string()));
        }
    }
    let response = request_backend(
        "POST",
        backend_url,
        "/api/v1/activity/events/batch",
        &headers,
        body,
    )?;
    serde_json::from_slice(&response.body)
        .context("backend returned invalid JSON for activity sync")
}

fn remote_backend_allowed() -> bool {
    std::env::var("DP_ALLOW_REMOTE_BACKEND")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[cfg(any(test, not(windows)))]
fn parse_local_url(raw: &str) -> Result<(String, u16, String)> {
    let parsed = parse_backend_url(raw, false)?;
    if parsed.scheme != "http" {
        bail!("local HTTP backend must use a loopback address")
    }
    Ok((parsed.host, parsed.port, parsed.base_path))
}

fn request_backend(
    method: &str,
    backend_url: &str,
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<HttpResponse> {
    let parsed = parse_backend_url(backend_url, remote_backend_allowed())?;
    let path = format!("{}{endpoint}", parsed.base_path);

    #[cfg(windows)]
    {
        let response = dp_platform_windows::http::request(
            method,
            &parsed.host,
            parsed.port,
            &path,
            headers,
            body,
            parsed.scheme == "https",
        )
        .map_err(|message| anyhow::anyhow!("device request failed: {message}"))?;
        if !(200..300).contains(&response.status) {
            return Err(backend_rejection(response.status, &response.body));
        }
        Ok(HttpResponse {
            body: response.body,
        })
    }

    #[cfg(not(windows))]
    {
        if parsed.scheme != "http" {
            bail!("HTTPS device requests are available through Windows WinHTTP only");
        }
        let addr_str = format!("{}:{}", parsed.host, parsed.port);
        let socket_addrs: Vec<SocketAddr> = addr_str
            .to_socket_addrs()
            .with_context(|| format!("failed to resolve backend address: {addr_str}"))?
            .collect();
        let mut last_err = None;
        let mut stream = None;
        for address in &socket_addrs {
            match TcpStream::connect_timeout(address, Duration::from_secs(4)) {
                Ok(socket) => {
                    stream = Some(socket);
                    break;
                }
                Err(error) => last_err = Some(error),
            }
        }
        let mut stream = stream
            .ok_or_else(|| anyhow::anyhow!("failed to connect to backend: {:?}", last_err))?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let mut request_headers = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: {}\r\nConnection: close\r\n",
            parsed.host,
            parsed.port,
            body.len()
        );
        for (name, value) in headers {
            if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
                bail!("invalid HTTP header");
            }
            request_headers.push_str(&format!("{name}: {value}\r\n"));
        }
        request_headers.push_str("\r\n");
        stream.write_all(request_headers.as_bytes())?;
        stream.write_all(body)?;
        stream.flush()?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .context("backend returned malformed HTTP response")?;
        let headers_text = String::from_utf8_lossy(&response[..split]);
        let status = headers_text
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .context("backend returned malformed HTTP status")?;
        if !(200..300).contains(&status) {
            return Err(backend_rejection(status, &response[split + 4..]));
        }
        return Ok(HttpResponse {
            body: response[split + 4..].to_vec(),
        });
    }
}

/// Reports the server-authorized activity state. Missing or invalid policy data
/// yields a paused gate rather than a local default schedule.
pub fn send_startup_heartbeat(backend_url: &str, device: &DeviceInfo) -> Result<MonitoringGate> {
    let payload = serde_json::json!({
        "agentVersion": device.agent_version.as_deref().unwrap_or(dp_core::AGENT_VERSION),
        "metrics": { "deviceName": device.name, "platform": device.platform, "collector": "desktop-agent" }
    });
    let body = serde_json::to_vec(&payload).context("failed to serialize heartbeat JSON")?;
    let secret = std::env::var("DP_DEVICE_SECRET")
        .context("device secret is not configured; enroll this agent first")?;
    if secret.trim().is_empty() {
        bail!("device secret is not configured; enroll this agent first");
    }
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("X-Device-Secret".to_string(), secret.trim().to_string()),
    ];
    let response = match request_backend(
        "POST",
        backend_url,
        &format!("/api/v1/devices/{}/heartbeat", device.id),
        &headers,
        &body,
    ) {
        Ok(response) => response,
        Err(error) => {
            if let Some(rejection) = error.downcast_ref::<BackendRejection>() {
                if matches!(
                    rejection.code.as_str(),
                    "DEVICE_REVOKED" | "DEVICE_ARCHIVED"
                ) {
                    warn!(device_id = %device.id, lifecycle = %rejection.code, "Device lifecycle prevents monitoring and uploads; local queues are preserved");
                    return Ok(MonitoringGate {
                        allowed: false,
                        allowed_from: None,
                        allowed_until: None,
                        reason: Some(rejection.code.clone()),
                    });
                }
            }
            return Err(error);
        }
    };
    let parsed: serde_json::Value = serde_json::from_slice(&response.body)
        .context("backend returned invalid heartbeat JSON")?;
    let monitoring = parsed.get("monitoring");
    let allowed_from = monitoring
        .and_then(|value| value.get("allowedFrom"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let allowed_until = monitoring
        .and_then(|value| value.get("allowedUntil"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let allowed = monitoring
        .and_then(|value| value.get("allowed"))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        && allowed_until.is_some_and(|end| end > Utc::now());
    let reason = monitoring
        .and_then(|value| value.get("reason"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            if monitoring.is_none() {
                Some("MONITORING_CONFIGURATION_UNAVAILABLE".into())
            } else {
                None
            }
        });
    info!(device_id = %device.id, monitoring_allowed = allowed, reason = reason.as_deref().unwrap_or("authorized"), "Authenticated device heartbeat received");
    Ok(MonitoringGate {
        allowed,
        allowed_from,
        allowed_until,
        reason,
    })
}

/// Enrolls with an employee secret key and returns the device secret once to the local
/// caller. The raw secret key and secret are never logged or written to persistent storage.
pub fn enroll_device_token(
    backend_url: &str,
    token: &str,
    device_id: &uuid::Uuid,
    device_name: &str,
) -> Result<String> {
    let payload = serde_json::json!({
        "secretKey": token,
        "token": token,
        "deviceId": device_id.to_string(),
        "name": device_name,
        "platform": "windows_11",
        "agentVersion": dp_core::AGENT_VERSION,
    });
    let body = serde_json::to_vec(&payload)?;
    let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    let response = request_backend(
        "POST",
        backend_url,
        "/api/v1/devices/enroll",
        &headers,
        &body,
    )?;
    let parsed: serde_json::Value = serde_json::from_slice(&response.body)
        .context("failed to parse JSON enrollment response")?;
    extract_device_secret(&parsed)
}

/// Binds enrollment to an authenticated employee session, or verifies that an
/// existing protected device credential still belongs to that employee.
pub fn employee_device_sign_in(
    backend_url: &str,
    session_cookie: &str,
    secret_key: Option<&str>,
    device_id: &uuid::Uuid,
    device_name: &str,
    device_secret: Option<&str>,
) -> Result<Option<String>> {
    if session_cookie.is_empty() || session_cookie.contains(['\r', '\n']) {
        bail!("authenticated employee session is missing or malformed");
    }
    let payload = serde_json::json!({
        "secretKey": secret_key,
        "deviceId": device_id.to_string(),
        "deviceSecret": device_secret,
        "name": device_name,
        "platform": "windows_11",
        "agentVersion": dp_core::AGENT_VERSION,
    });
    let body = serde_json::to_vec(&payload)?;
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Cookie".to_string(), session_cookie.to_string()),
        (
            "X-DigitalPulse-Native-Client".to_string(),
            "control-center".to_string(),
        ),
    ];
    let response = request_backend(
        "POST",
        backend_url,
        "/api/v1/devices/employee-sign-in",
        &headers,
        &body,
    )?;
    let parsed: serde_json::Value = serde_json::from_slice(&response.body)
        .context("backend returned invalid employee device sign-in JSON")?;
    if parsed.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
        bail!("employee device sign-in was not confirmed");
    }
    Ok(parsed
        .get("deviceSecret")
        .and_then(serde_json::Value::as_str)
        .filter(|secret| secret.starts_with("dp_sec_") && secret.len() >= 24)
        .map(str::to_owned))
}

pub fn fetch_screen_monitoring_policy(
    backend_url: &str,
    device: &DeviceInfo,
) -> Result<ScreenMonitoringPolicy> {
    let secret = std::env::var("DP_DEVICE_SECRET")
        .context("device secret is not configured; enroll this agent first")?;
    let headers = vec![("X-Device-Secret".to_string(), secret.trim().to_string())];
    let response = request_backend(
        "GET",
        backend_url,
        &format!(
            "/api/v1/screen-monitoring/device-policy?deviceId={}",
            device.id
        ),
        &headers,
        &[],
    )?;
    let parsed: serde_json::Value = serde_json::from_slice(&response.body)
        .context("backend returned invalid screenshot policy JSON")?;
    let policy = parsed
        .get("policy")
        .context("screenshot policy response is missing policy")?;
    info!(device_id = %device.id,
        allowed = policy.get("allowed").and_then(serde_json::Value::as_bool).unwrap_or(false),
        reason = policy.get("reason").and_then(serde_json::Value::as_str).unwrap_or("none"),
        "SCREEN_POLICY_FETCHED");
    Ok(ScreenMonitoringPolicy {
        allowed: policy.get("allowed").and_then(serde_json::Value::as_bool) == Some(true),
        reason: policy
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        interval_seconds: policy
            .get("intervalSeconds")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(300)
            .clamp(300, 3600),
        excluded_applications: policy
            .get("excludedApplications")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_lowercase)
                    .collect()
            })
            .unwrap_or_default(),
        visible_indicator: policy
            .get("visibleIndicator")
            .and_then(serde_json::Value::as_bool)
            == Some(true),
        allowed_until: policy
            .get("allowedUntil")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc)),
    })
}

pub struct ScreenCaptureUpload<'a> {
    pub capture_key: &'a str,
    pub captured_at: &'a str,
    pub width: u32,
    pub height: u32,
    pub application_name: &'a str,
    pub jpeg: &'a [u8],
}

pub fn upload_screen_capture(
    backend_url: &str,
    device: &DeviceInfo,
    capture: ScreenCaptureUpload<'_>,
) -> Result<()> {
    let secret = std::env::var("DP_DEVICE_SECRET")
        .context("device secret is not configured; enroll this agent first")?;
    upload_screen_capture_authenticated(backend_url, device, capture, &secret)
}

fn upload_screen_capture_authenticated(
    backend_url: &str,
    device: &DeviceInfo,
    capture: ScreenCaptureUpload<'_>,
    secret: &str,
) -> Result<()> {
    if secret.trim().is_empty() {
        bail!("device secret is not configured; enroll this agent first");
    }
    let headers = vec![
        ("Content-Type".to_string(), "image/jpeg".to_string()),
        ("X-Device-Secret".to_string(), secret.trim().to_string()),
        ("X-Capture-Key".to_string(), capture.capture_key.to_string()),
        ("X-Captured-At".to_string(), capture.captured_at.to_string()),
        ("X-Image-Width".to_string(), capture.width.to_string()),
        ("X-Image-Height".to_string(), capture.height.to_string()),
        (
            "X-Application-Name".to_string(),
            capture
                .application_name
                .chars()
                .filter(|c| !matches!(c, '\r' | '\n'))
                .take(128)
                .collect(),
        ),
    ];
    let response = request_backend(
        "POST",
        backend_url,
        &format!("/api/v1/screen-monitoring/captures?deviceId={}", device.id),
        &headers,
        capture.jpeg,
    )?;
    let ack: serde_json::Value = serde_json::from_slice(&response.body)
        .context("screenshot upload returned invalid acknowledgement; queue retained")?;
    if ack.get("success").and_then(serde_json::Value::as_bool) != Some(true)
        || ack
            .get("captureId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .is_none()
    {
        bail!("screenshot upload was not acknowledged; queue retained");
    }
    Ok(())
}

pub fn report_screen_capture_failure(
    backend_url: &str,
    device: &DeviceInfo,
    code: &str,
) -> Result<()> {
    let secret = std::env::var("DP_DEVICE_SECRET")
        .context("device secret is not configured; enroll this agent first")?;
    let body =
        serde_json::to_vec(&serde_json::json!({ "deviceId": device.id, "failureCode": code }))?;
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("X-Device-Secret".to_string(), secret.trim().to_string()),
    ];
    request_backend(
        "POST",
        backend_url,
        "/api/v1/screen-monitoring/failures",
        &headers,
        &body,
    )?;
    Ok(())
}

fn extract_device_secret(response: &serde_json::Value) -> Result<String> {
    response
        .get("deviceSecret")
        .or_else(|| response.get("secret"))
        .and_then(|value| value.as_str())
        .filter(|secret| secret.starts_with("dp_sec_") && secret.len() >= 24)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("enrollment response missing a valid device secret"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dp_core::{AppInfo, EventSource, EventType};
    use dp_storage::StoredActivitySession;
    use std::collections::HashMap;
    use std::io::{BufRead, Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

    #[test]
    fn backend_parser_rejects_credentials_and_accepts_ipv6_loopback() {
        assert!(parse_backend_url("https://user:secret@example.test", true).is_err());
        assert!(parse_backend_url("http://localhost:3001/\r\nX-Header:secret", false).is_err());
        assert_eq!(
            parse_local_url("http://[::1]:3001").expect("test fixture operation must succeed"),
            ("::1".into(), 3001, String::new())
        );
    }

    #[test]
    fn enrollment_accepts_backend_device_secret_contract() {
        assert_eq!(
            extract_device_secret(
                &serde_json::json!({ "deviceSecret": "dp_sec_012345678901234567890123" })
            )
            .expect("test fixture operation must succeed"),
            "dp_sec_012345678901234567890123"
        );
        assert!(
            extract_device_secret(&serde_json::json!({ "deviceSecret": "not-a-secret" })).is_err()
        );
    }

    #[test]
    fn backend_rejection_preserves_structured_device_lifecycle_without_credentials() {
        let error = backend_rejection(
            403,
            br#"{"error":{"code":"DEVICE_REVOKED","message":"This device has been revoked by an administrator"}}"#,
        );
        let rejection = error
            .downcast_ref::<BackendRejection>()
            .expect("test fixture operation must succeed");
        assert_eq!(rejection.status, 403);
        assert_eq!(rejection.code, "DEVICE_REVOKED");
        assert_eq!(
            rejection.message,
            "This device has been revoked by an administrator"
        );
        assert!(!error.to_string().contains("dp_sec_"));
    }

    #[test]
    fn screenshot_upload_matches_backend_http_contract() {
        if std::env::var("RUN_INTEGRATION_TESTS").is_err() {
            return;
        }
        let listener =
            TcpListener::bind("127.0.0.1:0").expect("test fixture operation must succeed");
        let port = listener
            .local_addr()
            .expect("test fixture operation must succeed")
            .port();
        let device_id = Uuid::new_v4();
        let capture_key = "capture_key_1234567890";
        let captured_at = "2026-11-07T04:30:00.000Z";
        let jpeg = [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9];
        let expected_jpeg = jpeg;
        let server_thread = thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .expect("test fixture operation must succeed");
            let mut reader = std::io::BufReader::new(
                stream
                    .try_clone()
                    .expect("test fixture operation must succeed"),
            );
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("test fixture operation must succeed");
            assert_eq!(
                request_line.trim_end(),
                format!("POST /api/v1/screen-monitoring/captures?deviceId={device_id} HTTP/1.1")
            );

            let mut headers = HashMap::new();
            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("test fixture operation must succeed");
                if line == "\r\n" {
                    break;
                }
                let (name, value) = line
                    .split_once(':')
                    .expect("test fixture operation must succeed");
                headers.insert(name.to_ascii_lowercase(), value.trim().to_string());
            }
            assert_eq!(
                headers.get("content-type").map(String::as_str),
                Some("image/jpeg")
            );
            assert_eq!(
                headers.get("x-device-secret").map(String::as_str),
                Some("dp_sec_contract_test_123456789")
            );
            assert_eq!(
                headers.get("x-capture-key").map(String::as_str),
                Some(capture_key)
            );
            assert_eq!(
                headers.get("x-captured-at").map(String::as_str),
                Some(captured_at)
            );
            assert_eq!(
                headers.get("x-image-width").map(String::as_str),
                Some("1920")
            );
            assert_eq!(
                headers.get("x-image-height").map(String::as_str),
                Some("1080")
            );
            assert_eq!(
                headers.get("x-application-name").map(String::as_str),
                Some("Code.exeInjected")
            );

            let length = headers["content-length"]
                .parse::<usize>()
                .expect("test fixture operation must succeed");
            let mut body = vec![0; length];
            reader
                .read_exact(&mut body)
                .expect("test fixture operation must succeed");
            assert_eq!(body, expected_jpeg);
            let body = r#"{"success":true,"captureId":"capture-test"}"#;
            let response = format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            stream
                .write_all(response.as_bytes())
                .expect("test fixture operation must succeed");
        });

        let device = DeviceInfo {
            id: device_id,
            kind: EventSource::DesktopAgent,
            name: "Contract-PC".into(),
            platform: "windows".into(),
            browser: None,
            agent_version: Some("0.1.0".into()),
        };
        upload_screen_capture_authenticated(
            &format!("http://127.0.0.1:{port}"),
            &device,
            ScreenCaptureUpload {
                capture_key,
                captured_at,
                width: 1920,
                height: 1080,
                application_name: "Code.exe\r\nInjected",
                jpeg: &jpeg,
            },
            " dp_sec_contract_test_123456789 ",
        )
        .expect("test fixture operation must succeed");
        server_thread
            .join()
            .expect("test fixture operation must succeed");
    }

    #[test]
    fn local_url_parser_accepts_only_loopback_http() {
        assert_eq!(
            parse_local_url("http://127.0.0.1:3001").expect("test fixture operation must succeed"),
            ("127.0.0.1".into(), 3001, String::new())
        );
        assert_eq!(
            parse_local_url("http://localhost:8080/prefix")
                .expect("test fixture operation must succeed"),
            ("localhost".into(), 8080, "/prefix".into())
        );
        assert!(parse_local_url("http://192.168.1.5:3001").is_err());
        assert!(parse_local_url("https://example.com").is_err());
    }

    #[test]
    fn sync_pending_events_uses_per_event_acknowledgement() {
        if std::env::var("RUN_INTEGRATION_TESTS").is_err() {
            return;
        }
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(value) => value,
            Err(_) => return,
        };
        let port = listener
            .local_addr()
            .expect("test fixture operation must succeed")
            .port();
        let event_id = Uuid::new_v4();
        let server_thread = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(
                    stream
                        .try_clone()
                        .expect("test fixture operation must succeed"),
                );
                let mut first_line = String::new();
                reader
                    .read_line(&mut first_line)
                    .expect("test fixture operation must succeed");
                let response_body = format!("{{\"accepted\":1,\"deduplicated\":0,\"rejected\":0,\"acceptedEventIds\":[\"{event_id}\"],\"deduplicatedEventIds\":[],\"rejectedEventIds\":[]}}");
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response_body.len(), response_body);
                stream
                    .write_all(response.as_bytes())
                    .expect("test fixture operation must succeed");
            }
        });
        let mut storage = Storage::open_in_memory().expect("test fixture operation must succeed");
        let device_id = Uuid::new_v4();
        let event = ActivityEvent {
            schema_version: 1,
            event_id,
            device_id,
            source: EventSource::DesktopAgent,
            event_type: EventType::AppSession,
            started_at: Utc::now() - chrono::Duration::seconds(10),
            ended_at: Utc::now(),
            duration_seconds: 10.0,
            app: Some(AppInfo {
                name: "Code.exe".into(),
                executable: "Code.exe".into(),
                process_id: Some(1234),
            }),
            web: None,
        };
        let session = StoredActivitySession {
            id: event_id,
            device_id,
            application_name: Some("Code.exe".into()),
            executable_name: Some("Code.exe".into()),
            process_id: Some(1234),
            started_at: event.started_at,
            ended_at: event.ended_at,
            duration_seconds: 10.0,
            activity_state: "active".into(),
            created_at: Utc::now(),
        };
        storage
            .record_session_with_event(
                &session,
                &serde_json::to_string(&event).expect("test fixture operation must succeed"),
            )
            .expect("test fixture operation must succeed");
        let device = DeviceInfo {
            id: device_id,
            kind: EventSource::DesktopAgent,
            name: "Test-PC".into(),
            platform: "windows".into(),
            browser: None,
            agent_version: Some("0.1.0".into()),
        };
        let outcome = sync_pending_events(
            &mut storage,
            &format!("http://127.0.0.1:{port}"),
            &device,
            10,
        )
        .expect("test fixture operation must succeed");
        assert_eq!(outcome.attempted, 1);
        assert_eq!(outcome.synced, 1);
        assert_eq!(
            storage
                .count_pending_sync()
                .expect("test fixture operation must succeed"),
            0
        );
        server_thread
            .join()
            .expect("test fixture operation must succeed");
    }
}
