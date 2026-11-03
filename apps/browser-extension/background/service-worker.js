import { CONFIG } from '../shared/constants.js';
import { TabManager } from './tab-manager.js';
import { ActivityManager } from './activity-manager.js';
import { syncBlockingRules } from './policy-sync.js';
import { createSyncClient } from './sync-client.js';

// Detect browser environment
const isEdge = navigator.userAgent.includes('Edg/');
const browserName = isEdge ? 'edge' : 'chrome';
const { enrollBrowserDevice, sendHeartbeat, syncQueue, auditQueueState } = createSyncClient({ chromeApi: chrome, fetchImpl: fetch, config: CONFIG, browserName });
const ENROLLMENT_DEFERRED_MESSAGE = 'Device enrollment is not configured yet. Please contact your administrator.';
let applyMonitoringState = async () => {};

async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get([CONFIG.DEVICE_STORAGE_KEY]);
  if (stored[CONFIG.DEVICE_STORAGE_KEY]) {
    return stored[CONFIG.DEVICE_STORAGE_KEY];
  }
  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ [CONFIG.DEVICE_STORAGE_KEY]: newId });
  return newId;
}

// Share one initialization promise with the popup so enrollment and tracked
// events can never race to create different browser device identities.
const secureStorageReady = chrome.storage.local.setAccessLevel
  ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  : Promise.resolve();
const deviceIdPromise = secureStorageReady.then(getOrCreateDeviceId);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'get_enrollment_state') {
    chrome.storage.local.get(['dp_device_secret']).then((stored) => {
      sendResponse({ enrolled: Boolean(stored.dp_device_secret) });
    });
    return true;
  }
  if (message.action === 'get_device_id') {
    deviceIdPromise.then((deviceId) => sendResponse({ deviceId }));
    return true;
  }
  if (message.action === 'get_monitoring_state') {
    chrome.storage.local.get(['dp_monitoring_allowed', 'dp_monitoring_allowed_until', 'dp_monitoring_reason']).then((stored) => {
      sendResponse({ allowed: stored.dp_monitoring_allowed === true && Date.now() < Date.parse(stored.dp_monitoring_allowed_until || ''), reason: stored.dp_monitoring_reason || null });
    });
    return true;
  }
  if (message.action === 'audit_queue') {
    auditQueueState().then(sendResponse).catch(() => sendResponse({ total: 0, malformed: 0, duplicates: 0 }));
    return true;
  }
  if (message.action === 'retry_skipped_events') {
    chrome.storage.local.set({ dp_rejected_event_ids: [] }).then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'enroll_browser') {
    if (!CONFIG.ENROLLMENT_UI_ENABLED) {
      sendResponse({ success: false, deferred: true, error: ENROLLMENT_DEFERRED_MESSAGE });
      return false;
    }
    deviceIdPromise
      .then((deviceId) => enrollBrowserDevice(message.token, deviceId))
      .then(async (result) => {
        if (result?.success) {
          const heartbeat = await sendHeartbeat();
          await applyMonitoringState(heartbeat.monitoring || {});
        }
        return result;
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message || 'Browser extension enrollment failed.' }));
    return true;
  }
});

async function enqueueEvent(event) {
  const stored = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY]);
  const queue = stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
  queue.push(event);
  await chrome.storage.local.set({ [CONFIG.SYNC_QUEUE_STORAGE_KEY]: queue });
}

// Initialization
(async () => {
  const deviceId = await deviceIdPromise;

  const activityManager = new ActivityManager({
    deviceId,
    browser: browserName,
    onSessionCompleted: async (event) => {
      await enqueueEvent(event);
    },
  });
  applyMonitoringState = async (monitoring) => {
    await activityManager.setMonitoringState(monitoring);
    if (!activityManager.monitoringAllowed) {
      await chrome.storage.local.remove('dp_active_domain');
    }
  };
  const initialHeartbeat = await sendHeartbeat();
  await applyMonitoringState(initialHeartbeat.monitoring || {});

  const tabManager = new TabManager({
    onActiveDomainChanged: async (domain) => {
      try {
        if (activityManager.monitoringAllowed) {
          await chrome.storage.local.set({ dp_active_domain: domain });
        } else {
          await chrome.storage.local.remove('dp_active_domain');
        }
      } catch {
        // Safe storage write
      }
      await activityManager.switchDomain(domain);
    },
  });

  // Query and track the active tab immediately on service worker startup
  const refreshAuthorizedActiveTab = async () => {
    if (!activityManager.monitoringAllowed) return;
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (currentTab?.url) tabManager.handleTabActivated(currentTab);
    } catch {
      // The active tab may be unavailable while the browser is starting.
    }
  };
  await refreshAuthorizedActiveTab();

  // Handle manual sync requests from the popup UI
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'sync_now') {
      (async () => {
        const heartbeat = await sendHeartbeat();
        await applyMonitoringState(heartbeat.monitoring || {});
        await refreshAuthorizedActiveTab();
        if (activityManager.activeSession) {
          const nowMs = Date.now();
          const currentDomain = activityManager.activeSession.domain;
          await activityManager._closeSession(nowMs);
          if (currentDomain) {
            activityManager.activeSession = {
              domain: currentDomain,
              startedAt: nowMs,
            };
          }
        }
        const sync = await syncQueue();
        await syncBlockingRules();
        sendResponse({ success: Boolean(heartbeat.ok && sync.ok), heartbeat, sync });
      })();
      return true;
    }
    if (message.action === 'refresh_status') {
      sendHeartbeat().then(async (heartbeat) => {
        await applyMonitoringState(heartbeat.monitoring || {});
        await refreshAuthorizedActiveTab();
        sendResponse({ heartbeat });
      });
      return true;
    }
  });

  // Event Listeners
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!activityManager.monitoringAllowed) return;
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      tabManager.handleTabActivated(tab);
    } catch {
      // Tab may have closed immediately
    }
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (activityManager.monitoringAllowed && tab.active && changeInfo.url) {
      tabManager.handleUrlChanged(changeInfo.url);
    }
  });

  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (!activityManager.monitoringAllowed) return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      tabManager.handleWindowFocusChanged(false);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      tabManager.handleWindowFocusChanged(true, tab?.url);
    }
  });

  chrome.idle.setDetectionInterval(CONFIG.IDLE_THRESHOLD_SECS);
  chrome.idle.onStateChanged.addListener((state) => {
    activityManager.handleIdleState(state);
  });

  // Periodic sync: checkpoints active session every 30s and flushes queue
  const performPeriodicSync = async () => {
    try {
      const heartbeat = await sendHeartbeat();
      await applyMonitoringState(heartbeat.monitoring || {});
      await refreshAuthorizedActiveTab();
      await activityManager.checkpoint();
      await syncQueue();
      await syncBlockingRules();
    } catch (err) {
      console.debug('[DigitalPulse] Periodic sync error:', err.message);
    }
  };

  if (chrome.alarms?.create) {
    chrome.alarms.create('dp_sync', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === 'dp_sync') {
        await performPeriodicSync();
      }
    });
  } else {
    setInterval(performPeriodicSync, 30000);
  }
  void performPeriodicSync();
})();
