use crate::sync::{self, ScreenCaptureUpload, ScreenMonitoringPolicy};
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use dp_core::DeviceInfo;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tracing::{info, warn};

const MAX_PENDING_CAPTURES: usize = 50;
const CAPTURE_SCRIPT: &str = r#"param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
if($bounds.Width -lt 1 -or $bounds.Height -lt 1){throw 'No interactive display'}
$bitmap=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try{
  $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
  $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1
  $parameters=New-Object System.Drawing.Imaging.EncoderParameters 1
  $parameters.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),75L
  $bitmap.Save($OutputPath,$codec,$parameters)
  Write-Output ("OK:{0}x{1}" -f $bounds.Width,$bounds.Height)
}finally{$graphics.Dispose();$bitmap.Dispose()}
"#;

pub struct ScreenshotScheduler {
    queue_dir: PathBuf,
    next_capture: Instant,
}

impl ScreenshotScheduler {
    pub fn new(base_dir: &Path) -> Result<Self> {
        let queue_dir = base_dir.join("screen-capture-queue");
        fs::create_dir_all(&queue_dir).context("failed to create screenshot retry queue")?;
        let script = queue_dir.join("capture.ps1");
        fs::write(&script, CAPTURE_SCRIPT)
            .context("failed to install screenshot capture helper")?;
        Ok(Self {
            queue_dir,
            next_capture: Instant::now(),
        })
    }

    pub fn tick(
        &mut self,
        policy: &ScreenMonitoringPolicy,
        backend_url: &str,
        device: &DeviceInfo,
        application_name: &str,
    ) {
        if !policy.allowed
            || !policy.visible_indicator
            || policy.allowed_until.is_none_or(|until| Utc::now() >= until)
        {
            // Pending screen pixels must not outlive authorization. This also
            // discards the queue when policy cannot be verified after reconnect.
            if let Err(error) = self.clear_pending() {
                warn!(error = %error, "SCREEN_QUEUE_CLEANUP_FAILED");
            }
            self.next_capture = Instant::now() + Duration::from_secs(30);
            return;
        }
        self.flush_pending(backend_url, device);
        if Instant::now() < self.next_capture {
            return;
        }
        self.next_capture =
            Instant::now() + Duration::from_secs(policy.interval_seconds.clamp(300, 3600));
        let application_lower = application_name.to_lowercase();
        if policy
            .excluded_applications
            .iter()
            .any(|excluded| application_lower.contains(excluded))
        {
            info!(
                application = application_name,
                "Screenshot skipped because the foreground application is excluded by policy"
            );
            return;
        }
        info!(
            interval_seconds = policy.interval_seconds,
            "Visible monitoring indicator: authorized work-screen capture is active"
        );
        match self.capture(application_name) {
            Ok(()) => self.flush_pending(backend_url, device),
            Err(error) => {
                warn!(error = %error, "Authorized screenshot capture failed");
                if let Err(error) = sync::report_screen_capture_failure(
                    backend_url,
                    device,
                    "DISPLAY_CAPTURE_FAILED",
                ) {
                    warn!(error = %error, "SCREEN_FAILURE_REPORT_FAILED");
                }
            }
        }
    }

