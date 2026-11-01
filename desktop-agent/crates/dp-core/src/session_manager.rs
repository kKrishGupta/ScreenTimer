//! Activity session manager.
//!
//! Responsible for:
//! - Calculating continuous application and idle usage intervals.
//! - Enforcing that idle periods are not double-counted as active application usage.
//! - Generating schema-compliant `ActivityEvent` objects.
//! - Suppressing sub-second window switching noise.

use chrono::{DateTime, Utc};
use std::time::Duration;
use uuid::Uuid;

use crate::contract::{ActivityEvent, AppInfo, EventSource, EventType, SCHEMA_VERSION};

/// State of the currently tracked interval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    ActiveApp,
    Idle,
}

/// In-progress tracking interval.
#[derive(Debug, Clone)]
struct OpenInterval {
    session_id: Uuid,
    started_at: DateTime<Utc>,
    state: SessionState,
    app: Option<AppInfo>,
}

/// Orchestrates session lifecycle, focus switches, and idle transitions without overlapping.
#[derive(Debug)]
pub struct SessionManager {
    device_id: Uuid,
    current_interval: Option<OpenInterval>,
}

impl SessionManager {
    /// Creates a new session manager bound to the local `device_id`.
    pub fn new(device_id: Uuid) -> Self {
        Self {
            device_id,
            current_interval: None,
        }
    }

    /// Returns the currently active device ID.
    pub fn device_id(&self) -> Uuid {
        self.device_id
    }

    /// Handles foreground window focus.
    ///
    /// If the newly focused application matches the current open interval,
    /// no new event is generated (suppresses duplicate transition events).
    /// If an interval was already open, it is closed and returned if it lasted >= 1 second.
    pub fn handle_app_focus(
        &mut self,
        app_name: String,
        executable_name: String,
        process_id: u32,
        now: DateTime<Utc>,
    ) -> Option<ActivityEvent> {
        // If already tracking the same application, ignore
        if let Some(open) = &self.current_interval {
            if open.state == SessionState::ActiveApp {
                if let Some(app) = &open.app {
                    if app.executable == executable_name && app.process_id == Some(process_id) {
                        return None;
                    }
                }
            }
        }

        // Close any prior interval
        let completed_event = self.close_active_session(now);

        // Start new ActiveApp interval
        let session_id = Uuid::new_v4();
        self.current_interval = Some(OpenInterval {
            session_id,
            started_at: now,
            state: SessionState::ActiveApp,
            app: Some(AppInfo {
                name: app_name,
                executable: executable_name,
                process_id: Some(process_id),
            }),
        });

        completed_event
    }

    /// Handles system idle start.
    ///
    /// Deducts `idle_duration` from the active application to ensure idle time is
    /// NEVER double-counted as active application usage.
    pub fn handle_idle_start(
        &mut self,
        idle_duration: Duration,
        now: DateTime<Utc>,
    ) -> Option<ActivityEvent> {
        let mut completed_event = None;

        if let Some(open) = self.current_interval.take() {
            if open.state == SessionState::ActiveApp {
                // The user went idle `idle_duration` ago
                let idle_started_at =
                    now - chrono::Duration::from_std(idle_duration).unwrap_or_default();
                let effective_end = if idle_started_at > open.started_at {
                    idle_started_at
                } else {
                    open.started_at
                };

                let duration_seconds =
                    (effective_end - open.started_at).num_milliseconds() as f64 / 1000.0;
                if duration_seconds >= 1.0 {
                    let event = ActivityEvent {
                        schema_version: SCHEMA_VERSION,
                        event_id: open.session_id,
                        device_id: self.device_id,
                        source: EventSource::DesktopAgent,
                        event_type: EventType::AppSession,
                        started_at: open.started_at,
                        ended_at: effective_end,
                        duration_seconds,
                        app: open.app,
                        web: None,
                    };
                    completed_event = Some(event);
                }

                // Begin Idle interval starting at the moment of actual dormancy
                self.current_interval = Some(OpenInterval {
                    session_id: Uuid::new_v4(),
                    started_at: effective_end,
                    state: SessionState::Idle,
                    app: None,
                });
            } else {
                // Already in idle interval
                self.current_interval = Some(open);
            }
        } else {
            let idle_started_at =
                now - chrono::Duration::from_std(idle_duration).unwrap_or_default();
            self.current_interval = Some(OpenInterval {
                session_id: Uuid::new_v4(),
                started_at: idle_started_at,
                state: SessionState::Idle,
                app: None,
            });
        }

        completed_event
    }

