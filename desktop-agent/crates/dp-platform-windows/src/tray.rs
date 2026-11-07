//! Employee-visible Windows notification-area indicator for active screen monitoring.
//!
//! The indicator is deliberately owned by the interactive user-session agent. It is
//! shown only while the server-authorized screenshot policy is active and is removed
//! immediately when monitoring stops or the process exits.

use std::mem::size_of;

use tracing::warn;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, LoadIconW, PeekMessageW, TranslateMessage,
    IDI_SHIELD, MSG, PM_REMOVE,
};

const INDICATOR_ID: u32 = 0x4450_5343; // "DPSC"
const TOOLTIP: &str = "DigitalPulse: authorized screen monitoring is active";

/// Maintains the persistent notification-area icon for the lifetime of the agent.
pub struct ScreenMonitoringIndicator {
    data: NOTIFYICONDATAW,
    visible: bool,
}

impl std::fmt::Debug for ScreenMonitoringIndicator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ScreenMonitoringIndicator")
            .field("visible", &self.visible)
            .finish_non_exhaustive()
    }
}

impl ScreenMonitoringIndicator {
    pub fn new() -> Self {
        // Own a hidden notification window in this process and interactive
        // session. A console window can belong to a different host process.
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "DigitalPulse screen monitoring\0".encode_utf16().collect();
        let window = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        let mut data = NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: window,
            uID: INDICATOR_ID,
            uFlags: NIF_ICON | NIF_TIP,
            hIcon: unsafe { LoadIconW(std::ptr::null_mut(), IDI_SHIELD) },
            ..Default::default()
        };

        let tooltip: Vec<u16> = TOOLTIP.encode_utf16().collect();
        let length = tooltip.len().min(data.szTip.len().saturating_sub(1));
        data.szTip[..length].copy_from_slice(&tooltip[..length]);

        Self {
            data,
            visible: false,
        }
    }

    /// Shows or removes the indicator. Repeated calls are no-ops.
    pub fn set_active(&mut self, active: bool) -> bool {
        if self.data.hWnd.is_null() || self.data.hIcon.is_null() {
            return false;
        }
        let mut message: MSG = unsafe { std::mem::zeroed() };
        unsafe {
            while PeekMessageW(&mut message, self.data.hWnd, 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if !active && !self.visible {
            return false;
        }

        let operation = if active && self.visible {
            NIM_MODIFY
        } else if active {
            NIM_ADD
        } else {
            NIM_DELETE
        };
        let mut succeeded = unsafe { Shell_NotifyIconW(operation, &self.data) } != 0;
        // Explorer may have restarted and forgotten the icon. Re-register it.
        if !succeeded && active && self.visible {
            succeeded = unsafe { Shell_NotifyIconW(NIM_ADD, &self.data) } != 0;
        }
        if succeeded {
            self.visible = active;
        } else {
            self.visible = false;
            warn!(
                active,
                "Unable to update the screen-monitoring notification icon"
            );
        }
        self.visible
    }
}

impl Default for ScreenMonitoringIndicator {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ScreenMonitoringIndicator {
    fn drop(&mut self) {
        if self.visible {
            unsafe {
                Shell_NotifyIconW(NIM_DELETE, &self.data);
            }
            self.visible = false;
        }
        if !self.data.hWnd.is_null() {
            unsafe {
                DestroyWindow(self.data.hWnd);
            }
        }
    }
}
