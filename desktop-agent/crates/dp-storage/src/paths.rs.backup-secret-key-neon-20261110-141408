//! Stable per-user storage and non-destructive migration of legacy SQLite files.

use rusqlite::{Connection, OpenFlags};
use std::io;
use std::path::{Path, PathBuf};

/// Resolve the Windows default without depending on the process working directory.
/// An explicit path remains supported for recovery and existing installations.
pub fn database_path(custom: Option<&Path>, local_app_data: Option<&Path>) -> io::Result<PathBuf> {
    if let Some(path) = custom {
        if path.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "DP_DB_PATH must not be empty",
            ));
        }
        return Ok(path.to_owned());
    }
    let root = local_app_data
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "LOCALAPPDATA is unavailable; set DP_DB_PATH to an accessible persistent file",
            )
        })?;
    Ok(root.join("DigitalPulse").join("agent_storage.db"))
}

/// Prepare a persistent directory and copy one legacy database using SQLite's
/// consistent snapshot operation (including uncheckpointed WAL contents).
/// Never remove the source, merge databases, or replace an existing destination.
pub fn prepare_database_path(
    destination: &Path,
    legacy_paths: &[PathBuf],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    if destination.exists() {
        return Ok(());
    }
    let mut sources = Vec::new();
    for path in legacy_paths {
        if !path.is_file() {
            continue;
        }
        let resolved = path.canonicalize()?;
        if !sources.contains(&resolved) {
            sources.push(resolved);
        }
    }
    if sources.len() > 1 {
        return Err("Multiple legacy agent databases found; set DP_DB_PATH to the intended database before upgrading. No records were moved.".into());
    }
    if let Some(source) = sources.first() {
        let staging = parent.join(format!("agent-migration-{}.db", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            let connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            // Reject an unrelated SQLite file without altering it.
            connection.query_row("SELECT COUNT(*) FROM agent_state", [], |row| {
                row.get::<_, i64>(0)
            })?;
            connection.execute(
                "VACUUM INTO ?1",
                [staging.to_str().ok_or("Storage path is not valid UTF-8")?],
            )?;
            // A hard link publishes the completed snapshot without replacing a
            // destination created concurrently. Both paths are on one volume.
            match std::fs::hard_link(&staging, destination) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    let mut src = std::fs::File::open(&staging)?;
                    match std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)
                    {
                        Ok(mut dst) => {
                            std::io::copy(&mut src, &mut dst)?;
                            dst.sync_all()?;
                            Ok(())
                        }
                        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(()),
                        Err(err) => Err(err.into()),
                    }
                }
                Err(error) => Err(error.into()),
            }
        })();
        let _ = std::fs::remove_file(staging);
        result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Storage;

    #[test]
    fn windows_default_is_stable_and_override_is_preserved() {
        let root = std::env::temp_dir();
        assert_eq!(
            database_path(None, Some(&root)).expect("test fixture operation must succeed"),
            root.join("DigitalPulse/agent_storage.db")
        );
        assert_eq!(
            database_path(Some(Path::new("custom.db")), None)
                .expect("test fixture operation must succeed"),
            PathBuf::from("custom.db")
        );
        assert!(database_path(None, None).is_err());
        assert!(database_path(Some(Path::new("")), Some(&root)).is_err());
    }

    #[test]
    fn migration_preserves_identity_and_queue_across_reopens_without_deleting_source() {
        let root = std::env::temp_dir().join(format!("dp-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("test fixture operation must succeed");
        let source = root.join("legacy.db");
        let target = root.join("DigitalPulse/agent_storage.db");
        {
            let mut old = Storage::open(&source).expect("test fixture operation must succeed");
            old.set_state("device_id", "persistent-device")
                .expect("test fixture operation must succeed");
            let now = chrono::Utc::now();
            old.record_session_with_event(
                &crate::StoredActivitySession {
                    id: uuid::Uuid::new_v4(),
                    device_id: uuid::Uuid::new_v4(),
                    application_name: None,
                    executable_name: None,
                    process_id: None,
                    started_at: now,
                    ended_at: now,
                    duration_seconds: 1.0,
                    activity_state: "idle".into(),
                    created_at: now,
                },
                "{}",
            )
            .expect("test fixture operation must succeed");
            // Keep the source open to exercise a database in WAL mode.
            prepare_database_path(&target, std::slice::from_ref(&source))
                .expect("test fixture operation must succeed");
        }
        for _ in 0..2 {
            prepare_database_path(&target, std::slice::from_ref(&source))
                .expect("test fixture operation must succeed");
            let stored = Storage::open(&target).expect("test fixture operation must succeed");
            assert_eq!(
                stored
                    .get_state("device_id")
                    .expect("test fixture operation must succeed")
                    .as_deref(),
                Some("persistent-device")
            );
            assert_eq!(
                stored
                    .count_pending_sync()
                    .expect("test fixture operation must succeed"),
                1
            );
        }
        assert!(source.is_file());
        std::fs::remove_dir_all(root).expect("test fixture operation must succeed");
    }

    #[test]
    fn ambiguous_legacy_files_fail_without_creating_an_empty_replacement() {
        let root = std::env::temp_dir().join(format!("dp-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("test fixture operation must succeed");
        let a = root.join("a.db");
        let b = root.join("b.db");
        drop(Storage::open(&a).expect("test fixture operation must succeed"));
        drop(Storage::open(&b).expect("test fixture operation must succeed"));
        let target = root.join("new/agent_storage.db");
        assert!(prepare_database_path(&target, &[a.clone(), b.clone()]).is_err());
        assert!(!target.exists());
        assert!(a.exists() && b.exists());
        std::fs::remove_dir_all(root).expect("test fixture operation must succeed");
    }
}