    /// Handles user returning from idle dormancy.
    ///
    /// Closes the idle interval and records its exact duration.
    pub fn handle_idle_return(
        &mut self,
        _total_idle: Duration,
        now: DateTime<Utc>,
    ) -> Option<ActivityEvent> {
        if let Some(open) = self.current_interval.take() {
            if open.state == SessionState::Idle {
                let duration_seconds = (now - open.started_at).num_milliseconds() as f64 / 1000.0;
                if duration_seconds >= 1.0 {
                    return Some(ActivityEvent {
                        schema_version: SCHEMA_VERSION,
                        event_id: open.session_id,
                        device_id: self.device_id,
                        source: EventSource::DesktopAgent,
                        event_type: EventType::IdleSession,
                        started_at: open.started_at,
                        ended_at: now,
                        duration_seconds,
                        app: None,
                        web: None,
                    });
                }
            }
        }
        None
    }

    /// Closes whatever session interval is currently open (used on shutdown or application switch).
    pub fn close_active_session(&mut self, now: DateTime<Utc>) -> Option<ActivityEvent> {
        let open = self.current_interval.take()?;
        let duration_seconds = (now - open.started_at).num_milliseconds() as f64 / 1000.0;

        // Filter sub-second transients
        if duration_seconds < 1.0 {
            return None;
        }

        let event_type = match open.state {
            SessionState::ActiveApp => EventType::AppSession,
            SessionState::Idle => EventType::IdleSession,
        };

        Some(ActivityEvent {
            schema_version: SCHEMA_VERSION,
            event_id: open.session_id,
            device_id: self.device_id,
            source: EventSource::DesktopAgent,
            event_type,
            started_at: open.started_at,
            ended_at: now,
            duration_seconds,
            app: open.app,
            web: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_session_lifecycle() {
        let device_id = Uuid::new_v4();
        let mut manager = SessionManager::new(device_id);

        let t0 = Utc::now();
        // Focus App 1
        assert!(manager
            .handle_app_focus("Code".into(), "Code.exe".into(), 100, t0)
            .is_none());

        // Repeated focus on same app should NOT generate an event
        let t1 = t0 + chrono::Duration::seconds(5);
        assert!(manager
            .handle_app_focus("Code".into(), "Code.exe".into(), 100, t1)
            .is_none());

        // Switch to App 2 after 15 seconds
        let t2 = t0 + chrono::Duration::seconds(15);
        let event = manager.handle_app_focus("Edge".into(), "msedge.exe".into(), 200, t2);

        assert!(event.is_some());
        let e = event.unwrap();
        assert_eq!(e.event_type, EventType::AppSession);
        assert_eq!(e.app.as_ref().unwrap().executable, "Code.exe");
        assert_eq!(e.duration_seconds, 15.0);
        assert_eq!(e.validate(), Ok(()));
    }

    #[test]
    fn test_idle_does_not_double_count_app_time() {
        let device_id = Uuid::new_v4();
        let mut manager = SessionManager::new(device_id);

        let t0 = Utc::now();
        manager.handle_app_focus("Code".into(), "Code.exe".into(), 100, t0);

        // After 70 seconds of clock time, system reports user has been idle for 60 seconds
        let t1 = t0 + chrono::Duration::seconds(70);
        let idle_dur = Duration::from_secs(60);
        let app_event = manager
            .handle_idle_start(idle_dur, t1)
            .expect("app closed upon idle");

        // App active time should be 70 - 60 = 10 seconds!
        assert_eq!(app_event.duration_seconds, 10.0);
        assert_eq!(app_event.ended_at, t0 + chrono::Duration::seconds(10));
        assert_eq!(app_event.validate(), Ok(()));

        // User returns after 120 seconds of idle
        let t2 = t1 + chrono::Duration::seconds(60);
        let idle_event = manager
            .handle_idle_return(Duration::from_secs(120), t2)
            .expect("idle event closed");
        assert_eq!(idle_event.event_type, EventType::IdleSession);
        assert_eq!(idle_event.duration_seconds, 120.0);
        assert_eq!(idle_event.validate(), Ok(()));
    }

    #[test]
    fn test_transient_flicker_suppressed() {
        let device_id = Uuid::new_v4();
        let mut manager = SessionManager::new(device_id);

        let t0 = Utc::now();
        manager.handle_app_focus("Code".into(), "Code.exe".into(), 100, t0);

        // Switch after 200ms (momentary Alt+Tab flicker)
        let t1 = t0 + chrono::Duration::milliseconds(200);
        let event = manager.handle_app_focus("Popup".into(), "popup.exe".into(), 999, t1);
        assert!(
            event.is_none(),
            "sub-second flicker should not emit session"
        );
    }
}
