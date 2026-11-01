import { CONFIG } from '../shared/constants.js';
import { TabManager } from './tab-manager.js';
import { ActivityManager } from './activity-manager.js';

// Detect browser environment
const isEdge = navigator.userAgent.includes('Edg/');
const browserName = isEdge ? 'edge' : 'chrome';

async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get([CONFIG.DEVICE_STORAGE_KEY]);
  if (stored[CONFIG.DEVICE_STORAGE_KEY]) {
    return stored[CONFIG.DEVICE_STORAGE_KEY];
  }
  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ [CONFIG.DEVICE_STORAGE_KEY]: newId });
  return newId;
}

async function enqueueEvent(event) {
  const stored = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY]);
  const queue = stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
  queue.push(event);
  await chrome.storage.local.set({ [CONFIG.SYNC_QUEUE_STORAGE_KEY]: queue });
}

async function syncQueue() {
  const stored = await chrome.storage.local.get([
    CONFIG.SYNC_QUEUE_STORAGE_KEY,
    CONFIG.DEVICE_STORAGE_KEY,
    CONFIG.SETTINGS_STORAGE_KEY,
  ]);

  const queue = stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
  if (queue.length === 0) return;

  const deviceId = stored[CONFIG.DEVICE_STORAGE_KEY];
  const backendUrl = stored[CONFIG.SETTINGS_STORAGE_KEY]?.backendUrl || CONFIG.DEFAULT_BACKEND_URL;

  const batch = {
    device: {
      id: deviceId,
      kind: 'browser_extension',
      name: `${browserName.toUpperCase()} Extension`,
      platform: 'windows',
      browser: browserName,
      agentVersion: '0.1.0',
    },
    events: queue.slice(0, 50),
  };

  try {
    const res = await fetch(`${backendUrl}/api/v1/activity/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });

    if (res.ok) {
      const remaining = queue.slice(batch.events.length);
      await chrome.storage.local.set({ [CONFIG.SYNC_QUEUE_STORAGE_KEY]: remaining });
    }
  } catch (err) {
    // Keep in queue for next sync interval
    console.debug('[DigitalPulse] Sync deferred:', err.message);
  }
}

// Initialization
(async () => {
  const deviceId = await getOrCreateDeviceId();

  const activityManager = new ActivityManager({
    deviceId,
    browser: browserName,
    onSessionCompleted: async (event) => {
      await enqueueEvent(event);
    },
  });

  const tabManager = new TabManager({
    onActiveDomainChanged: async (domain) => {
      await activityManager.switchDomain(domain);
    },
  });

  // Event Listeners
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      tabManager.handleTabActivated(tab);
    } catch {
      // Tab may have closed immediately
    }
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.url) {
      tabManager.handleUrlChanged(changeInfo.url);
    }
  });

  chrome.windows.onFocusChanged.addListener(async (windowId) => {
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

  // Periodic sync
  chrome.alarms.create('dp_sync', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'dp_sync') {
      syncQueue();
    }
  });
})();

