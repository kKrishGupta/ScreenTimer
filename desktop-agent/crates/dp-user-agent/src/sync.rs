//! Background synchronisation of pending activity events to the local Fastify backend.
//!
//! Offline resilience: if the backend is down, events remain safely buffered
//! in SQLite (`sync_queue`) until the next synchronization cycle.

use anyhow::{bail, Context, Result};
use dp_core::{ActivityBatch, ActivityEvent, DeviceInfo};
use dp_storage::Storage;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Synchronization result metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncOutcome {
    pub attempted: usize,
    pub synced: usize,
}

/// Attempts to synchronize pending events from SQLite buffer to the backend.
pub fn sync_pending_events(
    storage: &mut Storage,
    backend_url: &str,
    device: &DeviceInfo,
    batch_size: usize,
) -> Result<SyncOutcome> {
    let pending_items = storage
        .get_pending_sync_items(batch_size)
        .context("failed to fetch pending items from SQLite sync queue")?;

    if pending_items.is_empty() {
        return Ok(SyncOutcome {
            attempted: 0,
            synced: 0,
        });
    }

    let mut events = Vec::with_capacity(pending_items.len());
    let mut event_ids = Vec::with_capacity(pending_items.len());

    for item in &pending_items {
        match serde_json::from_str::<ActivityEvent>(&item.payload) {
            Ok(ev) => {
                events.push(ev);
                event_ids.push(item.id);
            }
            Err(err) => {
                warn!(
                    event_id = %item.id,
                    error = %err,
                    "Malformed pending event in sync queue, marking as synced to prevent poison queue"
                );
                let _ = storage.mark_events_synced(&[item.id]);
            }
        }
    }

    if events.is_empty() {
        return Ok(SyncOutcome {
            attempted: pending_items.len(),
            synced: 0,
        });
    }

    let batch = ActivityBatch {
        device: device.clone(),
        events,
    };

    let serialized_batch = serde_json::to_vec(&batch).context("failed to serialize batch JSON")?;

    post_batch_http(backend_url, &serialized_batch)
        .context("failed to post event batch to backend")?;

    // Backend accepted the batch: mark events as synced in SQLite
    storage
        .mark_events_synced(&event_ids)
        .context("failed to mark synced events in SQLite")?;

    // Prune stale synced records older than 7 days
    let _ = storage.prune_synced_events(7);

    info!(
        batch_size = event_ids.len(),
        "Successfully synchronized activity batch to backend"
    );

    Ok(SyncOutcome {
        attempted: event_ids.len(),
        synced: event_ids.len(),
    })
}

/// Sends an HTTP POST request to the local backend using std::net::TcpStream.
///
/// Keeps the desktop agent free of heavy HTTP client / async runtime dependencies.
pub fn post_batch_http(backend_url: &str, json_body: &[u8]) -> Result<()> {
    let (host, port, path) = parse_local_url(backend_url)?;

    let addr_str = format!("{}:{}", host, port);
    let socket_addrs: Vec<SocketAddr> = addr_str
        .to_socket_addrs()
        .with_context(|| format!("failed to resolve backend address: {}", addr_str))?
        .collect();

    let socket_addr = socket_addrs
        .first()
        .ok_or_else(|| anyhow::anyhow!("no IP address found for {}", addr_str))?;

    let mut stream = TcpStream::connect_timeout(socket_addr, Duration::from_secs(3))
        .with_context(|| format!("connection to backend at {} timed out", addr_str))?;

    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;

    let request_header = format!(
        "POST {}/api/v1/activity/events/batch HTTP/1.1\r\n\
         Host: {}:{}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        path.trim_end_matches('/'),
        host,
        port,
        json_body.len()
    );

    stream
        .write_all(request_header.as_bytes())
        .context("failed to write HTTP request headers")?;
    stream
        .write_all(json_body)
        .context("failed to write HTTP request payload")?;
    stream.flush().context("failed to flush HTTP request")?;

    let mut response_buf = Vec::new();
    stream
        .read_to_end(&mut response_buf)
        .context("failed to read backend HTTP response")?;

    let response_str = String::from_utf8_lossy(&response_buf);
    let first_line = response_str
        .lines()
        .next()
        .unwrap_or("")
        .trim();

    debug!(response_line = first_line, "Backend HTTP response received");

    // Check for HTTP 2xx status (e.g. HTTP/1.1 200 OK, HTTP/1.1 207 Multi-Status)
    if first_line.starts_with("HTTP/1.1 2") || first_line.starts_with("HTTP/1.0 2") {
        Ok(())
    } else {
        bail!("backend rejected batch with status: {}", first_line)
    }
}

