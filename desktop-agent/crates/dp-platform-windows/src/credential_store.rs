//! User-scoped Windows Credential Manager storage for long-lived device secrets.

#[cfg(windows)]
mod windows {
    use std::io;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn target(device_id: &str) -> Vec<u16> {
        format!("DigitalPulse/DeviceSecret/{device_id}")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    pub fn store_device_secret(device_id: &str, secret: &str) -> Result<(), String> {
        let target_name = target(device_id);
        let mut username: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target_name.as_ptr() as *mut u16,
            CredentialBlobSize: secret.len() as u32,
            CredentialBlob: secret.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };
        let succeeded = unsafe { CredWriteW(&credential, 0) };
        if succeeded == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    pub fn read_device_secret(device_id: &str) -> Result<Option<String>, String> {
        let target_name = target(device_id);
        let mut credential = std::ptr::null_mut();
        let succeeded =
            unsafe { CredReadW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if succeeded == 0 {
            let code = unsafe { GetLastError() };
            if code == 1168 {
                // ERROR_NOT_FOUND
                return Ok(None);
            }
            return Err(io::Error::from_raw_os_error(code as i32).to_string());
        }
        let stored = unsafe {
            if credential.is_null() {
                Err("Windows Credential Manager returned an empty credential".to_string())
            } else {
                let value = &*credential;
                if value.CredentialBlob.is_null() || value.CredentialBlobSize == 0 {
                    Err("Windows Credential Manager returned an empty device secret".to_string())
                } else {
                    let bytes = std::slice::from_raw_parts(
                        value.CredentialBlob,
                        value.CredentialBlobSize as usize,
                    );
                    String::from_utf8(bytes.to_vec())
                        .map(Some)
                        .map_err(|_| "Stored device secret is not valid UTF-8".to_string())
                }
            }
        };
        unsafe { CredFree(credential as *const core::ffi::c_void) };
        stored
    }

    pub fn delete_device_secret(device_id: &str) -> Result<(), String> {
        let target_name = target(device_id);
        let succeeded = unsafe { CredDeleteW(target_name.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if succeeded == 0 {
            let code = unsafe { GetLastError() };
            if code == 1168 {
                return Ok(());
            }
            return Err(io::Error::from_raw_os_error(code as i32).to_string());
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use windows::{delete_device_secret, read_device_secret, store_device_secret};

#[cfg(not(windows))]
pub fn store_device_secret(_device_id: &str, _secret: &str) -> Result<(), String> {
    Err("Windows Credential Manager is available only on Windows".into())
}

#[cfg(not(windows))]
pub fn read_device_secret(_device_id: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub fn delete_device_secret(_device_id: &str) -> Result<(), String> {
    Err("Windows Credential Manager is available only on Windows".into())
}
