import { CONFIG } from '../shared/constants.js';
import { recordBlockedAttempt, flushBlockedAttempts } from './blocked-attempts.js';
import { TabManager, reconcileActiveTab } from './tab-manager.js';
import { ActivityManager } from './activity-manager.js';
import {
  syncBlockingRulesWithStatus as syncBlockingRules,
  enforceBlockedTabs,
  markTabBlockedByDnr,
  handleBlockedNavigationCompleted,
  clearBlockedTabEnforcementState,
} from './policy-sync.js';
import { createSyncClient } from './sync-client.js';
import { createScreenshotCapture } from './screenshot-capture.js';
import { ensureSyncAlarm, singleFlight, serializeTasks, SYNC_ALARM_NAME } from './sync-scheduler.js';

const isEdge = navigator.userAgent.includes('Edg/');
const browserName = isEdge ? 'edge' : 'chrome';
const { enrollBrowserDevice, sendHeartbeat, syncQueue, auditQueueState } = createSyncClient({ chromeApi: chrome, fetchImpl: fetch, config: CONFIG, browserName });
const { captureAuthorizedActiveTab, stop: stopScreenshotCapture, handleHeartbeatMonitoring } = createScreenshotCapture({ chromeApi: chrome, fetchImpl: fetch, config: CONFIG, browserName });
const ENROLLMENT_DEFERRED_MESSAGE = 'Device enrollment is not configured yet. Please contact your administrator.';
const MAX_QUEUE_EVENTS = 1000;
let applyMonitoringState = async () => {};
const serializeRuntime = serializeTasks();

async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get([CONFIG.DEVICE_STORAGE_KEY]);
  if (stored[CONFIG.DEVICE_STORAGE_KEY]) return stored[CONFIG.DEVICE_STORAGE_KEY];
  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ [CONFIG.DEVICE_STORAGE_KEY]: newId });
  return newId;
}

const secureStorageReady = chrome.storage.local.setAccessLevel
  ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(async (error) => {
      // Storage access hardening is unavailable in some Chromium versions. It
      // must not prevent the worker from creating an ID or enrolling a device.
      await chrome.storage.local.set({ dp_worker_warning: `Storage hardening unavailable: ${error.message || error}` });
    })
  : Promise.resolve();
const deviceIdPromise = secureStorageReady.then(getOrCreateDeviceId);

async function enqueueEvent(event) {
  const stored = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY]);
  const queue = stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
  if (queue.length >= MAX_QUEUE_EVENTS) {
    await chrome.storage.local.set({ dp_sync_error: 'Local activity queue is full. Monitoring is paused until synchronization succeeds.' });
    return false;
  }
  queue.push(event);
  await chrome.storage.local.set({ [CONFIG.SYNC_QUEUE_STORAGE_KEY]: queue, dp_sync_error: null });
  return true;
}

