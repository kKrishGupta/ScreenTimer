//! DigitalPulse local storage.
//!
//! SQLite is the agent's durable event buffer, supporting offline collection,
//! bounded queue retention, and idempotent replay until backend acknowledgement.

pub mod migrations;
pub mod paths;
pub mod repository;

pub use migrations::CURRENT_SCHEMA_VERSION;
pub use repository::{Storage, StorageError, StoredActivitySession, SyncQueueItem};

/// Contract version of the events this storage layer persists.
pub const STORED_SCHEMA_VERSION: u32 = dp_core::contract::SCHEMA_VERSION;
