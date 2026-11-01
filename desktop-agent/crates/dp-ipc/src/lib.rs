//! DigitalPulse IPC.
//!
//! The user agent (interactive session) and the Windows service (Session 0) will talk over
//! a local named pipe. The pipe is created with an explicit security descriptor that only
//! admits `SYSTEM` and the interactive user, with remote clients rejected
//! (`PIPE_REJECT_REMOTE_CLIENTS`).
//!
//! Per the Stage 1 plan this is implemented only after the foreground collector is
//! verified. Until then the user agent synchronises directly with the local backend.

/// Fully-qualified pipe name reserved for agent-to-service communication.
pub const PIPE_NAME: &str = r"\\.\pipe\DigitalPulse.Agent.v1";

#[cfg(test)]
mod tests {
    #[test]
    fn pipe_name_is_local() {
        assert!(super::PIPE_NAME.starts_with(r"\\.\pipe\"));
    }
}
