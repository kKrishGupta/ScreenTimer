//! Process resource profiling and diagnostics for DigitalPulse.
//!
//! Provides accurate measurements for:
//! - Working Set memory (RAM usage) via `GetProcessMemoryInfo`
//! - Total CPU time (User + Kernel) via `GetProcessTimes`

use std::mem::size_of;
use std::time::Duration;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

/// Resource metrics for the current process.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProcessMetrics {
    /// Resident memory (Working Set) in megabytes.
    pub working_set_mb: f64,
    /// Peak resident memory in megabytes.
    pub peak_working_set_mb: f64,
    /// Total CPU time consumed (User mode + Kernel mode).
    pub total_cpu_time: Duration,
}

/// Retrieves the current memory and CPU metrics for the calling process.
pub fn get_current_process_metrics() -> Option<ProcessMetrics> {
    unsafe {
        let process = GetCurrentProcess();

        // 1. Memory counters
        let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        pmc.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;

        let mem_ok = GetProcessMemoryInfo(
            process,
            &mut pmc as *mut PROCESS_MEMORY_COUNTERS as *mut _,
            pmc.cb,
        );

        if mem_ok == 0 {
            return None;
        }

        let working_set_mb = pmc.WorkingSetSize as f64 / (1024.0 * 1024.0);
        let peak_working_set_mb = pmc.PeakWorkingSetSize as f64 / (1024.0 * 1024.0);

        // 2. CPU times
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut kernel = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut user = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };

        let time_ok = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user);

        let total_cpu_time = if time_ok != 0 {
            let kernel_100ns =
                ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
            let user_100ns = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
            Duration::from_nanos((kernel_100ns + user_100ns) * 100)
        } else {
            Duration::ZERO
        };

        Some(ProcessMetrics {
            working_set_mb,
            peak_working_set_mb,
            total_cpu_time,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_metrics_valid() {
        let metrics = get_current_process_metrics().expect("metrics must be readable");
        assert!(metrics.working_set_mb > 0.0);
        assert!(metrics.peak_working_set_mb >= metrics.working_set_mb);
    }
}
