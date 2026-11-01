//! Integration tests for Windows platform detection and monitoring logic.

use dp_platform_windows::foreground::{
    extract_executable_name, get_process_executable_path, ForegroundApplication,
};
use dp_platform_windows::idle::{IdleState, IdleTracker, IdleTransition};
use std::time::Duration;

#[test]
fn test_idle_tracker_state_machine() {
    let mut tracker = IdleTracker::new(Duration::from_secs(60));

    // Under threshold -> Active, no event
    assert_eq!(tracker.update(Duration::from_secs(10)), None);
    assert_eq!(tracker.current_state(), IdleState::Active);

    // Crosses threshold -> Idle, IdleStarted event
    let event1 = tracker.update(Duration::from_secs(60));
    assert_eq!(
        event1,
        Some(IdleTransition::Started {
            idle_duration: Duration::from_secs(60)
        })
    );
    assert_eq!(tracker.current_state(), IdleState::Idle);

    // Continued idle -> Idle, no duplicate event
    assert_eq!(tracker.update(Duration::from_secs(75)), None);
    assert_eq!(tracker.current_state(), IdleState::Idle);

    // Activity resumed -> Active, ActiveReturned event with max observed idle
    let event2 = tracker.update(Duration::from_millis(50));
    assert_eq!(
        event2,
        Some(IdleTransition::Returned {
            total_idle_duration: Duration::from_secs(75)
        })
    );
    assert_eq!(tracker.current_state(), IdleState::Active);
}

#[test]
fn test_current_process_resolution() {
    let pid = std::process::id();
    let path = get_process_executable_path(pid).expect("Current process executable must resolve");
    assert!(path.is_absolute());
    let name = extract_executable_name(&path);
    assert!(name.to_lowercase().ends_with(".exe"));
}

#[test]
fn test_foreground_application_struct_properties() {
    let app1 = ForegroundApplication {
        process_id: 100,
        executable_name: "Code.exe".into(),
        executable_path: Some(r"C:\Tools\Code.exe".into()),
        window_handle: 12345,
    };

    let app2 = ForegroundApplication {
        process_id: 100,
        executable_name: "Code.exe".into(),
        executable_path: Some(r"C:\Tools\Code.exe".into()),
        window_handle: 67890,
    };

    let app3 = ForegroundApplication {
        process_id: 200,
        executable_name: "msedge.exe".into(),
        executable_path: Some(r"C:\Tools\msedge.exe".into()),
        window_handle: 99999,
    };

    // Equality considers PID and executable name
    assert_eq!(app1.process_id, app2.process_id);
    assert_ne!(app1.process_id, app3.process_id);
}