async function initializeWorker() {
  const deviceId = await deviceIdPromise;
  const stored = await chrome.storage.local.get([CONFIG.ACTIVE_SESSION_STORAGE_KEY]);
  const activityManager = new ActivityManager({
    deviceId, browser: browserName, initialSession: stored[CONFIG.ACTIVE_SESSION_STORAGE_KEY],
    onSessionCompleted: enqueueEvent,
    onSessionChanged: (session) => chrome.storage.local.set({ [CONFIG.ACTIVE_SESSION_STORAGE_KEY]: session }),
  });
  applyMonitoringState = async (monitoring) => {
    // Heartbeat authorizes domain activity, not screenshots. Only the screenshot
    // policy controller may establish the screenshot ON badge.
    const allowed = await handleHeartbeatMonitoring(monitoring);
    await activityManager.setMonitoringState({ ...monitoring, allowed });
    if (!activityManager.monitoringAllowed) await chrome.storage.local.remove('dp_active_domain');
  };
  const initialHeartbeat = await sendHeartbeat();
  await applyMonitoringState(initialHeartbeat.monitoring || {});
  if (activityManager.activeSession) await activityManager.restoreSession(activityManager.activeSession);

  const tabManager = new TabManager({
    onActiveDomainChanged: async (domain) => {
      try {
        if (activityManager.monitoringAllowed) await chrome.storage.local.set({ dp_active_domain: domain });
        else await chrome.storage.local.remove('dp_active_domain');
      } catch { /* storage is best effort */ }
      await activityManager.switchDomain(domain);
    },
  });
  const refreshAuthorizedActiveTab = async () => {
    if (!activityManager.monitoringAllowed) return null;
    try {
      return await reconcileActiveTab(chrome, activityManager, tabManager, CONFIG.IDLE_THRESHOLD_SECS);
    } catch (error) {
      await stopScreenshotCapture('SYNC_FAILED');
      await activityManager.switchDomain(null);
      console.debug('[DigitalPulse] Active tab unavailable:', error.message);
      return null;
    }
  };
  const performPeriodicSync = async () => {
    await flushBlockedAttempts().catch((error) => console.debug('[DigitalPulse] Blocked attempt sync:', error.message));
    // Policy enforcement must not depend on activity upload or work hours.
    const policy = await syncBlockingRules();
    try {
      const heartbeat = await sendHeartbeat();
      await applyMonitoringState(heartbeat.monitoring || {});
      await refreshAuthorizedActiveTab();
      const screenshot = await captureAuthorizedActiveTab();
      await activityManager.checkpoint();
      const sync = await syncQueue();
      return { policy, heartbeat, screenshot, sync };
    } catch (error) {
      console.debug('[DigitalPulse] Periodic sync error:', error.message);
      await stopScreenshotCapture('SYNC_FAILED');
      return { policy, heartbeat: { ok: false }, sync: { ok: false }, error: error.message || String(error) };
    }
  };
  await refreshAuthorizedActiveTab();
  return { activityManager, tabManager, refreshAuthorizedActiveTab, performPeriodicSync };
}

// Chrome requires event listeners to be registered as the worker evaluates.
const workerRuntime = initializeWorker();
const withRuntime = (task) => serializeRuntime(async () => task(await workerRuntime));
const runSync = singleFlight(async (source) => {
  const result = await withRuntime(({ performPeriodicSync }) => performPeriodicSync());
  await chrome.storage.local.set({
    dp_automatic_sync: {
      source,
      ok: Boolean(result.heartbeat?.ok && result.sync?.ok),
      checkedAt: new Date().toISOString(),
      error: result.error || result.sync?.error || result.heartbeat?.error || null,
    },
  });
  return result;
});

const ensurePeriodicSyncAlarm = singleFlight(async () => {
  try {
    return await ensureSyncAlarm(chrome, CONFIG.DEFAULT_SYNC_INTERVAL_SECS);
  } catch (error) {
    await chrome.storage.local.set({ dp_worker_warning: `Automatic sync scheduling failed: ${error.message || error}` });
    return null;
  }
});

