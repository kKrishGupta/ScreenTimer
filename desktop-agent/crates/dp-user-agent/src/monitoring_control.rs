//! Local monitoring lifecycle state.
//!
//! This module does not grant permission to collect activity.
//! Server consent, approval, schedule and storage gates remain authoritative.

use std::time::{Duration, Instant};

pub const DEFAULT_PAUSE_DURATION: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitoringCommand {
    Stop,
    Pause,
    Resume,
}

#[derive(Debug, Clone)]
pub struct MonitoringControl {
    stopped: bool,
    paused_until: Option<Instant>,
}

impl MonitoringControl {
    pub fn new() -> Self {
        Self {
            stopped: false,
            paused_until: None,
        }
    }

    pub fn apply(&mut self, command: MonitoringCommand, now: Instant) {
        match command {
            MonitoringCommand::Stop => {
                self.stopped = true;
                self.paused_until = None;
            }
            MonitoringCommand::Pause if !self.stopped => {
                self.paused_until = now.checked_add(DEFAULT_PAUSE_DURATION);
            }
            MonitoringCommand::Resume if !self.stopped => {
                self.paused_until = None;
            }
            _ => {}
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub fn is_paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|until| now < until)
    }

    pub fn collection_allowed(&self, now: Instant, server_and_storage_allowed: bool) -> bool {
        !self.stopped && !self.is_paused(now) && server_and_storage_allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_without_local_pause() {
        let now = Instant::now();
        let control = MonitoringControl::new();

        assert!(control.collection_allowed(now, true));
        assert!(!control.collection_allowed(now, false));
    }

    #[test]
    fn pause_blocks_collection_until_expiry() {
        let now = Instant::now();
        let mut control = MonitoringControl::new();

        control.apply(MonitoringCommand::Pause, now);

        assert!(!control.collection_allowed(now, true));
        assert!(!control.collection_allowed(
            now + DEFAULT_PAUSE_DURATION - Duration::from_secs(1),
            true
        ));
        assert!(control.collection_allowed(
            now + DEFAULT_PAUSE_DURATION,
            true
        ));
    }

    #[test]
    fn resume_cannot_override_server_gate() {
        let now = Instant::now();
        let mut control = MonitoringControl::new();

        control.apply(MonitoringCommand::Pause, now);
        control.apply(MonitoringCommand::Resume, now);

        assert!(!control.collection_allowed(now, false));
        assert!(control.collection_allowed(now, true));
    }

    #[test]
    fn stop_is_terminal() {
        let now = Instant::now();
        let mut control = MonitoringControl::new();

        control.apply(MonitoringCommand::Stop, now);
        control.apply(MonitoringCommand::Resume, now);
        control.apply(MonitoringCommand::Pause, now);

        assert!(control.is_stopped());
        assert!(!control.collection_allowed(now, true));
    }

    #[test]
    fn second_pause_restarts_fifteen_minute_window() {
        let now = Instant::now();
        let mut control = MonitoringControl::new();

        control.apply(MonitoringCommand::Pause, now);
        control.apply(
            MonitoringCommand::Pause,
            now + Duration::from_secs(60),
        );

        assert!(control.is_paused(now + DEFAULT_PAUSE_DURATION));
        assert!(!control.is_paused(
            now + DEFAULT_PAUSE_DURATION + Duration::from_secs(60)
        ));
    }
}