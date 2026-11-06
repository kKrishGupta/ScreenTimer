import { CONFIG } from '../shared/constants.js';
import { TabManager } from './tab-manager.js';
import { ActivityManager } from './activity-manager.js';
import { syncBlockingRulesWithStatus as syncBlockingRules } from './policy-sync.js';
import { createSyncClient } from './sync-client.js';

const isEdge = navigator.userAgent.includes('Edg/');
const browserName = isEdge ? 'edge' : 'chrome';
const { enrollBrowserDevice, sendHeartbeat, syncQueue, auditQueueState } = createSyncClient({ chromeApi: chrome, fetchImpl: fetch, config: CONFIG, browserName });
const ENROLLMENT_DEFERRED_MESSAGE = 'Device enrollment is not configured yet. Please contact your administrator.';
const MAX_QUEUE_EVENTS = 1000;
let applyMonitoringState = async () => {};

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
    await activityManager.setMonitoringState(monitoring);
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
      const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (currentTab?.url) tabManager.handleTabActivated(currentTab);
      return currentTab?.url || null;
    } catch { return null; }
  };
  const performPeriodicSync = async () => {
    // Policy enforcement must not depend on activity upload or work hours.
    await syncBlockingRules();
    try {
      const heartbeat = await sendHeartbeat();
      await applyMonitoringState(heartbeat.monitoring || {});
      await refreshAuthorizedActiveTab();
      await activityManager.checkpoint();
      await syncQueue();
    } catch (error) { console.debug('[DigitalPulse] Periodic sync error:', error.message); }
  };
  await refreshAuthorizedActiveTab();
  void performPeriodicSync();
  return { activityManager, tabManager, refreshAuthorizedActiveTab, performPeriodicSync };
}

// Chrome requires event listeners to be registered as the worker evaluates.
const runtime = initializeWorker();
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'get_enrollment_state') { chrome.storage.local.get(['dp_device_secret']).then((stored) => sendResponse({ enrolled: Boolean(stored.dp_device_secret) })); return true; }
  if (message.action === 'get_device_id') { deviceIdPromise.then((deviceId) => sendResponse({ deviceId })); return true; }
  if (message.action === 'get_worker_diagnostics') {
    Promise.all([
      deviceIdPromise,
      chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY, 'dp_device_secret', 'dp_sync_error', 'dp_worker_warning']),
    ]).then(([deviceId, stored]) => sendResponse({
      ok: true,
      workerVersion: chrome.runtime.getManifest().version,
      deviceId,
      enrolled: Boolean(stored.dp_device_secret),
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
    runtime.then(async ({ activityManager, refreshAuthorizedActiveTab }) => { const policy = await syncBlockingRules(); const heartbeat = await sendHeartbeat(); await applyMonitoringState(heartbeat.monitoring || {}); await refreshAuthorizedActiveTab(); await activityManager.checkpoint(); const sync = await syncQueue(); sendResponse({ success: Boolean(heartbeat.ok && sync.ok && policy.updated), heartbeat, sync, policy }); }).catch((error) => sendResponse({ success: false, error: error.message })); return true;
  }
  if (message.action === 'refresh_status') {
    runtime.then(async ({ refreshAuthorizedActiveTab }) => { const heartbeat = await sendHeartbeat(); await applyMonitoringState(heartbeat.monitoring || {}); await refreshAuthorizedActiveTab(); sendResponse({ heartbeat }); }).catch((error) => sendResponse({ error: error.message })); return true;
  }
  return false;
});

chrome.tabs.onActivated.addListener((activeInfo) => { runtime.then(async ({ activityManager, tabManager }) => { if (!activityManager.monitoringAllowed) return; try { tabManager.handleTabActivated(await chrome.tabs.get(activeInfo.tabId)); } catch { /* tab closed */ } }); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => { runtime.then(({ activityManager, tabManager }) => { if (activityManager.monitoringAllowed && tab.active && changeInfo.url) tabManager.handleUrlChanged(changeInfo.url); }); });
chrome.windows.onFocusChanged.addListener((windowId) => { runtime.then(async ({ activityManager, tabManager }) => { if (!activityManager.monitoringAllowed) return; if (windowId === chrome.windows.WINDOW_ID_NONE) tabManager.handleWindowFocusChanged(false); else { const [tab] = await chrome.tabs.query({ active: true, windowId }); tabManager.handleWindowFocusChanged(true, tab?.url); } }); });
chrome.idle.setDetectionInterval(CONFIG.IDLE_THRESHOLD_SECS);
chrome.idle.onStateChanged.addListener((state) => { runtime.then(async ({ activityManager, refreshAuthorizedActiveTab }) => { if (state === 'active') await refreshAuthorizedActiveTab(); const stored = await chrome.storage.local.get(['dp_active_domain']); await activityManager.handleIdleState(state, Date.now(), state === 'active' ? stored.dp_active_domain : null); }); });
if (chrome.alarms?.create) {
  chrome.alarms.create('dp_sync', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'dp_sync') runtime.then(({ performPeriodicSync }) => performPeriodicSync()); });
}
