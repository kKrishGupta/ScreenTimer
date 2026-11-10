//! Local Windows named-pipe control, restricted to the current user and SYSTEM.
//! Commands are acknowledged only after the monitoring loop applies them.
//!
//! Protocol (message-mode pipe, one request per connection):
//!   client -> server: `STOP` | `PAUSE` | `RESUME` (ASCII, case-insensitive, <= 64 bytes)
//!   server -> client: `OK` | `ERR:<REASON>`
//!
//! Security:
//! * Protected DACL grants access only to the agent's own user SID and LocalSystem.
//! * `FILE_FLAG_FIRST_PIPE_INSTANCE` + a single instance prevents pipe-name squatting.
//! * `PIPE_REJECT_REMOTE_CLIENTS` blocks SMB/network clients.
//! * The connected client's process token SID is re-checked before any command is accepted.
//! * This channel never grants permission to collect; server gates remain authoritative.

use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tracing::{info, warn};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_MORE_DATA, ERROR_PIPE_CONNECTED, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::monitoring_control::MonitoringCommand;

pub const PIPE_NAME: &str = r"\\.\pipe\DigitalPulse.UserControl.v1";
const MAX_MESSAGE_BYTES: usize = 64;
const PIPE_BUFFER_BYTES: u32 = 512;
/// Upper bound for the monitoring loop to apply a command (screenshot cancel + session flush).
const APPLY_TIMEOUT: Duration = Duration::from_secs(30);
/// Well-known LocalSystem SID string.
const SYSTEM_SID: &str = "S-1-5-18";

/// A command waiting for the monitoring loop. `reply` receives `true` only after
/// the loop has fully applied the command.
#[derive(Debug)]
pub struct ControlRequest {
    pub command: MonitoringCommand,
    pub reply: SyncSender<bool>,
}

struct OwnedHandle(HANDLE);
// SAFETY: Kernel handles may be used from any thread; ownership moves to the listener thread.
unsafe impl Send for OwnedHandle {}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: The handle is owned by this wrapper and closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct LocalMem(*mut c_void);
impl Drop for LocalMem {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Memory was allocated by a Win32 API documented to require LocalFree.
            unsafe { LocalFree(self.0) };
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Reads the TOKEN_USER buffer of a token. The SID pointer is valid while the buffer lives.
fn token_user_buffer(token: HANDLE) -> Result<Vec<u64>> {
    let mut needed: u32 = 0;
    // SAFETY: Size query with a null buffer is the documented usage.
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed) };
    if needed == 0 {
        bail!("GetTokenInformation size query failed ({})", unsafe { GetLastError() });
    }
    // u64 storage keeps the buffer suitably aligned for TOKEN_USER.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: Buffer is at least `needed` bytes and aligned.
    let ok = unsafe {
        GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), needed, &mut needed)
    };
    if ok == 0 {
        bail!("GetTokenInformation failed ({})", unsafe { GetLastError() });
    }
    Ok(buf)
}

fn sid_from_buffer(buf: &[u64]) -> *mut c_void {
    // SAFETY: Buffer was filled by GetTokenInformation(TokenUser).
    unsafe { (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid }
}

fn current_user_token_buffer() -> Result<Vec<u64>> {
    let mut token: HANDLE = null_mut();
    // SAFETY: Pseudo-handle from GetCurrentProcess needs no close.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        bail!("OpenProcessToken failed ({})", unsafe { GetLastError() });
    }
    let token = OwnedHandle(token);
    token_user_buffer(token.0)
}

fn sid_to_string(sid: *mut c_void) -> Result<String> {
    let mut out: *mut u16 = null_mut();
    // SAFETY: `sid` points into a live TOKEN_USER buffer.
    if unsafe { ConvertSidToStringSidW(sid, &mut out) } == 0 {
        bail!("ConvertSidToStringSidW failed ({})", unsafe { GetLastError() });
    }
    let guard = LocalMem(out.cast());
    let mut len = 0usize;
    // SAFETY: `out` is a NUL-terminated wide string allocated by the API.
    while unsafe { *out.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: `len` elements were verified above.
    let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(out, len) });
    drop(guard);
    Ok(text)
}

fn is_valid_sid_string(s: &str) -> bool {
    s.strip_prefix("S-1-")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '-'))
}

fn create_pipe(user_sid: &str) -> Result<OwnedHandle> {
    if !is_valid_sid_string(user_sid) {
        bail!("unexpected user SID format");
    }
    // Protected DACL: generic all for the current user and LocalSystem only.
    let sddl = wide(&format!("D:P(A;;GA;;;{user_sid})(A;;GA;;;SY)"));
    let mut descriptor: *mut c_void = null_mut();
    // SAFETY: Valid NUL-terminated SDDL string; descriptor is freed by LocalMem.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        bail!("security descriptor creation failed ({})", unsafe { GetLastError() });
    }
    let descriptor = LocalMem(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let name = wide(PIPE_NAME);
    // SAFETY: All pointers are valid for the duration of the call; the kernel copies the descriptor.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        bail!(
            "could not create local control pipe; another DigitalPulse agent may already be running ({})",
            unsafe { GetLastError() }
        );
    }
    Ok(OwnedHandle(handle))
}

