//! DigitalPulse local storage.
//!
//! SQLite is the agent's durable *event buffer*, not a replacement for PostgreSQL.
//!
//! Milestone 3 adds:
//! * versioned migrations for `activity_sessions`, `sync_queue` and `agent_state`,
//! * repository traits with prepared statements and transactional writes,
//! * idempotent persistence keyed by event ID,
//! * bounded retention so offline collection cannot grow without limit,
//! * pending events kept until the backend acknowledges them.

/// Contract version of the events this storage layer persists.
pub const STORED_SCHEMA_VERSION: u32 = dp_core::contract::SCHEMA_VERSION;
