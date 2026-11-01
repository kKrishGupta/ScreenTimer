//! Native Windows idle time detection.
//!
//! Uses Win32 `GetLastInputInfo` compared against `GetTickCount64`.
//! Tracks keyboard and mouse dormancy to determine when the user is idle.
//!
//! Provides an `IdleTracker` state machine that generates crisp transition events:
//! - `IdleStarted`: Triggered when inactivity exceeds the configured threshold.
//! - `ActiveReturned`: Triggered when the user produces keyboard/mouse input after being idle.

use std::time::Duration;
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

/// Queries the operating system for the elapsed time since the last user input event.
pub fn get_system_idle_duration() -> Duration {
    let mut lii = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut lii) != 0 {
            let current_tick = GetTickCount64();
            let current_low = (current_tick & 0xFFFF_FFFF) as u32;
            let elapsed_ms = current_low.wrapping_sub(lii.dwTime);
            Duration::from_millis(elapsed_ms as u64)
        } else {
            Duration::ZERO
        }
    }
}

/// State of user presence according to input inactivity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleState {
    Active,
    Idle,
}

/// Events emitted upon state transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleTransition {
    /// Inactivity just crossed the threshold.
    Started { idle_duration: Duration },
    /// User provided input after being idle.
    Returned { total_idle_duration: Duration },
}

/// Manages idle state transitions while suppressing redundant notifications.
#[derive(Debug, Clone)]
pub struct IdleTracker {
    threshold: Duration,
    current_state: IdleState,
    max_idle_observed: Duration,
}

impl IdleTracker {
    /// Creates a new tracker with the specified idle threshold.
    pub fn new(threshold: Duration) -> Self {
        Self {
            threshold,
            current_state: IdleState::Active,
            max_idle_observed: Duration::ZERO,
        }
    }

    /// Returns the configured threshold.
    pub fn threshold(&self) -> Duration {
        self.threshold
    }

    /// Returns the current state.
    pub fn current_state(&self) -> IdleState {
        self.current_state
    }

    /// Evaluates the current idle duration and returns an event if a state transition occurred.
    pub fn update(&mut self, current_idle: Duration) -> Option<IdleTransition> {
        match self.current_state {
            IdleState::Active => {
                if current_idle >= self.threshold {
                    self.current_state = IdleState::Idle;
                    self.max_idle_observed = current_idle;
                    Some(IdleTransition::Started {
                        idle_duration: current_idle,
                    })
                } else {
                    None
                }
            }
            IdleState::Idle => {
                if current_idle < self.threshold {
                    // User has returned
                    let total = self.max_idle_observed;
                    self.current_state = IdleState::Active;
                    self.max_idle_observed = Duration::ZERO;
                    Some(IdleTransition::Returned {
                        total_idle_duration: total,
                    })
                } else {
                    if current_idle > self.max_idle_observed {
                        self.max_idle_observed = current_idle;
                    }
                    None
                }
            }
        }
    }

    /// Manually marks the user as active (e.g. on session unlock or window activation).
    pub fn force_active(&mut self) -> Option<IdleTransition> {
        if self.current_state == IdleState::Idle {
            let total = self.max_idle_observed;
            self.current_state = IdleState::Active;
            self.max_idle_observed = Duration::ZERO;
            Some(IdleTransition::Returned {
                total_idle_duration: total,
            })
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_system_idle_does_not_panic() {
        let dur = get_system_idle_duration();
        // Just verify it returns without error
        assert!(dur.as_millis() < 86_400_000 * 10);
    }

    #[test]
    fn idle_tracker_transitions() {
        let mut tracker = IdleTracker::new(Duration::from_secs(60));
        assert_eq!(tracker.current_state(), IdleState::Active);

        // 30 seconds idle: still active
        assert_eq!(tracker.update(Duration::from_secs(30)), None);
        assert_eq!(tracker.current_state(), IdleState::Active);

        // 60 seconds idle: transitions to Idle
        assert_eq!(
            tracker.update(Duration::from_secs(60)),
            Some(IdleTransition::Started {
                idle_duration: Duration::from_secs(60)
            })
        );
        assert_eq!(tracker.current_state(), IdleState::Idle);

        // 65 seconds idle: duplicate suppressed, max updated
        assert_eq!(tracker.update(Duration::from_secs(65)), None);
        assert_eq!(tracker.current_state(), IdleState::Idle);

        // Input detected! idle resets to 0s: transitions to Active
        assert_eq!(
            tracker.update(Duration::from_millis(100)),
            Some(IdleTransition::Returned {
                total_idle_duration: Duration::from_secs(65)
            })
        );
        assert_eq!(tracker.current_state(), IdleState::Active);
    }
}
