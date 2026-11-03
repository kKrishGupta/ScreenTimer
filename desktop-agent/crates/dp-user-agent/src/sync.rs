//! Authenticated device enrollment, heartbeats, and offline event synchronization.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use dp_core::{ActivityBatch, ActivityEvent, DeviceInfo};
use dp_storage::Storage;
use std::collections::HashSet;
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
struct ParsedUrl {
    scheme: String,
    host: String,
    port: u16,
    base_path: String,
}

#[derive(Debug)]
struct HttpResponse {
    body: Vec<u8>,
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
    let _ = storage.prune_synced_events(7);

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
    let response = request_backend(backend_url, "/api/v1/activity/events/batch", &headers, body)?;
    serde_json::from_slice(&response.body)
        .context("backend returned invalid JSON for activity sync")
}

fn parse_url(raw: &str) -> Result<ParsedUrl> {
    let (scheme, stripped) = if let Some(value) = raw.strip_prefix("http://") {
        ("http", value)
    } else if let Some(value) = raw.strip_prefix("https://") {
        ("https", value)
    } else {
        bail!("backend URL must use explicit http:// or https:// scheme")
    };
    let (host_port, path) = match stripped.find('/') {
        Some(idx) => (&stripped[..idx], &stripped[idx..]),
        None => (stripped, ""),
    };
    if host_port.contains(['?', '#', '@', '\\']) || path.contains(['?', '#', '\\']) || raw.chars().any(char::is_whitespace) {
        bail!("backend URL must not include credentials, whitespace, a query or fragment")
    }
    let (host, port) = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (host, suffix) = bracketed.split_once(']').context("invalid IPv6 backend host")?;
        let port = if suffix.is_empty() { if scheme == "https" { 443 } else { 80 } }
            else { suffix.strip_prefix(':').context("invalid IPv6 backend port")?.parse::<u16>().context("invalid backend port")? };
        (host.to_owned(), port)
    } else { match host_port.rsplit_once(':') {
        Some((host, port)) => (
            host.trim_matches(['[', ']']).to_string(),
            port.parse::<u16>().context("invalid port in backend URL")?,
        ),
        None => (
            host_port.trim_matches(['[', ']']).to_string(),
            if scheme == "https" { 443 } else { 80 },
        ),
    }};
    if host.is_empty() || port == 0 {
        bail!("backend host is required");
    }
    Ok(ParsedUrl {
        scheme: scheme.into(),
        host,
        port,
        base_path: path.trim_end_matches('/').to_string(),
    })
}

fn remote_backend_allowed() -> bool {
    std::env::var("DP_ALLOW_REMOTE_BACKEND")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

#[cfg(any(test, not(windows)))]
fn parse_local_url(raw: &str) -> Result<(String, u16, String)> {
    let parsed = parse_url(raw)?;
    if parsed.scheme != "http" || !is_loopback(&parsed.host) {
        bail!("local HTTP backend must use a loopback address")
    }
    Ok((parsed.host, parsed.port, parsed.base_path))
}

fn request_backend(
    backend_url: &str,
    endpoint: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<HttpResponse> {
    let parsed = parse_url(backend_url)?;
    if !is_loopback(&parsed.host) && (parsed.scheme != "https" || !remote_backend_allowed()) {
        bail!("remote device synchronization requires HTTPS and DP_ALLOW_REMOTE_BACKEND=true")
    }
    let path = format!("{}{endpoint}", parsed.base_path);

    #[cfg(windows)]
    {
        let response = dp_platform_windows::http::post_json(
            &parsed.host,
            parsed.port,
            &path,
            headers,
            body,
            parsed.scheme == "https",
        )
        .map_err(|message| anyhow::anyhow!("device request failed: {message}"))?;
        if !(200..300).contains(&response.status) {
            bail!(
                "backend rejected the device request with HTTP {}",
                response.status
            )
        }
        return Ok(HttpResponse {
            body: response.body,
        });
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
            "POST {path} HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: {}\r\nConnection: close\r\n",
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
            bail!("backend rejected the device request with HTTP {status}");
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
    let response = request_backend(
        backend_url,
        &format!("/api/v1/devices/{}/heartbeat", device.id),
        &headers,
        &body,
    )?;
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

/// Enrolls with a one-use token and returns the device secret once to the local
/// caller. The raw token and secret are never logged or written to SQLite.
pub fn enroll_device_token(
    backend_url: &str,
    token: &str,
    device_id: &uuid::Uuid,
    device_name: &str,
) -> Result<String> {
    let payload = serde_json::json!({
        "token": token,
        "deviceId": device_id.to_string(),
        "name": device_name,
        "platform": "windows_11",
        "agentVersion": dp_core::AGENT_VERSION,
    });
    let body = serde_json::to_vec(&payload)?;
    let headers = vec![("Content-Type".to_string(), "application/json".to_string())];
    let response = request_backend(backend_url, "/api/v1/devices/enroll", &headers, &body)?;
    let parsed: serde_json::Value = serde_json::from_slice(&response.body)
        .context("failed to parse JSON enrollment response")?;
    extract_device_secret(&parsed)
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
    use std::io::{BufRead, Write};
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

    #[test]
    fn backend_parser_rejects_credentials_and_accepts_ipv6_loopback() {
        assert!(parse_url("https://user:secret@example.test").is_err());
        assert!(parse_url("http://localhost:3001/\r\nX-Header:secret").is_err());
        assert_eq!(parse_local_url("http://[::1]:3001").unwrap(), ("::1".into(), 3001, String::new()));
    }

    #[test]
    fn enrollment_accepts_backend_device_secret_contract() {
        assert_eq!(
            extract_device_secret(
                &serde_json::json!({ "deviceSecret": "dp_sec_012345678901234567890123" })
            )
            .unwrap(),
            "dp_sec_012345678901234567890123"
        );
        assert!(
            extract_device_secret(&serde_json::json!({ "deviceSecret": "not-a-secret" })).is_err()
        );
    }

    #[test]
    fn local_url_parser_accepts_only_loopback_http() {
        assert_eq!(
            parse_local_url("http://127.0.0.1:3001").unwrap(),
            ("127.0.0.1".into(), 3001, String::new())
        );
        assert_eq!(
            parse_local_url("http://localhost:8080/prefix").unwrap(),
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
        let port = listener.local_addr().unwrap().port();
        let event_id = Uuid::new_v4();
        let server_thread = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first_line = String::new();
                reader.read_line(&mut first_line).unwrap();
                let response_body = format!("{{\"accepted\":1,\"deduplicated\":0,\"rejected\":0,\"acceptedEventIds\":[\"{event_id}\"],\"deduplicatedEventIds\":[],\"rejectedEventIds\":[]}}");
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response_body.len(), response_body);
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut storage = Storage::open_in_memory().unwrap();
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
            .record_session_with_event(&session, &serde_json::to_string(&event).unwrap())
            .unwrap();
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
        .unwrap();
        assert_eq!(outcome.attempted, 1);
        assert_eq!(outcome.synced, 1);
        assert_eq!(storage.count_pending_sync().unwrap(), 0);
        server_thread.join().unwrap();
    }
}
