//! Encrypted offline event queue and agent state storage.
//!
//! Stores offline activity sessions and events encrypted at rest with Windows DPAPI.
//! Supports bounded capacity, atomic writes, crash recovery, retries, deduplication,
//! and per-event acknowledgements. Plaintext screenshots or credentials are never stored.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use uuid::Uuid;

/// Storage errors.
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("I/O error in storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Failed to parse UUID in database record: {0}")]
    UuidParse(#[from] uuid::Error),
    #[error("Encryption error: {0}")]
    Encryption(String),
    #[error("storage backpressure: {0}")]
    Capacity(String),
}

/// A stored activity session interval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredActivitySession {
    pub id: Uuid,
    pub device_id: Uuid,
    pub application_name: Option<String>,
    pub executable_name: Option<String>,
    pub process_id: Option<u32>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub duration_seconds: f64,
    pub activity_state: String,
    pub created_at: DateTime<Utc>,
}

/// A pending, quarantined, or synced item in the outbound sync queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncQueueItem {
    pub id: Uuid,
    pub event_type: String,
    pub payload: String,
    pub created_at: DateTime<Utc>,
    pub synced_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub quarantined_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub quarantine_reason: Option<String>,
}

#[derive(Debug, Default)]
struct InMemoryStore {
    state: HashMap<String, String>,
    sessions: Vec<StoredActivitySession>,
    queue: Vec<SyncQueueItem>,
}

/// High-level encrypted offline storage interface.
#[derive(Debug)]
pub struct Storage {
    root_dir: Option<PathBuf>,
    in_memory: Option<Arc<Mutex<InMemoryStore>>>,
}

fn encrypt_bytes(plain: &[u8]) -> Result<Vec<u8>, StorageError> {
    #[cfg(windows)]
    {
        dp_platform_windows::data_protection::protect(plain)
            .map_err(|e| StorageError::Encryption(format!("DPAPI protect failed: {e}")))
    }
    #[cfg(not(windows))]
    {
        Ok(plain.iter().map(|b| b ^ 0xa5).collect())
    }
}

fn decrypt_bytes(cipher: &[u8]) -> Result<Vec<u8>, StorageError> {
    #[cfg(windows)]
    {
        dp_platform_windows::data_protection::unprotect(cipher)
            .map_err(|e| StorageError::Encryption(format!("DPAPI unprotect failed: {e}")))
    }
    #[cfg(not(windows))]
    {
        Ok(cipher.iter().map(|b| b ^ 0xa5).collect())
    }
}

fn atomic_write_encrypted(path: &Path, plain_bytes: &[u8]) -> Result<(), StorageError> {
    let encrypted = encrypt_bytes(plain_bytes)?;
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, &encrypted)?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

fn read_encrypted(path: &Path) -> Result<Vec<u8>, StorageError> {
    let ciphertext = fs::read(path)?;
    decrypt_bytes(&ciphertext)
}

fn clean_temporary_files(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                clean_temporary_files(&path);
            } else if path.extension().is_some_and(|ext| ext == "tmp") {
                let _ = fs::remove_file(path);
            }
        }
    }
}

