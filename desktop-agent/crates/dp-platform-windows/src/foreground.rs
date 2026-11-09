//! Native Windows foreground application detection.
//!
//! Uses Win32 APIs:
//! - `GetForegroundWindow`
//! - `GetWindowThreadProcessId`
//! - `OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION`
//! - `QueryFullProcessImageNameW`
//!
//! Follows strict security/privacy boundaries:
//! - Never inspects window text or document content.
//! - Handles inaccessible/elevated system processes gracefully.
//! - Cleans up all Win32 handles using RAII.

use std::path::{Path, PathBuf};
use thiserror::Error;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Errors encountered while inspecting Windows processes or windows.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PlatformError {
    #[error("No foreground window is currently active")]
    NoForegroundWindow,
    #[error("Failed to retrieve process ID for window handle")]
    InvalidWindowProcessId,
    #[error("Process access denied or protected (PID {0})")]
    ProcessAccessDenied(u32),
    #[error("QueryFullProcessImageName failed for PID {0}")]
    QueryImageFailed(u32),
}

/// Metadata identifying the currently active foreground application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundApplication {
    pub process_id: u32,
    pub executable_name: String,
    pub executable_path: Option<String>,
    pub window_handle: isize,
}

/// RAII wrapper around a Win32 process `HANDLE` to prevent handle leaks.
struct AutoHandle(HANDLE);

impl Drop for AutoHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != -1isize as HANDLE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Retrieves the raw HWND of the current foreground window.
pub fn get_foreground_hwnd() -> Option<HWND> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            None
        } else {
            Some(hwnd)
        }
    }
}

/// Extracts the process ID owning the given window handle.
// HWND is an opaque OS handle, not a pointer dereferenced by this wrapper.
// Windows validates invalid/stale handles and leaves pid zero on failure.
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn get_window_pid(hwnd: HWND) -> Option<u32> {
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if pid == 0 {
        None
    } else {
        Some(pid)
    }
}

/// Resolves the full executable path of a process given its process ID.
///
/// Uses `PROCESS_QUERY_LIMITED_INFORMATION` which works even when the target process
/// runs under different credentials or is sandboxed, provided it is not protected.
pub fn get_process_executable_path(pid: u32) -> Result<PathBuf, PlatformError> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(PlatformError::ProcessAccessDenied(pid));
        }
        let _guard = AutoHandle(handle);

        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;

        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        if ok == 0 || size == 0 {
            return Err(PlatformError::QueryImageFailed(pid));
        }

        let path_str = String::from_utf16_lossy(&buffer[..size as usize]);
        Ok(PathBuf::from(path_str))
    }
}

/// Extracts the file name (e.g. `Code.exe`) from a path.
pub fn extract_executable_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_owned())
        .unwrap_or_else(|| "unknown.exe".to_string())
}

/// Inspects the current foreground window and returns its application metadata.
///
/// If the process image path is inaccessible (e.g. secure system process),
/// the returned struct contains the process ID with an estimated fallback name
/// (e.g. `system_pid_4.exe`), avoiding crashes or hard failures.
pub fn get_current_foreground_app() -> Result<ForegroundApplication, PlatformError> {
    let hwnd = get_foreground_hwnd().ok_or(PlatformError::NoForegroundWindow)?;
    let pid = get_window_pid(hwnd).ok_or(PlatformError::InvalidWindowProcessId)?;

    let (exe_name, exe_path) = match get_process_executable_path(pid) {
        Ok(path) => {
            let name = extract_executable_name(&path);
            let path_str = path.to_string_lossy().into_owned();
            (name, Some(path_str))
        }
        Err(_) => {
            // Inaccessible process (e.g. csrss.exe, system, or admin prompt)
            let fallback_name = if pid == 4 {
                "System.exe".to_string()
            } else {
                format!("process_{}.exe", pid)
            };
            (fallback_name, None)
        }
    };

    Ok(ForegroundApplication {
        process_id: pid,
        executable_name: exe_name,
        executable_path: exe_path,
        window_handle: hwnd as isize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_name_from_standard_path() {
        let p = Path::new(r"C:\Program Files\Notepad++\notepad++.exe");
        assert_eq!(extract_executable_name(p), "notepad++.exe");
    }

    #[test]
    fn current_process_executable_path_resolves() {
        let my_pid = std::process::id();
        let path = get_process_executable_path(my_pid).expect("current process path must resolve");
        assert!(path.exists());
        let name = extract_executable_name(&path);
        assert!(name.to_lowercase().ends_with(".exe"));
    }
}
