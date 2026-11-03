//! SQLite migrations for the local agent buffer.

use rusqlite::{Connection, Result};
use tracing::info;

pub const CURRENT_SCHEMA_VERSION: i32 = 2;

pub fn run_migrations(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;

    let current: Option<i32> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap_or(None);

    let version = current.unwrap_or(0);

    if version < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS activity_sessions (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                application_name TEXT,
                executable_name TEXT,
                process_id INTEGER,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_seconds REAL NOT NULL,
                activity_state TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_queue (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                synced_at TEXT
            );

            CREATE TABLE IF NOT EXISTS agent_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_activity_sessions_started 
                ON activity_sessions(started_at);

            CREATE INDEX IF NOT EXISTS idx_sync_queue_pending 
                ON sync_queue(synced_at, created_at);

            INSERT INTO schema_migrations (version, applied_at)
            VALUES (1, datetime('now'));",
        )?;
        tx.commit()?;
        info!("Applied SQLite storage migration v1");
    }

    if version < 2 {
        let tx = conn.transaction()?;
        tx.execute_batch(
            "ALTER TABLE sync_queue ADD COLUMN quarantined_at TEXT;
            ALTER TABLE sync_queue ADD COLUMN quarantine_reason TEXT;
            INSERT INTO schema_migrations (version, applied_at)
            VALUES (2, datetime('now'));",
        )?;
        tx.commit()?;
        info!("Applied SQLite storage migration v2");
    }

    Ok(())
}