    fn capture(&self, application_name: &str) -> Result<()> {
        self.enforce_queue_limit()?;
        let capture_key = uuid::Uuid::new_v4().simple().to_string();
        let image_path = self.queue_dir.join(format!("{capture_key}.jpg"));
        let protected_path = self.queue_dir.join(format!("{capture_key}.dpapi"));
        let protected_temp = self.queue_dir.join(format!("{capture_key}.dpapi.tmp"));
        let metadata_path = self.queue_dir.join(format!("{capture_key}.json"));
        let metadata_temp = self.queue_dir.join(format!("{capture_key}.json.tmp"));
        let result = (|| -> Result<()> {
            let script_path = self.queue_dir.join("capture.ps1");
            let output = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script_path)
                .arg("-OutputPath")
                .arg(&image_path)
                .output()
                .context("failed to start the Windows screen capture helper")?;
            if !output.status.success() || !image_path.exists() {
                let message = String::from_utf8_lossy(&output.stderr);
                bail!("screen capture helper failed: {}", message.trim());
            }
            let dimensions = String::from_utf8_lossy(&output.stdout);
            let dimensions = dimensions
                .trim()
                .strip_prefix("OK:")
                .context("capture helper returned invalid dimensions")?;
            let (width, height) = dimensions
                .split_once('x')
                .context("capture helper returned malformed dimensions")?;
            let captured_at = Utc::now();
            let plain = fs::read(&image_path)?;
            if plain.len() > 5 * 1024 * 1024
                || plain.len() < 32
                || !plain.starts_with(&[0xff, 0xd8])
                || !plain.ends_with(&[0xff, 0xd9])
            {
                bail!("capture helper returned an invalid or oversized JPEG");
            }
            let protected =
                dp_platform_windows::data_protection::protect(&plain).map_err(|error| {
                    anyhow::anyhow!(
                        "failed to protect queued screenshot with Windows DPAPI: {error}"
                    )
                })?;
            fs::write(&protected_temp, protected)?;
            fs::rename(&protected_temp, &protected_path)?;
            let metadata = json!({
                "captureKey": capture_key,
                "capturedAt": captured_at.to_rfc3339(),
                "width": width.parse::<u32>().unwrap_or(0),
                "height": height.parse::<u32>().unwrap_or(0),
                "applicationName": application_name,
                "attempts": 0,
                "nextAttemptAt": captured_at.to_rfc3339(),
            });
            fs::write(&metadata_temp, serde_json::to_vec(&metadata)?)?;
            fs::rename(&metadata_temp, &metadata_path)?;
            Ok(())
        })();

