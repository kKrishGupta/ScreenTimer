import { CONFIG } from '../shared/constants.js';

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('status-badge');
  const deviceIdEl = document.getElementById('device-id');
  const queueCountEl = document.getElementById('queue-count');
  const syncBtn = document.getElementById('sync-btn');

  // Load state
  const stored = await chrome.storage.local.get([
    CONFIG.DEVICE_STORAGE_KEY,
    CONFIG.SYNC_QUEUE_STORAGE_KEY,
    CONFIG.SETTINGS_STORAGE_KEY,
  ]);

  const deviceId = stored[CONFIG.DEVICE_STORAGE_KEY] || 'Not initialized';
  deviceIdEl.textContent = deviceId;
  deviceIdEl.title = deviceId;

  const queue = stored[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
  queueCountEl.textContent = `${queue.length} events`;

  const backendUrl = stored[CONFIG.SETTINGS_STORAGE_KEY]?.backendUrl || CONFIG.DEFAULT_BACKEND_URL;

  // Test backend connectivity
  try {
    const res = await fetch(`${backendUrl}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      statusBadge.textContent = 'Connected';
      statusBadge.className = 'badge online';
    } else {
      statusBadge.textContent = 'Degraded';
      statusBadge.className = 'badge offline';
    }
  } catch {
    statusBadge.textContent = 'Offline';
    statusBadge.className = 'badge offline';
  }

  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
    try {
      // Trigger background alarm to sync immediately
      await chrome.runtime.sendMessage({ action: 'sync_now' });
    } catch {
      // ignore
    }
    setTimeout(async () => {
      const updated = await chrome.storage.local.get([CONFIG.SYNC_QUEUE_STORAGE_KEY]);
      const updatedQueue = updated[CONFIG.SYNC_QUEUE_STORAGE_KEY] || [];
      queueCountEl.textContent = `${updatedQueue.length} events`;
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
    }, 600);
  });
});