/// Verifies the connected client runs as the agent's own user or LocalSystem.
fn client_is_authorized(pipe: HANDLE, own_sid: *mut c_void, system_sid: &str) -> bool {
    let mut pid: u32 = 0;
    // SAFETY: Valid connected pipe handle.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 || pid == 0 {
        return false;
    }
    // SAFETY: Query-only access; handle is closed by OwnedHandle.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    let process = OwnedHandle(process);
    let mut token: HANDLE = null_mut();
    // SAFETY: Valid process handle.
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let token = OwnedHandle(token);
    let Ok(buf) = token_user_buffer(token.0) else {
        return false;
    };
    let client_sid = sid_from_buffer(&buf);
    // SAFETY: Both SIDs point into live TOKEN_USER buffers.
    if unsafe { EqualSid(client_sid, own_sid) } != 0 {
        return true;
    }
    sid_to_string(client_sid).is_ok_and(|s| s == system_sid)
}

fn parse_command(raw: &[u8]) -> Option<MonitoringCommand> {
    let text = std::str::from_utf8(raw).ok()?.trim();
    match text.to_ascii_uppercase().as_str() {
        "STOP" => Some(MonitoringCommand::Stop),
        "PAUSE" => Some(MonitoringCommand::Pause),
        "RESUME" => Some(MonitoringCommand::Resume),
        _ => None,
    }
}

fn read_message(pipe: HANDLE) -> std::result::Result<Vec<u8>, &'static str> {
    let mut buf = [0u8; MAX_MESSAGE_BYTES];
    let mut read: u32 = 0;
    // SAFETY: Buffer and length are valid; synchronous I/O.
    let ok = unsafe {
        ReadFile(pipe, buf.as_mut_ptr(), buf.len() as u32, &mut read, null_mut())
    };
    if ok == 0 {
        // SAFETY: Reads thread-local last error.
        let err = unsafe { GetLastError() };
        return Err(if err == ERROR_MORE_DATA { "TOO_LARGE" } else { "READ_FAILED" });
    }
    Ok(buf[..read as usize].to_vec())
}

fn write_reply(pipe: HANDLE, reply: &str) {
    let bytes = reply.as_bytes();
    let mut written: u32 = 0;
    // SAFETY: Buffer and length are valid; synchronous I/O.
    unsafe {
        WriteFile(pipe, bytes.as_ptr(), bytes.len() as u32, &mut written, null_mut());
        FlushFileBuffers(pipe);
    }
}

fn serve(pipe: OwnedHandle, own_token: Vec<u64>, sender: SyncSender<ControlRequest>) {
    let own_sid = sid_from_buffer(&own_token);
    loop {
        // SAFETY: Valid pipe handle; blocking connect.
        let connected = unsafe { ConnectNamedPipe(pipe.0, null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected {
            thread::sleep(Duration::from_millis(250));
            continue;
        }

        let reply = if !client_is_authorized(pipe.0, own_sid, SYSTEM_SID) {
            warn!("Rejected local control client with unexpected identity");
            "ERR:UNAUTHORIZED".to_string()
        } else {
            match read_message(pipe.0) {
                Err(reason) => format!("ERR:{reason}"),
                Ok(raw) => match parse_command(&raw) {
                    None => "ERR:UNKNOWN_COMMAND".to_string(),
                    Some(command) => {
                        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                        if sender.send(ControlRequest { command, reply: reply_tx }).is_err() {
                            // Monitoring loop has exited; stop serving.
                            write_reply(pipe.0, "ERR:UNAVAILABLE");
                            // SAFETY: Valid connected pipe.
                            unsafe { DisconnectNamedPipe(pipe.0) };
                            return;
                        }
                        match reply_rx.recv_timeout(APPLY_TIMEOUT) {
                            Ok(true) => {
                                info!(?command, "Local control command applied");
                                "OK".to_string()
                            }
                            Ok(false) => "ERR:NOT_APPLIED".to_string(),
                            Err(mpsc::RecvTimeoutError::Timeout) => "ERR:TIMEOUT".to_string(),
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                "ERR:UNAVAILABLE".to_string()
                            }
                        }
                    }
                },
            }
        };
        write_reply(pipe.0, &reply);
        // SAFETY: Valid pipe; prepares the single instance for the next client.
        unsafe { DisconnectNamedPipe(pipe.0) };
    }
}

/// Creates the secured pipe synchronously (so failures surface to the caller) and
/// serves requests on a background thread.
pub fn start_listener() -> Result<Receiver<ControlRequest>> {
    let own_token = current_user_token_buffer().context("could not read agent user identity")?;
    let user_sid = sid_to_string(sid_from_buffer(&own_token))?;
    let pipe = create_pipe(&user_sid)?;
    // Bounded queue: a client blocks rather than queueing unbounded commands.
    let (sender, receiver) = mpsc::sync_channel::<ControlRequest>(4);

    thread::Builder::new()
        .name("dp-local-control".into())
        .spawn(move || serve(pipe, own_token, sender))
        .context("failed to start local control listener")?;

    info!(pipe = PIPE_NAME, "Authenticated local monitoring control listening");
    Ok(receiver)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_commands_only() {
        assert_eq!(parse_command(b"STOP"), Some(MonitoringCommand::Stop));
        assert_eq!(parse_command(b" pause \r\n"), Some(MonitoringCommand::Pause));
        assert_eq!(parse_command(b"Resume"), Some(MonitoringCommand::Resume));
        assert_eq!(parse_command(b"DELETE"), None);
        assert_eq!(parse_command(&[0xff, 0xfe]), None);
    }

    #[test]
    fn rejects_malformed_sid_strings() {
        assert!(is_valid_sid_string("S-1-5-21-1-2-3-1001"));
        assert!(!is_valid_sid_string("S-1-5)(A;;GA;;;WD"));
        assert!(!is_valid_sid_string("WD"));
    }
}