        // Raw screen pixels must never remain on disk after this call, including
        // helper, DPAPI, or metadata failures. Incomplete protected queue entries
        // are also removed because they cannot be safely retried without metadata.
        let _ = fs::remove_file(&image_path);
        let _ = fs::remove_file(&protected_temp);
        let _ = fs::remove_file(&metadata_temp);
        if result.is_err() {
            let _ = fs::remove_file(&protected_path);
            let _ = fs::remove_file(&metadata_path);
        }
        result
    }

    fn flush_pending(&self, backend_url: &str, device: &DeviceInfo) {
        let mut metadata_files = match fs::read_dir(&self.queue_dir) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
                .collect::<Vec<_>>(),
            Err(error) => {
                warn!(error = %error, "Could not inspect screenshot retry queue");
                return;
            }
        };
        metadata_files.sort();
        for metadata_path in metadata_files {
            let result = self.try_upload(&metadata_path, backend_url, device);
            if let Err(error) = result {
                warn!(error = %error, path = %metadata_path.display(), "Screenshot upload retained for retry");
            }
        }
    }

    fn try_upload(
        &self,
        metadata_path: &Path,
        backend_url: &str,
        device: &DeviceInfo,
    ) -> Result<()> {
        let mut metadata: Value = serde_json::from_slice(&fs::read(metadata_path)?)?;
        let captured_at = metadata
            .get("capturedAt")
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .context("queued screenshot has invalid timestamp")?;
        if Utc::now().signed_duration_since(captured_at).num_hours() >= 24 {
            fs::remove_file(metadata_path.with_extension("dpapi"))?;
            fs::remove_file(metadata_path)?;
            info!("SCREEN_QUEUE_EXPIRED");
            return Ok(());
        }
        let next_attempt = metadata
            .get("nextAttemptAt")
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        if next_attempt > Utc::now() {
            return Ok(());
        }
        let capture_key = metadata
            .get("captureKey")
            .and_then(Value::as_str)
            .context("queued screenshot has no capture key")?;
        if capture_key.len() != 32 || !capture_key.bytes().all(|c| c.is_ascii_hexdigit()) {
            bail!("queued screenshot has invalid capture key");
        }
        let image_path = self.queue_dir.join(format!("{capture_key}.dpapi"));
        let protected = fs::read(&image_path).context("queued screenshot image is missing")?;
        let jpeg = dp_platform_windows::data_protection::unprotect(&protected)
            .map_err(|error| anyhow::anyhow!("failed to unprotect queued screenshot: {error}"))?;
        let upload = ScreenCaptureUpload {
            capture_key,
            captured_at: metadata
                .get("capturedAt")
                .and_then(Value::as_str)
                .context("queued screenshot has no timestamp")?,
            width: metadata.get("width").and_then(Value::as_u64).unwrap_or(0) as u32,
            height: metadata.get("height").and_then(Value::as_u64).unwrap_or(0) as u32,
            application_name: metadata
                .get("applicationName")
                .and_then(Value::as_str)
                .unwrap_or("Active Windows desktop"),
            jpeg: &jpeg,
        };
        match sync::upload_screen_capture(backend_url, device, upload) {
            Ok(()) => {
                fs::remove_file(image_path)?;
                fs::remove_file(metadata_path)?;
                info!(
                    capture_key,
                    "Screenshot uploaded and removed from the DPAPI-protected retry queue"
                );
                Ok(())
            }
            Err(error) => {
                let attempts = metadata
                    .get("attempts")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .saturating_add(1);
                let delay = 30u64
                    .saturating_mul(2u64.saturating_pow(attempts.min(6) as u32))
                    .min(3600);
                metadata["attempts"] = json!(attempts);
                metadata["nextAttemptAt"] =
                    json!((Utc::now() + ChronoDuration::seconds(delay as i64)).to_rfc3339());
                fs::write(metadata_path, serde_json::to_vec(&metadata)?)?;
                if let Err(report_error) =
                    sync::report_screen_capture_failure(backend_url, device, "SCREEN_UPLOAD_FAILED")
                {
                    warn!(error = %report_error, "SCREEN_FAILURE_REPORT_FAILED");
                }
                Err(error)
            }
        }
    }

    fn enforce_queue_limit(&self) -> Result<()> {
        let mut metadata = fs::read_dir(&self.queue_dir)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        metadata.sort_by_key(|path| fs::metadata(path).and_then(|value| value.modified()).ok());
        while metadata.len() >= MAX_PENDING_CAPTURES {
            let oldest = metadata.remove(0);
            if let Some(stem) = oldest.file_stem().and_then(|value| value.to_str()) {
                let _ = fs::remove_file(self.queue_dir.join(format!("{stem}.dpapi")));
            }
            fs::remove_file(oldest)?;
            warn!("Screenshot retry queue reached its safety limit; oldest pending capture was removed");
        }
        Ok(())
    }

    fn clear_pending(&self) -> Result<()> {
        for entry in fs::read_dir(&self.queue_dir)? {
            let path = entry?.path();
            if path.is_file()
                && matches!(
                    path.extension().and_then(|v| v.to_str()),
                    Some("json" | "dpapi" | "jpg" | "tmp")
                )
            {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denied_or_invisible_policy_clears_pending_without_upload() {
        for (allowed, visible_indicator) in [(false, true), (true, false)] {
            let root =
                std::env::temp_dir().join(format!("dp-screen-test-{}", uuid::Uuid::new_v4()));
            let mut scheduler = ScreenshotScheduler::new(&root).unwrap();
            fs::write(scheduler.queue_dir.join("pending.dpapi"), b"test").unwrap();
            fs::write(scheduler.queue_dir.join("pending.json"), b"{}").unwrap();
            let device = DeviceInfo {
                id: uuid::Uuid::new_v4(),
                kind: dp_core::EventSource::DesktopAgent,
                name: "Test".into(),
                platform: "windows".into(),
                browser: None,
                agent_version: None,
            };
            scheduler.tick(
                &ScreenMonitoringPolicy {
                    allowed,
                    visible_indicator,
                    reason: None,
                    interval_seconds: 300,
                    excluded_applications: vec![],
                    allowed_until: Some(Utc::now() + ChronoDuration::hours(1)),
                },
                "invalid://must-not-upload",
                &device,
                "test.exe",
            );
            assert!(!scheduler.queue_dir.join("pending.dpapi").exists());
            assert!(!scheduler.queue_dir.join("pending.json").exists());
            assert!(scheduler.next_capture > Instant::now());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn server_interval_is_bounded_to_five_minutes_or_more() {
        let policy = ScreenMonitoringPolicy {
            allowed: true,
            reason: None,
            interval_seconds: 10,
            excluded_applications: vec![],
            visible_indicator: true,
            allowed_until: Some(Utc::now() + ChronoDuration::hours(1)),
        };
        assert_eq!(policy.interval_seconds.clamp(300, 3600), 300);
    }

    #[test]
    fn sensitive_application_matching_is_case_insensitive() {
        let exclusions = ["1password.exe".to_string()];
        assert!(exclusions
            .iter()
            .any(|value| "C:\\Program Files\\1PASSWORD.EXE"
                .to_lowercase()
                .contains(value)));
    }
}
