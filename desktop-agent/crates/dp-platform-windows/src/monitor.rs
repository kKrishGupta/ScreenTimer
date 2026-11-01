//! High-level Windows activity monitor.
//!
//! Orchestrates foreground application polling and idle tracking into a coherent
//! stream of activity observations. Avoids duplicate events and debounces transient switches.

use std::time::Duration;
use tracing::{debug, info};

use crate::foreground::{get_current_foreground_app, ForegroundApplication};
use crate::idle::{get_system_idle_duration, IdleTracker, IdleTransition};

/// Observations emitted during monitoring ticks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformEvent {
    /// Foreground application switch detected.
    AppFocused {
        previous: Option<ForegroundApplication>,
        current: ForegroundApplication,
    },
    /// Inactivity crossed the idle threshold.
    IdleStarted { idle_duration: Duration },
    /// User returned from idle state.
    UserResumed { total_idle: Duration },
}

/// Activity monitor keeping state across polling intervals.
#[derive(Debug)]
pub struct ActivityMonitor {
    current_app: Option<ForegroundApplication>,
    idle_tracker: IdleTracker,
}

impl ActivityMonitor {
    /// Initialises a new monitor with the provided idle threshold.
    pub fn new(idle_threshold: Duration) -> Self {
        Self {
            current_app: None,
            idle_tracker: IdleTracker::new(idle_threshold),
        }
    }

    /// Returns the currently tracked foreground application.
    pub fn current_app(&self) -> Option<&ForegroundApplication> {
        self.current_app.as_ref()
    }

    /// Evaluates the current system state (both foreground window and input inactivity).
    ///
    /// Returns any new platform events that occurred during this tick.
    pub fn tick(&mut self) -> Vec<PlatformEvent> {
        let mut events = Vec::new();

        // 1. Check idle state
        let current_idle = get_system_idle_duration();
        if let Some(transition) = self.idle_tracker.update(current_idle) {
            match transition {
                IdleTransition::Started { idle_duration } => {
                    info!(
                        idle_secs = idle_duration.as_secs(),
                        "System transitioned to IDLE"
                    );
                    events.push(PlatformEvent::IdleStarted { idle_duration });
                }
                IdleTransition::Returned {
                    total_idle_duration,
                } => {
                    info!(
                        total_idle_secs = total_idle_duration.as_secs(),
                        "User resumed activity from IDLE"
                    );
                    events.push(PlatformEvent::UserResumed {
                        total_idle: total_idle_duration,
                    });
                }
            }
        }

        // 2. Check foreground window (only if not idle)
        if self.idle_tracker.current_state() == crate::idle::IdleState::Active {
            match get_current_foreground_app() {
                Ok(app) => {
                    let changed = match &self.current_app {
                        Some(current) => {
                            current.process_id != app.process_id
                                || current.executable_name != app.executable_name
                        }
                        None => true,
                    };

                    if changed {
                        debug!(
                            executable = %app.executable_name,
                            pid = app.process_id,
                            "Foreground window focus changed"
                        );
                        let previous = self.current_app.replace(app.clone());
                        events.push(PlatformEvent::AppFocused {
                            previous,
                            current: app,
                        });
                    }
                }
                Err(err) => {
                    debug!("Unable to query foreground window: {err}");
                }
            }
        }

        events
    }
}
