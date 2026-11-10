//! Stable per-user storage paths and non-destructive legacy storage migration.

use std::io;
use std::path::{Path, PathBuf};

/// Resolve the Windows default storage directory without depending on the process working directory.
/// An explicit path remains supported for recovery and custom installations.
pub fn storage_dir(custom: Option<&Path>, local_app_data: Option<&Path>) -> io::Result<PathBuf> {
    if let Some(path) = custom {
        if path.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "DP_STORAGE_PATH must not be empty",
            ));
        }
        if path.extension().is_some() {
            return Ok(path.parent().unwrap_or(Path::new(".")).join("queue"));
        }
        return Ok(path.to_owned());
    }
    let root = local_app_data
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "LOCALAPPDATA is unavailable; set DP_STORAGE_PATH to an accessible persistent directory",
            )
        })?;
    Ok(root.join("DigitalPulse").join("queue"))
}

/// Backward compatibility alias for database_path.
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

/// Prepare a persistent storage directory.
pub fn prepare_storage_dir(destination: &Path) -> io::Result<()> {
    std::fs::create_dir_all(destination)?;
    std::fs::create_dir_all(destination.join("events"))?;
    std::fs::create_dir_all(destination.join("sessions"))?;
    std::fs::create_dir_all(destination.join("quarantine"))?;
    Ok(())
}

/// Prepare storage path while preserving and safely migrating from legacy paths if needed.
/// Never deletes source legacy files without explicit user approval.
pub fn prepare_database_path(
    destination: &Path,
    legacy_paths: &[PathBuf],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;

    let mut sources = Vec::new();
    for path in legacy_paths {
        if !path.is_file() {
            continue;
        }
        if let Ok(resolved) = path.canonicalize() {
            if !sources.contains(&resolved) {
                sources.push(resolved);
            }
        }
    }
    if sources.len() > 1 {
        return Err("Multiple legacy agent databases found; set DP_DB_PATH to the intended database before upgrading. No records were moved.".into());
    }

    let queue_dir = if destination.extension().is_some() {
        parent.join("queue")
    } else {
        destination.to_owned()
    };
    prepare_storage_dir(&queue_dir)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_default_is_stable_and_override_is_preserved() {
        let root = std::env::temp_dir();
        assert_eq!(
            database_path(None, Some(&root)).expect("default database path"),
            root.join("DigitalPulse/agent_storage.db")
        );
        assert_eq!(
            database_path(Some(Path::new("custom.db")), None).expect("custom path"),
            PathBuf::from("custom.db")
        );
        assert!(database_path(None, None).is_err());
        assert!(database_path(Some(Path::new("")), Some(&root)).is_err());

        assert_eq!(
            storage_dir(None, Some(&root)).expect("default storage dir"),
            root.join("DigitalPulse/queue")
        );
    }

    #[test]
    fn ambiguous_legacy_files_fail_without_creating_an_empty_replacement() {
        let root = std::env::temp_dir().join(format!("dp-paths-ambig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("test directory");
        let a = root.join("a.db");
        let b = root.join("b.db");
        std::fs::write(&a, b"test sqlite a").expect("write a");
        std::fs::write(&b, b"test sqlite b").expect("write b");

        let target = root.join("new/agent_storage.db");
        assert!(prepare_database_path(&target, &[a.clone(), b.clone()]).is_err());
        assert!(a.is_file() && b.is_file());

        let _ = std::fs::remove_dir_all(root);
    }
}
