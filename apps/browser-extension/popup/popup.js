import { CONFIG } from '../shared/constants.js';
import { normalizeBackendUrl } from '../shared/backend-settings.js';
import { initializeCapturePermission } from './capture-permission.js';

document.addEventListener('DOMContentLoaded', async () => {
  initializeCapturePermission(document, chrome);
  const statusBadge = document.getElementById('status-badge');
  const deviceIdEl = document.getElementById('device-id');
  const queueCountEl = document.getElementById('queue-count');
  const queueAuditEl = document.getElementById('queue-audit');
  const retrySkippedBtn = document.getElementById('retry-skipped');
  const exportQuarantineBtn = document.getElementById('export-quarantine');
  const activeDomainEl = document.getElementById('active-domain');
  const syncBtn = document.getElementById('sync-btn');
  const enrollBtn = document.getElementById('enroll-btn');
  const enrollmentToken = document.getElementById('enrollment-token');
  const enrollmentPanel = document.getElementById('enrollment-panel');
  const enrollmentStatus = document.getElementById('enrollment-status');
  const deviceStatus = document.getElementById('device-status');
  const lastSyncEl = document.getElementById('last-sync');
  const lastHeartbeatEl = document.getElementById('last-heartbeat');
  const connectionKeys = [
    'dp_device_connection_status', 'dp_device_lifecycle_status', 'dp_last_heartbeat_at', 'dp_last_successful_sync_at',
    'dp_sync_error', 'dp_monitoring_allowed', 'dp_monitoring_allowed_until', 'dp_monitoring_reason', 'dp_policy_sync',
  ];

  const stored = await chrome.storage.local.get([
    CONFIG.DEVICE_STORAGE_KEY, CONFIG.SYNC_QUEUE_STORAGE_KEY, CONFIG.SETTINGS_STORAGE_KEY,
    'dp_active_domain', 'dp_enrollment_status', ...connectionKeys,
  ]);
  const enrollmentState = await chrome.runtime.sendMessage({ action: 'get_enrollment_state' }).catch(() => null);
  const workerDiagnostics = await chrome.runtime.sendMessage({ action: 'get_worker_diagnostics' }).catch((error) => ({ ok: false, error: error.message }));
  const extensionVersion = workerDiagnostics?.workerVersion || chrome.runtime.getManifest?.()?.version || 'unknown';
  document.getElementById('extension-version').textContent = `v${extensionVersion} (${workerDiagnostics?.ok ? 'worker ready' : 'worker unavailable'})`;
  let isEnrolled = Boolean(enrollmentState?.enrolled);
  let lifecycleStatus = enrollmentState?.lifecycleStatus || stored.dp_device_lifecycle_status || 'ACTIVE';
  let deviceId = stored[CONFIG.DEVICE_STORAGE_KEY] || '';
  if (!deviceId) {
    const identity = await chrome.runtime.sendMessage({ action: 'get_device_id' }).catch(() => null);
    deviceId = identity?.deviceId || '';
  }
  let enrolling = false;
  function updateEnrollmentForm() {
    enrollmentPanel.hidden = !CONFIG.ENROLLMENT_UI_ENABLED || isEnrolled;
    enrollmentToken.disabled = !CONFIG.ENROLLMENT_UI_ENABLED || isEnrolled || enrolling;
    enrollBtn.disabled = !CONFIG.ENROLLMENT_UI_ENABLED || isEnrolled || enrolling;
    if (isEnrolled) enrollmentToken.value = '';
  }
  updateEnrollmentForm();

  function renderConnection(state) {
    lifecycleStatus = state.dp_device_lifecycle_status || lifecycleStatus;
    updateEnrollmentForm();
    const policy = state.dp_policy_sync;
    const policyStatus = document.getElementById('policy-status');
    if (policyStatus) policyStatus.textContent = policy?.updated
      ? `Website blocking: ${policy.count} rules installed. Reload the website to test.`
      : `Website blocking: ${policy?.reason || 'waiting for policy sync'}. Check enrollment and that the backend matches your organization dashboard.`;
    const heartbeatAge = Date.now() - Date.parse(state.dp_last_heartbeat_at || '');
    const connected = isEnrolled && state.dp_device_connection_status === 'connected' && heartbeatAge >= 0 && heartbeatAge < 120000;
    const monitoringActive = state.dp_monitoring_allowed === true && Date.now() < Date.parse(state.dp_monitoring_allowed_until || '');
    deviceStatus.textContent = lifecycleStatus === 'REVOKED' ? 'Revoked' : lifecycleStatus === 'ARCHIVED' ? 'Archived' : connected ? 'Connected' : !isEnrolled ? 'Enrollment Pending' : state.dp_last_heartbeat_at ? 'Offline' : 'Connection Pending';
    lastHeartbeatEl.textContent = state.dp_last_heartbeat_at ? new Date(state.dp_last_heartbeat_at).toLocaleString() : '—';
    lastSyncEl.textContent = state.dp_last_successful_sync_at ? new Date(state.dp_last_successful_sync_at).toLocaleString() : '—';
    if (lifecycleStatus === 'REVOKED') {
      enrollmentStatus.textContent = 'This device was revoked by an administrator. Monitoring, screenshots, and uploads are stopped. Pending events remain stored locally.';
    } else if (lifecycleStatus === 'ARCHIVED') {
      enrollmentStatus.textContent = 'This device is archived. Monitoring, screenshots, and uploads are stopped while local pending events are preserved.';
    } else if (!isEnrolled) {
      enrollmentStatus.textContent = 'Enter a one-time enrollment token created for your account. Pending events stay on this device until authorized sync is available.';
    } else if (connected && !monitoringActive) {
      enrollmentStatus.textContent = `Monitoring paused: ${monitoringReason(state.dp_monitoring_reason)} Pending events are retained.`;
    } else if (connected) {
      enrollmentStatus.textContent = 'Connected. Monitoring pauses when the authorized schedule ends.';
    } else if (state.dp_sync_error) {
      enrollmentStatus.textContent = state.dp_sync_error;
    }
  }

  enrollBtn.addEventListener('click', async () => {
    if (isEnrolled || enrolling || !CONFIG.ENROLLMENT_UI_ENABLED) return;
    const token = enrollmentToken.value.trim();
    if (!token) {
      enrollmentStatus.textContent = 'Enter the one-time token created for your account.';
      return;
    }
    enrolling = true;
    updateEnrollmentForm();
    enrollmentStatus.textContent = 'Enrolling…';
    try {
      if (!deviceId) {
        const identity = await chrome.runtime.sendMessage({ action: 'get_device_id' });
        deviceId = identity?.deviceId || '';
      }
      if (!deviceId) throw new Error('Could not initialize the browser device identity. Reopen the popup and try again.');
      if (!workerDiagnostics?.ok) throw new Error(`Background worker unavailable: ${workerDiagnostics?.error || 'reload the extension and try again.'}`);
      const result = await chrome.runtime.sendMessage({ action: 'enroll_browser', token });
      if (!result) throw new Error(`Background worker v${workerDiagnostics.workerVersion} returned no enrollment response. Reload the extension from chrome://extensions.`);
      if (!result?.success || !result.deviceId) throw new Error(result?.error || 'Enrollment failed');
      deviceId = result.deviceId;
      isEnrolled = true;
      enrollmentToken.value = '';
      enrollmentPanel.hidden = true;
      deviceIdEl.textContent = result.deviceId;
      const refreshed = await chrome.runtime.sendMessage({ action: 'refresh_status' }).catch(() => null);
      const updated = await chrome.storage.local.get(connectionKeys);
      renderConnection(updated);
      if (refreshed?.heartbeat?.ok) renderConnection(updated);
    } catch (error) {
      enrollmentStatus.textContent = error.message || 'Enrollment could not be completed.';
    } finally {
      enrolling = false;
      updateEnrollmentForm();
    }
  });

  deviceIdEl.textContent = deviceId || 'Not initialized';
  deviceIdEl.title = `${deviceId || 'Not initialized'} · extension v${workerDiagnostics?.workerVersion || 'unknown'}`;

  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab?.url) {
      const urlObj = new URL(currentTab.url);
      activeDomainEl.textContent = ['http:', 'https:'].includes(urlObj.protocol) ? urlObj.hostname : 'System / Browser Page';
    } else activeDomainEl.textContent = stored.dp_active_domain || 'None';
  } catch { activeDomainEl.textContent = stored.dp_active_domain || 'Active'; }

  const queue = stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
  queueCountEl.textContent = `${queue.length} events`;
  const renderAudit = (audit = {}) => {
    const flags = [];
    if (audit.malformed) flags.push(`${audit.malformed} malformed`);
    if (audit.wrongDevice) flags.push(`${audit.wrongDevice} different device`);
    if (audit.duplicates) flags.push(`${audit.duplicates} duplicate`);
    if (audit.conflicting) flags.push(`${audit.conflicting} conflicting IDs`);
    if (audit.rejected) flags.push(`${audit.rejected} skipped by authorization`);
    if (audit.repaired) flags.push(`${audit.repaired} timestamp-verified repair`);
    const quarantineCount = (audit.quarantined || 0) + (audit.pendingQuarantine || 0);
    if (quarantineCount) flags.push(`${quarantineCount} quarantined`);
    queueAuditEl.textContent = flags.length ? flags.join(' · ') : `${audit.eligible ?? queue.length} ready; no local issues found`;
    retrySkippedBtn.hidden = !audit.rejected;
    exportQuarantineBtn.hidden = !quarantineCount;
  };
  renderAudit((await chrome.runtime.sendMessage({ action: 'audit_queue' }).catch(() => null)) || {});
  let backendUrl;
  try { backendUrl = normalizeBackendUrl(CONFIG.DEFAULT_BACKEND_URL); }
  catch (error) { backendUrl = ''; enrollmentStatus.textContent = error.message; }
  document.getElementById('backend-url').textContent = backendUrl;
  renderConnection(stored);

  async function checkBackend() {
  try {
    if (!backendUrl) throw new Error('Backend URL is invalid.');
    const response = await fetch(`${backendUrl}/api/v1/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    const result = await response.json();
    statusBadge.textContent = response.ok && result.status === 'ok' ? 'Online' : 'Degraded';
    statusBadge.className = response.ok && result.status === 'ok' ? 'badge online' : 'badge offline';
  } catch {
    statusBadge.textContent = 'Offline';
    statusBadge.className = 'badge offline';
  }
  }
  await checkBackend();

  const refresh = await chrome.runtime.sendMessage({ action: 'refresh_status' }).catch(() => null);
  const current = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY, ...connectionKeys]);
  renderConnection(current);
  queueCountEl.textContent = `${(current[CONFIG.SYNC_QUEUE_STORAGE_KEY] || []).length} events`;
  if (refresh?.heartbeat?.ok) renderConnection(current);

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
    if (!isEnrolled) {
      enrollmentStatus.textContent = 'Enroll this device with a one-time token before requesting a sync.';
    } else {
      try {
        const result = await chrome.runtime.sendMessage({ action: 'sync_now' });
        if (!result?.success) {
          enrollmentStatus.textContent = result?.sync?.error || (result?.sync?.monitoringPaused ? `Monitoring is paused: ${monitoringReason(result.sync.reason)} Pending events are retained.` : '') || result?.heartbeat?.error || 'Sync could not be confirmed.';
        } else enrollmentStatus.textContent = 'Sync completed and device heartbeat confirmed.';
      } catch (error) {
        enrollmentStatus.textContent = error.message || 'Could not contact the background worker.';
      }
    }
    const updated = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY, ...connectionKeys]);
    queueCountEl.textContent = `${(updated[CONFIG.SYNC_QUEUE_STORAGE_KEY] || []).length} events`;
    renderAudit((await chrome.runtime.sendMessage({ action: 'audit_queue' }).catch(() => null)) || {});
    renderConnection(updated);
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  });

  retrySkippedBtn.addEventListener('click', async () => {
    retrySkippedBtn.disabled = true;
    await chrome.runtime.sendMessage({ action: 'retry_skipped_events' }).catch(() => {});
    const result = await chrome.runtime.sendMessage({ action: 'sync_now' }).catch(() => null);
    if (result?.sync?.error) enrollmentStatus.textContent = result.sync.error;
    renderAudit((await chrome.runtime.sendMessage({ action: 'audit_queue' }).catch(() => null)) || {});
    const latest = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY, ...connectionKeys]);
    queueCountEl.textContent = `${(latest[CONFIG.SYNC_QUEUE_STORAGE_KEY] || []).length} events`;
    renderConnection(latest);
    retrySkippedBtn.disabled = false;
  });

  exportQuarantineBtn.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ action: 'export_activity_quarantine' }).catch(() => ({ records: [] }));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: result?.records || [] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `digitalpulse-activity-quarantine-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
});

function monitoringReason(reason) {
  return ({
    USER_CONSENT_REQUIRED: 'your consent has not been recorded.',
    ADMIN_AUTHORIZATION_REQUIRED: 'administrator authorization is missing.',
    ORGANIZATION_TIMEZONE_REQUIRED: 'the organization time zone is not configured.',
    SCHEDULE_NOT_CONFIGURED: 'your work schedule is not configured.',
    OUTSIDE_SCHEDULE: 'it is outside your scheduled work hours.',
    ACCOUNT_INACTIVE: 'the account is inactive.',
    DEVICE_NOT_ENROLLED: 'the device has not been enrolled.',
  }[reason] || 'the server could not verify authorization.');
}
