//! DigitalPulse Windows platform layer.
//!
//! Owns every `unsafe` Win32 call so the rest of the agent stays safe and testable.
//!
//! Milestone 2 adds:
//! * foreground window detection (`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`,
//!   `GetForegroundWindow`, `GetWindowThreadProcessId`),
//! * process identification (`OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION`,
//!   `QueryFullProcessImageNameW`),
//! * idle detection (`GetLastInputInfo` vs. `GetTickCount`),
//! * session lock/unlock and sleep/wake notifications.
//!
//! Privacy boundary: this crate never reads window content, keystrokes, the clipboard or
//! screen pixels.

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
