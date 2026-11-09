//! User-scoped DPAPI protection for queued screenshot bytes.

#[cfg(windows)]
mod windows {
    use std::io;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn transform(bytes: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let result =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            LocalFree(output.pbData as *mut core::ffi::c_void);
        }
        Ok(result)
    }

    pub fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
        transform(bytes, true)
    }
    pub fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
        transform(bytes, false)
    }
}

#[cfg(windows)]
pub use windows::{protect, unprotect};

#[cfg(not(windows))]
pub fn protect(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI is available only on Windows".into())
}

#[cfg(not(windows))]
pub fn unprotect(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI is available only on Windows".into())
}