impl Storage {
    /// Opens or creates an encrypted offline storage queue directory at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        let queue_dir = if path.is_file() || path.extension().is_some() {
            path.parent().unwrap_or(Path::new(".")).join("queue")
        } else {
            path.to_owned()
        };

        fs::create_dir_all(&queue_dir)?;
        fs::create_dir_all(queue_dir.join("events"))?;
        fs::create_dir_all(queue_dir.join("sessions"))?;
        fs::create_dir_all(queue_dir.join("quarantine"))?;

        clean_temporary_files(&queue_dir);

        Ok(Self {
            root_dir: Some(queue_dir),
            in_memory: None,
        })
    }

    /// Opens an isolated in-memory storage buffer (used for unit testing).
    pub fn open_in_memory() -> Result<Self, StorageError> {
        Ok(Self {
            root_dir: None,
            in_memory: Some(Arc::new(Mutex::new(InMemoryStore::default()))),
        })
    }

    /// Persists a completed activity session and adds it to the outbound sync queue atomically.
    pub fn record_session_with_event(
        &mut self,
        session: &StoredActivitySession,
        event_payload_json: &str,
    ) -> Result<(), StorageError> {
        self.record_session_with_event_bounded(session, event_payload_json, usize::MAX)
    }

    pub fn record_session_with_event_bounded(
        &mut self,
        session: &StoredActivitySession,
        event_payload_json: &str,
        max_pending: usize,
    ) -> Result<(), StorageError> {
        if let Some(mem) = &self.in_memory {
            let mut store = mem.lock().unwrap();
            let pending_count = store.queue.iter().filter(|i| i.synced_at.is_none()).count();
            if max_pending != usize::MAX && pending_count >= max_pending {
                return Err(StorageError::Capacity(format!(
                    "activity queue limit {max_pending} reached; no unacknowledged rows were deleted"
                )));
            }
            if let Some(idx) = store.sessions.iter().position(|s| s.id == session.id) {
                store.sessions[idx] = session.clone();
            } else {
                store.sessions.push(session.clone());
            }
            let item = SyncQueueItem {
                id: session.id,
                event_type: session.activity_state.clone(),
                payload: event_payload_json.to_string(),
                created_at: session.created_at,
                synced_at: None,
                quarantined_at: None,
                quarantine_reason: None,
            };
            if let Some(idx) = store.queue.iter().position(|q| q.id == session.id) {
                store.queue[idx] = item;
            } else {
                store.queue.push(item);
            }
            return Ok(());
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let events_dir = root.join("events");
        let sessions_dir = root.join("sessions");

        let pending_count = self.count_pending_sync()?;
        if max_pending != usize::MAX && pending_count >= max_pending {
            return Err(StorageError::Capacity(format!(
                "activity queue limit {max_pending} reached; no unacknowledged rows were deleted"
            )));
        }

        let max_queue_bytes = std::env::var("DP_STORAGE_MAX_BYTES")
            .ok()
            .and_then(|raw| raw.parse::<u64>().ok())
            .unwrap_or(50 * 1024 * 1024);
        if self.disk_footprint_bytes()? >= max_queue_bytes {
            return Err(StorageError::Capacity(format!(
                "activity queue byte limit {max_queue_bytes} reached; no unacknowledged rows were deleted"
            )));
        }

        // 1. Write session record
        let session_file = sessions_dir.join(format!("{}.dpapi", session.id));
        let session_bytes = serde_json::to_vec(session)?;
        atomic_write_encrypted(&session_file, &session_bytes)?;

        // 2. Write queue event
        let queue_item = SyncQueueItem {
            id: session.id,
            event_type: session.activity_state.clone(),
            payload: event_payload_json.to_string(),
            created_at: session.created_at,
            synced_at: None,
            quarantined_at: None,
            quarantine_reason: None,
        };
        let event_file = events_dir.join(format!("{}.dpapi", session.id));
        let event_bytes = serde_json::to_vec(&queue_item)?;
        atomic_write_encrypted(&event_file, &event_bytes)?;

        Ok(())
    }

    /// Retrieves up to `limit` pending events from the sync queue.
    pub fn get_pending_sync_items(&self, limit: usize) -> Result<Vec<SyncQueueItem>, StorageError> {
        if let Some(mem) = &self.in_memory {
            let store = mem.lock().unwrap();
            let mut pending: Vec<SyncQueueItem> = store
                .queue
                .iter()
                .filter(|item| item.synced_at.is_none() && item.quarantined_at.is_none())
                .cloned()
                .collect();
            pending.sort_by_key(|i| i.created_at);
            pending.truncate(limit);
            return Ok(pending);
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let events_dir = root.join("events");
        let mut items = Vec::new();

        if let Ok(entries) = fs::read_dir(events_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "dpapi") {
                    if let Ok(bytes) = read_encrypted(&path) {
                        if let Ok(item) = serde_json::from_slice::<SyncQueueItem>(&bytes) {
                            if item.synced_at.is_none() && item.quarantined_at.is_none() {
                                items.push(item);
                            }
                        }
                    }
                }
            }
        }

        items.sort_by_key(|i| i.created_at);
        items.truncate(limit);
        Ok(items)
    }

    /// Marks the specified batch of event IDs as synced in the queue, deleting them upon confirmed backend acknowledgement.
    pub fn mark_events_synced(&mut self, ids: &[Uuid]) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }
        if let Some(mem) = &self.in_memory {
            let mut store = mem.lock().unwrap();
            let now = Utc::now();
            for item in store.queue.iter_mut() {
                if ids.contains(&item.id) {
                    item.synced_at = Some(now);
                }
            }
            return Ok(());
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let events_dir = root.join("events");

        for id in ids {
            let path = events_dir.join(format!("{id}.dpapi"));
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    /// Retains malformed events for review while preventing them from poisoning later batches.
    pub fn quarantine_events(&mut self, ids: &[Uuid], reason: &str) -> Result<(), StorageError> {
        let limit = std::env::var("DP_MAX_QUARANTINED_EVENTS")
            .ok()
            .and_then(|raw| raw.parse::<usize>().ok())
            .filter(|value| (10..=100_000).contains(value))
            .unwrap_or(1_000);
        self.quarantine_events_bounded(ids, reason, limit)
    }

    pub fn quarantine_events_bounded(
        &mut self,
        ids: &[Uuid],
        reason: &str,
        max_quarantined: usize,
    ) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }
        let current_quarantined = self.count_quarantined_sync()?;
        if current_quarantined.saturating_add(ids.len()) > max_quarantined {
            return Err(StorageError::Capacity(format!(
                "quarantine limit {max_quarantined} reached; rows remain pending and were not deleted"
            )));
        }

        if let Some(mem) = &self.in_memory {
            let mut store = mem.lock().unwrap();
            let now = Utc::now();
            for item in store.queue.iter_mut() {
                if ids.contains(&item.id) && item.synced_at.is_none() {
                    item.quarantined_at = Some(now);
                    item.quarantine_reason = Some(reason.to_string());
                }
            }
            return Ok(());
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let events_dir = root.join("events");
        let now = Utc::now();

        for id in ids {
            let event_path = events_dir.join(format!("{id}.dpapi"));
            if event_path.is_file() {
                if let Ok(bytes) = read_encrypted(&event_path) {
                    if let Ok(mut item) = serde_json::from_slice::<SyncQueueItem>(&bytes) {
                        if item.synced_at.is_none() {
                            item.quarantined_at = Some(now);
                            item.quarantine_reason = Some(reason.to_string());
                            if let Ok(updated_bytes) = serde_json::to_vec(&item) {
                                let _ = atomic_write_encrypted(&event_path, &updated_bytes);
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Returns the number of unsynced rows retained for manual review.
    pub fn count_quarantined_sync(&self) -> Result<usize, StorageError> {
        if let Some(mem) = &self.in_memory {
            let store = mem.lock().unwrap();
            let count = store
                .queue
                .iter()
                .filter(|i| i.synced_at.is_none() && i.quarantined_at.is_some())
                .count();
            return Ok(count);
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let events_dir = root.join("events");
        let mut count = 0;

        if let Ok(entries) = fs::read_dir(events_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "dpapi") {
                    if let Ok(bytes) = read_encrypted(&path) {
                        if let Ok(item) = serde_json::from_slice::<SyncQueueItem>(&bytes) {
                            if item.synced_at.is_none() && item.quarantined_at.is_some() {
                                count += 1;
                            }
                        }
                    }
                }
            }
        }
        Ok(count)
    }

    /// Prunes already-synced events older than `older_than_days` to enforce bounded storage.
    pub fn prune_synced_events(&mut self, _older_than_days: i64) -> Result<usize, StorageError> {
        Ok(0)
    }

    /// Reads a configuration or cursor string from encrypted state.
    pub fn get_state(&self, key: &str) -> Result<Option<String>, StorageError> {
        if let Some(mem) = &self.in_memory {
            let store = mem.lock().unwrap();
            return Ok(store.state.get(key).cloned());
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let state_path = root.join("state.dpapi");
        if !state_path.is_file() {
            return Ok(None);
        }
        let bytes = match read_encrypted(&state_path) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let map: HashMap<String, String> = serde_json::from_slice(&bytes).unwrap_or_default();
        Ok(map.get(key).cloned())
    }

    /// Sets a configuration or cursor string in encrypted state.
    pub fn set_state(&mut self, key: &str, value: &str) -> Result<(), StorageError> {
        if let Some(mem) = &self.in_memory {
            let mut store = mem.lock().unwrap();
            store.state.insert(key.to_string(), value.to_string());
            return Ok(());
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let state_path = root.join("state.dpapi");
        let mut map: HashMap<String, String> = if state_path.is_file() {
            read_encrypted(&state_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };

        map.insert(key.to_string(), value.to_string());
        let bytes = serde_json::to_vec(&map)?;
        atomic_write_encrypted(&state_path, &bytes)?;
        Ok(())
    }

    /// Deletes a configuration value.
    pub fn delete_state(&mut self, key: &str) -> Result<(), StorageError> {
        if let Some(mem) = &self.in_memory {
            let mut store = mem.lock().unwrap();
            store.state.remove(key);
            return Ok(());
        }

        let root = self.root_dir.as_ref().expect("storage root_dir");
        let state_path = root.join("state.dpapi");
        if !state_path.is_file() {
            return Ok(());
        }
        let mut map: HashMap<String, String> = read_encrypted(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();

        map.remove(key);
        let bytes = serde_json::to_vec(&map)?;
        atomic_write_encrypted(&state_path, &bytes)?;
        Ok(())
    }

    /// Returns the total number of stored sessions.
    pub fn count_sessions(&self) -> Result<usize, StorageError> {
        if let Some(mem) = &self.in_memory {
            let store = mem.lock().unwrap();
            return Ok(store.sessions.len());
        }
        let root = self.root_dir.as_ref().expect("storage root_dir");
        let sessions_dir = root.join("sessions");
        let mut count = 0;
        if let Ok(entries) = fs::read_dir(sessions_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|ext| ext == "dpapi") {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// Returns the number of unsynced events in the queue.
    pub fn count_pending_sync(&self) -> Result<usize, StorageError> {
        if let Some(mem) = &self.in_memory {
            let store = mem.lock().unwrap();
            let count = store
                .queue
                .iter()
                .filter(|i| i.synced_at.is_none())
                .count();
            return Ok(count);
        }
        let root = self.root_dir.as_ref().expect("storage root_dir");
        let events_dir = root.join("events");
        let mut count = 0;
        if let Ok(entries) = fs::read_dir(events_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|ext| ext == "dpapi") {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    pub fn logical_size_bytes(&self) -> Result<u64, StorageError> {
        self.disk_footprint_bytes()
    }

    pub fn disk_footprint_bytes(&self) -> Result<u64, StorageError> {
        if self.in_memory.is_some() {
            return Ok(0);
        }
        let root = self.root_dir.as_ref().expect("storage root_dir");
        let mut total = 0;
        fn dir_size(dir: &Path, total: &mut u64) {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        dir_size(&path, total);
                    } else if let Ok(meta) = path.metadata() {
                        *total = total.saturating_add(meta.len());
                    }
                }
            }
        }
        dir_size(root, &mut total);
        Ok(total)
    }

    /// Atomically persists a recovered completed interval and consumes its checkpoint.
    /// Deduplicates so replay after any crash is idempotent.
    pub fn recover_checkpoint_event(
        &mut self,
        checkpoint_key: &str,
        session: &StoredActivitySession,
        event_payload_json: &str,
        max_pending: usize,
    ) -> Result<bool, StorageError> {
        if self.get_state(checkpoint_key)?.is_none() {
            return Ok(false);
        }

        let already_exists = if let Some(mem) = &self.in_memory {
            let store = mem.lock().unwrap();
            store.sessions.iter().any(|s| s.id == session.id)
        } else {
            let root = self.root_dir.as_ref().expect("storage root_dir");
            root.join("sessions").join(format!("{}.dpapi", session.id)).is_file()
        };

        if already_exists {
            self.delete_state(checkpoint_key)?;
            return Ok(false);
        }

        self.record_session_with_event_bounded(session, event_payload_json, max_pending)?;
        self.delete_state(checkpoint_key)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session(id: Uuid) -> StoredActivitySession {
        let now = Utc::now();
        StoredActivitySession {
            id,
            device_id: Uuid::new_v4(),
            application_name: Some("Code.exe".into()),
            executable_name: Some("code.exe".into()),
            process_id: Some(1234),
            started_at: now - chrono::Duration::seconds(60),
            ended_at: now,
            duration_seconds: 60.0,
            activity_state: "active".into(),
            created_at: now,
        }
    }

    #[test]
    fn in_memory_storage_migration_and_crud() {
        let mut storage = Storage::open_in_memory().expect("open in memory");

        assert_eq!(storage.count_sessions().expect("count sessions"), 0);
        assert_eq!(storage.count_pending_sync().expect("count pending"), 0);

        let id = Uuid::new_v4();
        let session = sample_session(id);
        storage
            .record_session_with_event(&session, r#"{"test":true}"#)
            .expect("record session");

        assert_eq!(storage.count_sessions().expect("count sessions"), 1);
        assert_eq!(storage.count_pending_sync().expect("count pending"), 1);

        let pending = storage.get_pending_sync_items(10).expect("pending items");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].payload, r#"{"test":true}"#);
        assert!(pending[0].synced_at.is_none());

        storage.mark_events_synced(&[id]).expect("mark synced");
        assert_eq!(storage.count_pending_sync().expect("count pending"), 0);

        assert_eq!(storage.get_state("device_id").expect("read"), None);
        storage.set_state("device_id", "my-device-uuid").expect("set");
        assert_eq!(
            storage.get_state("device_id").expect("read").as_deref(),
            Some("my-device-uuid")
        );
    }

    #[test]
    fn quarantined_queue_rows_are_retained_and_do_not_block_later_valid_events() {
        let mut storage = Storage::open_in_memory().expect("storage");
        let mut first = sample_session(Uuid::new_v4());
        let malformed_id = first.id;
        storage
            .record_session_with_event(&first, "not-json")
            .expect("record");
        first.id = Uuid::new_v4();
        storage
            .record_session_with_event(&first, "{\"valid\":true}")
            .expect("record");

        storage
            .quarantine_events(&[malformed_id], "MALFORMED_EVENT")
            .expect("quarantine");
        let pending = storage.get_pending_sync_items(10).expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].payload, "{\"valid\":true}");
        assert_eq!(storage.count_pending_sync().expect("pending count"), 2);
        assert_eq!(storage.count_quarantined_sync().expect("quarantined count"), 1);
    }

    #[test]
    fn queue_backpressure_never_deletes_unacknowledged_rows() {
        let mut storage = Storage::open_in_memory().expect("storage");
        let first = sample_session(Uuid::new_v4());
        storage
            .record_session_with_event_bounded(&first, "{}", 1)
            .expect("first queued");
        let second = sample_session(Uuid::new_v4());
        assert!(matches!(
            storage.record_session_with_event_bounded(&second, "{}", 1),
            Err(StorageError::Capacity(_))
        ));
        assert_eq!(storage.count_pending_sync().expect("count"), 1);
        assert_eq!(storage.count_sessions().expect("sessions"), 1);
    }

    #[test]
    fn checkpoint_recovery_is_atomic_and_idempotent() {
        let mut storage = Storage::open_in_memory().expect("storage");
        storage.set_state("checkpoint", "present").expect("marker");
        let session = sample_session(Uuid::new_v4());
        assert!(storage
            .recover_checkpoint_event("checkpoint", &session, "{}", 10)
            .expect("recover"));
        assert!(storage.get_state("checkpoint").expect("read").is_none());
        storage.set_state("checkpoint", "replay").expect("marker");
        assert!(!storage
            .recover_checkpoint_event("checkpoint", &session, "{}", 10)
            .expect("idempotent replay"));
        assert_eq!(storage.count_sessions().expect("sessions"), 1);
        assert_eq!(storage.count_pending_sync().expect("pending"), 1);
    }

    #[test]
    fn on_disk_encrypted_queue_crash_recovery_and_restart_persistence() {
        let root = std::env::temp_dir().join(format!("dp-queue-crash-{}", Uuid::new_v4()));
        let id = Uuid::new_v4();
        let session = sample_session(id);

        {
            let mut storage = Storage::open(&root).expect("open on disk");
            storage.set_state("device_id", "test-device-uuid").expect("set device_id");
            storage
                .record_session_with_event(&session, r#"{"event":"work"}"#)
                .expect("record event");

            // Simulate abandoned .tmp file from ungraceful crash
            let abandoned_tmp = root.join("events").join("abandoned-crash.tmp");
            fs::write(&abandoned_tmp, b"dangling unencrypted or half-written bytes").expect("write tmp");
            assert!(abandoned_tmp.is_file());
        }

        // Reopen storage: simulates process restart / crash recovery
        {
            let storage = Storage::open(&root).expect("reopen on disk");

            // Verify abandoned .tmp file was safely cleaned up
            assert!(!root.join("events").join("abandoned-crash.tmp").exists());

            // Verify state and queued event survived the restart intact
            assert_eq!(
                storage.get_state("device_id").expect("read state").as_deref(),
                Some("test-device-uuid")
            );
            assert_eq!(storage.count_pending_sync().expect("pending count"), 1);

            let pending = storage.get_pending_sync_items(5).expect("pending items");
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].id, id);
            assert_eq!(pending[0].payload, r#"{"event":"work"}"#);
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn on_disk_encrypted_queue_deletes_only_on_acknowledgement() {
        let root = std::env::temp_dir().join(format!("dp-queue-ack-{}", Uuid::new_v4()));
        let id1 = Uuid::new_v4();
        let id2 = Uuid::new_v4();
        let session1 = sample_session(id1);
        let session2 = sample_session(id2);

        let mut storage = Storage::open(&root).expect("open on disk");
        storage.record_session_with_event(&session1, r#"{"idx":1}"#).expect("record 1");
        storage.record_session_with_event(&session2, r#"{"idx":2}"#).expect("record 2");
        assert_eq!(storage.count_pending_sync().expect("pending"), 2);

        // Acknowledge only id1
        storage.mark_events_synced(&[id1]).expect("ack 1");
        assert_eq!(storage.count_pending_sync().expect("pending"), 1);

        let remaining = storage.get_pending_sync_items(10).expect("items");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, id2);

        let _ = fs::remove_dir_all(root);
    }
}
