//! Small WinHTTP JSON transport using the Windows certificate store for HTTPS.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[cfg(windows)]
pub fn post_json(
    host: &str,
    port: u16,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    secure: bool,
) -> Result<HttpResponse, String> {
    request("POST", host, port, path, headers, body, secure)
}

#[cfg(windows)]
pub fn request(
    method_name: &str,
    host: &str,
    port: u16,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    secure: bool,
) -> Result<HttpResponse, String> {
    use std::io;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_DISABLE_REDIRECTS, WINHTTP_FLAG_SECURE,
        WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    struct Handle(*mut core::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    WinHttpCloseHandle(self.0);
                }
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn ensure(ok: i32, action: &str) -> Result<(), String> {
        if ok == 0 {
            Err(format!("{action}: {}", io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }

    let user_agent = wide("DigitalPulse-Agent/0.1");
    let host_w = wide(host);
    if !matches!(method_name, "GET" | "POST" | "DELETE") {
        return Err("unsupported HTTP method".into());
    }
    let method = wide(method_name);
    let path_w = wide(path);
    let header_text = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let header_w = wide(&header_text);
    let session = Handle(unsafe {
        WinHttpOpen(
            user_agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    });
    if session.0.is_null() {
        return Err(format!(
            "WinHTTP initialization failed: {}",
            io::Error::last_os_error()
        ));
    }
    ensure(
        unsafe { WinHttpSetTimeouts(session.0, 5000, 5000, 5000, 10000) },
        "could not set HTTP timeouts",
    )?;
    let connection = Handle(unsafe { WinHttpConnect(session.0, host_w.as_ptr(), port, 0) });
    if connection.0.is_null() {
        return Err(format!(
            "WinHTTP connection failed: {}",
            io::Error::last_os_error()
        ));
    }
    let flags = if secure { WINHTTP_FLAG_SECURE } else { 0 };
    let request = Handle(unsafe {
        WinHttpOpenRequest(
            connection.0,
            method.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            flags,
        )
    });
    if request.0.is_null() {
        return Err(format!(
            "WinHTTP request creation failed: {}",
            io::Error::last_os_error()
        ));
    }
    let disable_redirects = WINHTTP_DISABLE_REDIRECTS;
    ensure(
        unsafe {
            WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_DISABLE_FEATURE,
                &disable_redirects as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        },
        "could not disable HTTP redirects",
    )?;
    ensure(
        unsafe {
            WinHttpSendRequest(
                request.0,
                header_w.as_ptr(),
                header_text.encode_utf16().count() as u32,
                if body.is_empty() {
                    std::ptr::null()
                } else {
                    body.as_ptr() as *const core::ffi::c_void
                },
                body.len() as u32,
                body.len() as u32,
                0,
            )
        },
        "could not send HTTP request",
    )?;
    ensure(
        unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) },
        "could not receive HTTP response",
    )?;

    let mut status = 0u32;
    let mut status_bytes = std::mem::size_of::<u32>() as u32;
    ensure(
        unsafe {
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                std::ptr::null(),
                &mut status as *mut u32 as *mut core::ffi::c_void,
                &mut status_bytes,
                std::ptr::null_mut(),
            )
        },
        "could not read HTTP response status",
    )?;

    let mut response_body = Vec::new();
    loop {
        let mut available = 0u32;
        ensure(
            unsafe { WinHttpQueryDataAvailable(request.0, &mut available) },
            "could not inspect HTTP response",
        )?;
        if available == 0 {
            break;
        }
        if response_body.len().saturating_add(available as usize) > 2 * 1024 * 1024 {
            return Err("HTTP response exceeded the 2 MiB safety limit".into());
        }
        let start = response_body.len();
        response_body.resize(start + available as usize, 0);
        let mut read = 0u32;
        ensure(
            unsafe {
                WinHttpReadData(
                    request.0,
                    response_body[start..].as_mut_ptr() as *mut core::ffi::c_void,
                    available,
                    &mut read,
                )
            },
            "could not read HTTP response",
        )?;
        response_body.truncate(start + read as usize);
    }
    Ok(HttpResponse {
        status: status as u16,
        body: response_body,
    })
}

#[cfg(not(windows))]
pub fn post_json(
    _host: &str,
    _port: u16,
    _path: &str,
    _headers: &[(String, String)],
    _body: &[u8],
    _secure: bool,
) -> Result<HttpResponse, String> {
    Err("WinHTTP is available only on Windows".into())
}

#[cfg(not(windows))]
pub fn request(
    _method_name: &str,
    _host: &str,
    _port: u16,
    _path: &str,
    _headers: &[(String, String)],
    _body: &[u8],
    _secure: bool,
) -> Result<HttpResponse, String> {
    Err("WinHTTP is available only on Windows".into())
}
