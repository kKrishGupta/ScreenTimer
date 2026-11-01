//! DigitalPulse Windows platform layer.
//!
//! Owns every Win32 call so the rest of the agent stays safe, modular, and testable.
//!
//! Provides:
//! - [`foreground`]: Active window identification, PID query, process image resolution.
//! - [`idle`]: Keyboard/mouse dormancy detection using `GetLastInputInfo`.
//! - [`monitor`]: Polling engine emitting debounced application focus and idle transition events.
//! - [`diagnostics`]: Resident Working Set (RAM) and CPU time metrics.
//!
//! Privacy boundary: this crate never reads window contents, keystrokes, the clipboard or
//! screen pixels.

pub mod diagnostics;
pub mod foreground;
pub mod idle;
pub mod monitor;

pub use diagnostics::{get_current_process_metrics, ProcessMetrics};
pub use foreground::{
    extract_executable_name, get_current_foreground_app, get_foreground_hwnd,
    get_process_executable_path, get_window_pid, ForegroundApplication, PlatformError,
};
pub use idle::{get_system_idle_duration, IdleState, IdleTracker, IdleTransition};
pub use monitor::{ActivityMonitor, PlatformEvent};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

static SHUTDOWN_FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();

unsafe extern "system" fn console_ctrl_routine(ctrl_type: u32) -> i32 {
    // 0: CTRL_C_EVENT, 1: CTRL_BREAK_EVENT, 2: CTRL_CLOSE_EVENT
    if ctrl_type <= 2 {
        if let Some(flag) = SHUTDOWN_FLAG.get() {
            flag.store(false, Ordering::SeqCst);
        }
        1
    } else {
        0
    }
}

/// Registers an atomic flag that will be flipped to `false` when a console shutdown
/// signal (Ctrl+C, Ctrl+Break, or window close) is received.
pub fn register_console_ctrl_handler(running: Arc<AtomicBool>) {
    let _ = SHUTDOWN_FLAG.set(running);
    unsafe {
        SetConsoleCtrlHandler(Some(console_ctrl_routine), 1);
    }
}

/// Returns `true` when compiled for Windows, the only supported platform in Stage 1.
pub const fn is_supported_platform() -> bool {
    cfg!(windows)
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_is_the_target_platform() {
        assert!(super::is_supported_platform());
    }
}