function runSyncSafely(source) {
  return runSync(source).catch(async (error) => {
    await stopScreenshotCapture('SYNC_FAILED');
    console.debug('[DigitalPulse] Automatic sync error:', error.message || error);
    await chrome.storage.local.set({
      dp_automatic_sync: {
        source,
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error.message || String(error),
      },
    });
    return null;
  });
}

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  void markTabBlockedByDnr(chrome, details).catch((error) => console.debug('[DigitalPulse] Blocked state update:', error.message));
  recordBlockedAttempt(details).then(() => flushBlockedAttempts()).catch((error) => console.debug('[DigitalPulse] Blocked attempt:', error.message));
});
chrome.webNavigation?.onCompleted?.addListener((details) => {
  void handleBlockedNavigationCompleted(chrome, details).catch((error) => console.debug('[DigitalPulse] Blocked navigation check:', error.message));
});
chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  void handleBlockedNavigationCompleted(chrome, details).catch((error) => console.debug('[DigitalPulse] Blocked history navigation check:', error.message));
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'get_enrollment_state') { chrome.storage.local.get(['dp_device_secret', 'dp_device_lifecycle_status']).then((stored) => sendResponse({ enrolled: Boolean(stored.dp_device_secret), lifecycleStatus: stored.dp_device_lifecycle_status || 'ACTIVE' })); return true; }
  if (message.action === 'get_device_id') { deviceIdPromise.then((deviceId) => sendResponse({ deviceId })); return true; }
  if (message.action === 'get_worker_diagnostics') {
    Promise.all([
      deviceIdPromise,
      chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY, 'dp_device_secret', 'dp_device_lifecycle_status', 'dp_sync_error', 'dp_worker_warning']),
    ]).then(([deviceId, stored]) => sendResponse({
      ok: true,
      workerVersion: chrome.runtime.getManifest().version,
      deviceId,
      enrolled: Boolean(stored.dp_device_secret),
      lifecycleStatus: stored.dp_device_lifecycle_status || 'ACTIVE',
      queued: (stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || []).length,
      syncError: stored.dp_sync_error || null,
      warning: stored.dp_worker_warning || null,
    })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message.action === 'get_monitoring_state') {
    chrome.storage.local.get(['dp_monitoring_allowed', 'dp_monitoring_allowed_until', 'dp_monitoring_reason']).then((stored) => sendResponse({ allowed: stored.dp_monitoring_allowed === true && Date.now() < Date.parse(stored.dp_monitoring_allowed_until || ''), reason: stored.dp_monitoring_reason || null })); return true;
  }
  if (message.action === 'audit_queue') { auditQueueState().then(sendResponse).catch(() => sendResponse({ total: 0, malformed: 0, duplicates: 0 })); return true; }
  if (message.action === 'retry_skipped_events') { chrome.storage.local.set({ dp_rejected_event_ids: [] }).then(() => sendResponse({ success: true })); return true; }
  if (message.action === 'enroll_browser') {
    if (!CONFIG.ENROLLMENT_UI_ENABLED) { sendResponse({ success: false, deferred: true, error: ENROLLMENT_DEFERRED_MESSAGE }); return false; }
    deviceIdPromise.then((deviceId) => enrollBrowserDevice(message.token, deviceId)).then(async (result) => { if (result?.success) { await syncBlockingRules(); const heartbeat = await sendHeartbeat(); await applyMonitoringState(heartbeat.monitoring || {}); } return result; }).then(sendResponse).catch(async (error) => {
      const message = error.message || 'Browser extension enrollment failed.';
      await chrome.storage.local.set({ dp_sync_error: message });
      sendResponse({ success: false, error: message, workerVersion: chrome.runtime.getManifest().version });
    }); return true;
  }
  if (message.action === 'sync_now') {
    runSync('popup').then(({ heartbeat, sync, policy }) => sendResponse({ success: Boolean(heartbeat.ok && sync.ok && policy.updated), heartbeat, sync, policy })).catch((error) => sendResponse({ success: false, error: error.message })); return true;
  }
  if (message.action === 'refresh_status') {
    withRuntime(async ({ refreshAuthorizedActiveTab }) => { const heartbeat = await sendHeartbeat(); await applyMonitoringState(heartbeat.monitoring || {}); await refreshAuthorizedActiveTab(); sendResponse({ heartbeat }); }).catch((error) => sendResponse({ error: error.message })); return true;
  }
  return false;
});

function handleBrowserTransition() {
  void withRuntime(({ refreshAuthorizedActiveTab }) => refreshAuthorizedActiveTab())
    .catch((error) => console.debug('[DigitalPulse] Tab transition failed:', error.message));
}
chrome.tabs.onActivated.addListener(handleBrowserTransition);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    void enforceBlockedTabs(chrome).catch((error) => console.debug('[DigitalPulse] Tab policy enforcement:', error.message));
  }
  if (tab.active && changeInfo.url) handleBrowserTransition();
});
chrome.windows.onFocusChanged.addListener(handleBrowserTransition);
chrome.idle.setDetectionInterval(CONFIG.IDLE_THRESHOLD_SECS);
chrome.idle.onStateChanged.addListener(handleBrowserTransition);
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === SYNC_ALARM_NAME) void runSyncSafely('alarm'); });
}
chrome.runtime.onInstalled?.addListener(() => {
  void ensurePeriodicSyncAlarm();
  void clearBlockedTabEnforcementState(chrome).finally(() => runSyncSafely('installed'));
});
chrome.runtime.onStartup?.addListener(() => {
  void ensurePeriodicSyncAlarm();
  void clearBlockedTabEnforcementState(chrome).finally(() => runSyncSafely('browser-startup'));
});

// Alarms may be cleared by a browser restart. Check without replacing an
// existing alarm, then synchronize once whenever the worker is loaded.
void ensurePeriodicSyncAlarm();
void runSyncSafely('worker-start');