/// Parses an HTTP URL into (host, port, basePath) with localhost validation.
fn parse_local_url(raw: &str) -> Result<(String, u16, String)> {
    let stripped = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
        .unwrap_or(raw);

    let (host_port, path) = match stripped.find('/') {
        Some(idx) => (&stripped[..idx], &stripped[idx..]),
        None => (stripped, ""),
    };

    let (host, port) = match host_port.find(':') {
        Some(idx) => {
            let host = &host_port[..idx];
            let port = host_port[idx + 1..]
                .parse::<u16>()
                .context("invalid port in backend URL")?;
            (host.to_string(), port)
        }
        None => (host_port.to_string(), 80),
    };

    // Stage 1 security constraint: localhost only
    if host != "127.0.0.1" && host != "localhost" {
        bail!("backend URL must target loopback interface, got: {}", host);
    }

    Ok((host, port, path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use dp_core::{AppInfo, EventSource, EventType};
    use dp_storage::StoredActivitySession;
    use std::io::BufRead;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn parse_url_extracts_components_and_enforces_localhost() {
        let (host, port, path) = parse_local_url("http://127.0.0.1:3001").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 3001);
        assert_eq!(path, "");

        let (host, port, path) = parse_local_url("http://localhost:8080/prefix").unwrap();
        assert_eq!(host, "localhost");
        assert_eq!(port, 8080);
        assert_eq!(path, "/prefix");

        assert!(parse_local_url("http://192.168.1.5:3001").is_err());
        assert!(parse_local_url("http://example.com").is_err());
    }

    #[test]
    fn sync_pending_events_pushes_batch_and_marks_synced() {
        if std::env::var("RUN_INTEGRATION_TESTS").is_err() {
            eprintln!("Skipping live socket test inside sandbox; enable with RUN_INTEGRATION_TESTS=true");
            return;
        }

        // 1. Mock local HTTP backend on an ephemeral loopback port
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => return, // In sandboxed environments without loopback bind rights
        };
        let port = listener.local_addr().unwrap().port();
        let server_running = Arc::new(AtomicBool::new(true));
        let server_running_clone = server_running.clone();

        let server_thread = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first_line = String::new();
                reader.read_line(&mut first_line).unwrap();

                // Respond with HTTP 200 OK
                let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 17\r\nConnection: close\r\n\r\n{\"success\":true}\r\n";
                stream.write_all(resp.as_bytes()).unwrap();
            }
            server_running_clone.store(false, Ordering::SeqCst);
        });

        // 2. Set up in-memory SQLite storage with a pending session
        let mut storage = Storage::open_in_memory().unwrap();
        let event_id = Uuid::new_v4();
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

        let payload_json = serde_json::to_string(&event).unwrap();
        storage
            .record_session_with_event(&session, &payload_json)
            .unwrap();

        assert_eq!(storage.count_pending_sync().unwrap(), 1);

        // 3. Run sync
        let device = DeviceInfo {
            id: device_id,
            kind: EventSource::DesktopAgent,
            name: "Test-PC".into(),
            platform: "windows".into(),
            browser: None,
            agent_version: Some("0.1.0".into()),
        };

        let backend_url = format!("http://127.0.0.1:{}", port);
        let outcome = sync_pending_events(&mut storage, &backend_url, &device, 10).unwrap();

        assert_eq!(outcome.attempted, 1);
        assert_eq!(outcome.synced, 1);
        assert_eq!(storage.count_pending_sync().unwrap(), 0);

        server_thread.join().unwrap();
    }
}
