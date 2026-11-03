//! Windows session lock detection. Collection pauses on an unknown desktop.

#[cfg(windows)]
pub fn is_workstation_locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
    };
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return true;
    }
    let mut name = [0u16; 128];
    let mut needed = 0u32;
    let readable = unsafe {
        GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr() as *mut core::ffi::c_void,
            std::mem::size_of_val(&name) as u32,
            &mut needed,
        )
    };
    unsafe {
        CloseDesktop(desktop);
    }
    if readable == 0 {
        return true;
    }
    let end = name
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(name.len());
    String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Winlogon")
}

#[cfg(not(windows))]
pub fn is_workstation_locked() -> bool {
    false
}
