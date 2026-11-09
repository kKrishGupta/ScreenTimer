//! SQLite repository implementation with prepared statements and transactions.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

use crate::migrations::run_migrations;

/// Storage errors.
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("SQLite database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Failed to parse UUID in database record: {0}")]
    UuidParse(#[from] uuid::Error),
    #[error("Failed to parse timestamp in database record: {0}")]
    ChronoParse(#[from] chrono::ParseError),
    #[error("storage backpressure: {0}")]
    Capacity(String),
}

/// A stored activity session interval.
#[derive(Debug, Clone, PartialEq)]
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

/// A pending or synced item in the outbound sync queue.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncQueueItem {
    pub id: Uuid,
    pub event_type: String,
    pub payload: String,
    pub created_at: DateTime<Utc>,
    pub synced_at: Option<DateTime<Utc>>,
}

/// High-level SQLite storage interface.
#[derive(Debug)]
pub struct Storage {
    conn: Connection,
    path: Option<PathBuf>,
}

impl Storage {
    /// Opens or creates a persistent SQLite database file at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref().to_owned();
        let mut conn = Connection::open(&path)?;
        // Enable Write-Ahead Logging (WAL) for concurrent read performance
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        run_migrations(&mut conn)?;
        Ok(Self {
            conn,
            path: Some(path),
        })
    }

    /// Opens an isolated in-memory SQLite database (used for unit testing).
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let mut conn = Connection::open_in_memory()?;
        run_migrations(&mut conn)?;
        Ok(Self { conn, path: None })
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
        let tx = self.conn.transaction()?;
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE synced_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        if max_pending != usize::MAX && (pending as u64) >= max_pending as u64 {
            return Err(StorageError::Capacity(format!(
                "activity queue limit {max_pending} reached; no unacknowledged rows were deleted"
            )));
        }

        // 1. Insert session record
        tx.execute(
            "INSERT OR REPLACE INTO activity_sessions (
                id, device_id, application_name, executable_name, process_id,
                started_at, ended_at, duration_seconds, activity_state, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                session.id.to_string(),
                session.device_id.to_string(),
                session.application_name,
                session.executable_name,
                session.process_id,
                session.started_at.to_rfc3339(),
                session.ended_at.to_rfc3339(),
                session.duration_seconds,
                session.activity_state,
                session.created_at.to_rfc3339(),
            ],
        )?;

        // 2. Enqueue event for backend synchronization
        tx.execute(
            "INSERT OR REPLACE INTO sync_queue (
                id, event_type, payload, created_at, synced_at
            ) VALUES (?1, ?2, ?3, ?4, NULL)",
            params![
                session.id.to_string(),
                session.activity_state,
                event_payload_json,
                session.created_at.to_rfc3339(),
            ],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Retrieves up to `limit` pending events from the sync queue.
    pub fn get_pending_sync_items(&self, limit: usize) -> Result<Vec<SyncQueueItem>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, event_type, payload, created_at, synced_at
             FROM sync_queue
             WHERE synced_at IS NULL
               AND quarantined_at IS NULL
             ORDER BY created_at ASC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            let id_str: String = row.get(0)?;
            let event_type: String = row.get(1)?;
            let payload: String = row.get(2)?;
            let created_str: String = row.get(3)?;
            let synced_str: Option<String> = row.get(4)?;

            Ok((id_str, event_type, payload, created_str, synced_str))
        })?;

        let mut items = Vec::new();
        for row in rows {
            let (id_str, event_type, payload, created_str, synced_str) = row?;
            let id = Uuid::parse_str(&id_str).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            let created_at = DateTime::parse_from_rfc3339(&created_str)
                .map(|dt| dt.with_timezone(&Utc))
                .map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
            let synced_at = match synced_str {
                Some(s) => Some(
                    DateTime::parse_from_rfc3339(&s)
                        .map(|dt| dt.with_timezone(&Utc))
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                4,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?,
                ),
                None => None,
            };

            items.push(SyncQueueItem {
                id,
                event_type,
                payload,
                created_at,
                synced_at,
            });
        }

        Ok(items)
    }

    /// Marks the specified batch of event IDs as synced in the queue.
    pub fn mark_events_synced(&mut self, ids: &[Uuid]) -> Result<(), StorageError> {
        if ids.is_empty() {
            return Ok(());
        }

        let tx = self.conn.transaction()?;
        let now = Utc::now().to_rfc3339();

        let mut stmt = tx.prepare("UPDATE sync_queue SET synced_at = ?1 WHERE id = ?2")?;
        for id in ids {
            stmt.execute(params![now, id.to_string()])?;
        }
        drop(stmt);

        tx.commit()?;
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
        let tx = self.conn.transaction()?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE synced_at IS NULL AND quarantined_at IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        if count.saturating_add(ids.len() as i64) > max_quarantined as i64 {
            return Err(StorageError::Capacity(format!(
                "quarantine limit {max_quarantined} reached; rows remain pending and were not deleted"
            )));
        }
        let now = Utc::now().to_rfc3339();
        let mut stmt = tx.prepare(
            "UPDATE sync_queue SET quarantined_at = ?1, quarantine_reason = ?2
             WHERE id = ?3 AND synced_at IS NULL",
        )?;
        for id in ids {
            stmt.execute(params![now, reason, id.to_string()])?;
        }
        drop(stmt);
        tx.commit()?;
        Ok(())
    }

    /// Returns the number of unsynced rows retained for manual review.
    pub fn count_quarantined_sync(&self) -> Result<usize, StorageError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE synced_at IS NULL AND quarantined_at IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    /// Prunes already-synced events older than `older_than_days` to enforce bounded storage.
    pub fn prune_synced_events(&mut self, older_than_days: i64) -> Result<usize, StorageError> {
        let cutoff = (Utc::now() - chrono::Duration::days(older_than_days)).to_rfc3339();
        let count = self.conn.execute(
            "DELETE FROM sync_queue WHERE synced_at IS NOT NULL AND synced_at < ?1",
            params![cutoff],
        )?;
        Ok(count)
    }

    /// Reads a configuration or cursor string from `agent_state`.
    pub fn get_state(&self, key: &str) -> Result<Option<String>, StorageError> {
        self.conn
            .query_row(
                "SELECT value FROM agent_state WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Sets a configuration or cursor string in `agent_state`.
    pub fn set_state(&mut self, key: &str, value: &str) -> Result<(), StorageError> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT OR REPLACE INTO agent_state (key, value, updated_at)
             VALUES (?1, ?2, ?3)",
            params![key, value, now],
        )?;
        Ok(())
    }

    /// Deletes a configuration value after it has been migrated to secure storage.
    pub fn delete_state(&mut self, key: &str) -> Result<(), StorageError> {
        self.conn
            .execute("DELETE FROM agent_state WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Returns the total number of stored sessions.
    pub fn count_sessions(&self) -> Result<usize, StorageError> {
        let count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM activity_sessions", [], |row| {
                    row.get(0)
                })?;
        Ok(count as usize)
    }

    /// Returns the number of unsynced events in the queue.
    pub fn count_pending_sync(&self) -> Result<usize, StorageError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE synced_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    pub fn logical_size_bytes(&self) -> Result<u64, StorageError> {
        let page_count: u64 = self
            .conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: u64 = self
            .conn
            .query_row("PRAGMA page_size", [], |row| row.get(0))?;
        Ok(page_count.saturating_mul(page_size))
    }

    pub fn disk_footprint_bytes(&self) -> Result<u64, StorageError> {
        let Some(path) = &self.path else {
            return self.logical_size_bytes();
        };
        let mut total = std::fs::metadata(path)
            .map(|value| value.len())
            .unwrap_or(0);
        let path_text = path.to_string_lossy();
        for suffix in ["-wal", "-shm"] {
            total = total.saturating_add(
                std::fs::metadata(format!("{path_text}{suffix}"))
                    .map(|value| value.len())
                    .unwrap_or(0),
            );
        }
        Ok(total)
    }

    /// Atomically persists a recovered completed interval and consumes its
    /// checkpoint. INSERT OR IGNORE makes replay idempotent after any crash.
    pub fn recover_checkpoint_event(
        &mut self,
        checkpoint_key: &str,
        session: &StoredActivitySession,
        event_payload_json: &str,
        max_pending: usize,
    ) -> Result<bool, StorageError> {
        let tx = self.conn.transaction()?;
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sync_queue WHERE synced_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        if max_pending != usize::MAX && (pending as u64) >= max_pending as u64 {
            return Err(StorageError::Capacity(format!(
                "activity queue limit {max_pending} reached; checkpoint retained"
            )));
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO activity_sessions (id,device_id,application_name,executable_name,process_id,started_at,ended_at,duration_seconds,activity_state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![session.id.to_string(),session.device_id.to_string(),session.application_name,session.executable_name,session.process_id,session.started_at.to_rfc3339(),session.ended_at.to_rfc3339(),session.duration_seconds,session.activity_state,session.created_at.to_rfc3339()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO sync_queue (id,event_type,payload,created_at,synced_at) VALUES (?1,?2,?3,?4,NULL)",
            params![session.id.to_string(),session.activity_state,event_payload_json,session.created_at.to_rfc3339()],
        )?;
        tx.execute(
            "DELETE FROM agent_state WHERE key=?1",
            params![checkpoint_key],
        )?;
        tx.commit()?;
        Ok(inserted == 1)
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
            application_name: Some("Code".into()),
            executable_name: Some("Code.exe".into()),
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

        assert_eq!(
            storage
                .count_sessions()
                .expect("test fixture operation must succeed"),
            0
        );
        assert_eq!(
            storage
                .count_pending_sync()
                .expect("test fixture operation must succeed"),
            0
        );

        let id = Uuid::new_v4();
        let session = sample_session(id);
        storage
            .record_session_with_event(&session, r#"{"test":true}"#)
            .expect("record session");

        assert_eq!(
            storage
                .count_sessions()
                .expect("test fixture operation must succeed"),
            1
        );
        assert_eq!(
            storage
                .count_pending_sync()
                .expect("test fixture operation must succeed"),
            1
        );

        // Fetch pending items
        let pending = storage.get_pending_sync_items(10).expect("pending items");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].payload, r#"{"test":true}"#);
        assert!(pending[0].synced_at.is_none());

        // Mark synced
        storage.mark_events_synced(&[id]).expect("mark synced");
        assert_eq!(
            storage
                .count_pending_sync()
                .expect("test fixture operation must succeed"),
            0
        );

        // State get/set
        assert_eq!(
            storage
                .get_state("device_id")
                .expect("test fixture operation must succeed"),
            None
        );
        storage
            .set_state("device_id", "my-device-uuid")
            .expect("test fixture operation must succeed");
        assert_eq!(
            storage
                .get_state("device_id")
                .expect("test fixture operation must succeed")
                .as_deref(),
            Some("my-device-uuid")
        );
    }

    #[test]
    fn quarantined_queue_rows_are_retained_and_do_not_block_later_valid_events() {
        let mut storage = Storage::open_in_memory().expect("test fixture operation must succeed");
        let mut first = sample_session(Uuid::new_v4());
        let malformed_id = first.id;
        storage
            .record_session_with_event(&first, "not-json")
            .expect("test fixture operation must succeed");
        first.id = Uuid::new_v4();
        storage
            .record_session_with_event(&first, "{\"valid\":true}")
            .expect("test fixture operation must succeed");

        storage
            .quarantine_events(&[malformed_id], "MALFORMED_EVENT")
            .expect("test fixture operation must succeed");
        let pending = storage
            .get_pending_sync_items(10)
            .expect("test fixture operation must succeed");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].payload, "{\"valid\":true}");
        assert_eq!(
            storage
                .count_pending_sync()
                .expect("test fixture operation must succeed"),
            2
        );
        assert_eq!(
            storage
                .count_quarantined_sync()
                .expect("test fixture operation must succeed"),
            1
        );
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
}
