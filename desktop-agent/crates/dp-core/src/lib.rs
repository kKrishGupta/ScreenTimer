//! DigitalPulse core.
//!
//! Platform-independent building blocks shared by the user agent and the service:
//!
//! * [`contract`] - the v1 activity event contract, mirrored from
//!   `shared/contracts/schemas/*.json` (the single source of truth).
//! * [`config`] - agent configuration with safe defaults.
//!
//! This crate must not depend on any Windows API so that its logic stays unit-testable.

pub mod config;
pub mod contract;
pub mod session_manager;

pub use config::{parse_backend_url, AgentConfig, BackendUrl};
pub use contract::{
    ActivityBatch, ActivityEvent, AppInfo, ContractError, DeviceInfo, EventSource, EventType,
};
pub use session_manager::{SessionCheckpoint, SessionManager, SessionState};

/// Version of the desktop agent, reported to the backend during synchronisation.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
