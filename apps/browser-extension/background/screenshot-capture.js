import { resolveBackendUrl } from '../shared/backend-settings.js';
import { hasCapturePermission } from '../shared/capture-permissions.js';

export const CAPTURE_EXPIRY_ALARM = 'dp_screen_authorization_expiry';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CAPTURE_FORMAT = 'jpeg';
const CAPTURE_QUALITY = 75;

function futureTime(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function safeCode(value, fallback = 'SCREEN_CAPTURE_FAILED') {
  const code = String(value || fallback).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
  return code || fallback;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png));base64,([a-z0-9+/=]+)$/i.exec(dataUrl || '');
  if (!match) throw new Error('Capture API returned an unsupported image payload.');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length < 32 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Capture image size is invalid.');
  return { bytes, mimeType: match[1].toLowerCase() };
}

function imageDimensions(bytes, mimeType) {
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || !bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) throw new Error('Capture image signature is invalid.');
    return { width: new DataView(bytes.buffer, bytes.byteOffset).getUint32(16), height: new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Capture image signature is invalid.');
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset++] !== 0xff) throw new Error('Capture JPEG structure is invalid.');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker) && length >= 7) {
      return { width: (bytes[offset + 5] << 8) | bytes[offset + 6], height: (bytes[offset + 3] << 8) | bytes[offset + 4] };
    }
    offset += length;
  }
  throw new Error('Capture JPEG dimensions are unavailable.');
}

function captureKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '');
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export async function setMonitoringIndicator(chromeApi, active, reason = '') {
  if (!chromeApi?.action?.setBadgeText || !chromeApi?.action?.setBadgeBackgroundColor) return false;
  try {
    await chromeApi.action.setBadgeText({ text: active ? 'ON' : '' });
    if (active) {
      await chromeApi.action.setBadgeBackgroundColor({ color: '#16a34a' });
      await chromeApi.action.setTitle?.({ title: 'DigitalPulse: browser screenshot monitoring is active' });
    } else {
      await chromeApi.action.setBadgeBackgroundColor({ color: '#64748b' });
      await chromeApi.action.setTitle?.({ title: `DigitalPulse: monitoring paused${reason ? ` (${reason})` : ''}` });
    }
    await chromeApi.storage.local.set({ dp_monitoring_indicator_active: active === true });
    return true;
  } catch {
    try { await chromeApi.action.setBadgeText({ text: '' }); } catch { /* Fail closed below. */ }
    try { await chromeApi.storage.local.set({ dp_monitoring_indicator_active: false }); } catch { /* Never authorize on storage failure. */ }
    return false;
  }
}

async function readDeviceState(chromeApi, config) {
  const stored = await chromeApi.storage.local.get([
    config.DEVICE_STORAGE_KEY,
    config.SETTINGS_STORAGE_KEY,
    'dp_device_secret',
    'dp_last_screen_capture_at',
  ]);
  if (!stored[config.DEVICE_STORAGE_KEY] || !stored.dp_device_secret) throw new Error('DEVICE_NOT_ENROLLED');
  return stored;
}

async function fetchPolicy({ chromeApi, fetchImpl, config, stored }) {
  const backendUrl = resolveBackendUrl(stored, config);
  const deviceId = stored[config.DEVICE_STORAGE_KEY];
  const response = await fetchImpl(`${backendUrl}/api/v1/screen-monitoring/device-policy?deviceId=${encodeURIComponent(deviceId)}`, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { 'X-Device-Secret': stored.dp_device_secret },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.policy) throw new Error(result.error?.code || `SCREEN_POLICY_UNAVAILABLE_${response.status}`);
  const policy = result.policy;
  if (policy.allowed !== true || policy.visibleIndicator !== true || !futureTime(policy.allowedUntil)) {
    throw new Error(policy.reason || 'MONITORING_NOT_AUTHORIZED');
  }
  return { ...policy, backendUrl, deviceId };
}

async function activeVisibleTab(chromeApi) {
  const focusedWindow = await chromeApi.windows.getLastFocused();
  if (!focusedWindow?.focused || ['minimized', 'fullscreen'].includes(focusedWindow.state) || focusedWindow.type !== 'normal' || focusedWindow.incognito) throw new Error('BROWSER_WINDOW_NOT_VISIBLE');
  if (chromeApi.idle?.queryState && await chromeApi.idle.queryState(60) !== 'active') throw new Error('BROWSER_WINDOW_NOT_ACTIVE');
  const tabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id || tab.incognito || tab.active !== true || tab.windowId !== focusedWindow.id || tab.discarded || tab.hidden || tab.pendingUrl) throw new Error('ACTIVE_TAB_NOT_ELIGIBLE');
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('ACTIVE_TAB_NOT_ELIGIBLE');
  return tab;
}

function intervalElapsed(lastCaptureAt, intervalSeconds) {
  const timestamp = Date.parse(lastCaptureAt || '');
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= Number(intervalSeconds || 300) * 1000;
}

export function createScreenshotCapture({ chromeApi, fetchImpl, config, browserName }) {
  let inFlight = null;
  let generation = 0;
  let expiryTimer;
  let authorizationDeadline = 0;
  let expiryVersion = 0;
  let uploadController;
  let activeAttempt = null;
  let lastInvalidation = { event: 'WORKER_START', generation: 0, at: new Date().toISOString() };
  const indicatorQueue = (task) => {
    indicatorWork = indicatorWork.catch(() => {}).then(task);
    return indicatorWork;
  };
  let indicatorWork = Promise.resolve();

  function diagnostic(stage, extra = {}) {
    const record = {
      attemptId: activeAttempt?.id || null,
      currentGeneration: generation,
      captureGeneration: activeAttempt?.generation ?? null,
      allowedUntil: activeAttempt?.allowedUntil || null,
      invalidationEvent: activeAttempt && activeAttempt.generation === generation ? null : lastInvalidation.event,
      stage,
      at: new Date().toISOString(),
      ...extra,
    };
    // Deliberately excludes URLs, device IDs, credentials, request headers and image data.
    void chromeApi.storage.local.set({ dp_screen_capture_diagnostic: record }).catch(() => {});
    console.debug('[DigitalPulse] Screenshot state', record);
    return record;
  }

  function stop(reason = 'MONITORING_WITHDRAWN') {
    reason = safeCode(reason, 'MONITORING_WITHDRAWN');
    generation += 1;
    lastInvalidation = { event: reason, generation, at: new Date().toISOString() };
    authorizationDeadline = 0;
    expiryVersion += 1;
    clearTimeout(expiryTimer);
    uploadController?.abort();
    diagnostic('invalidated');
    return indicatorQueue(() => setMonitoringIndicator(chromeApi, false, reason));
  }
  // Never trust a badge or authorization left over from an earlier worker.
  const ready = stop('AUTHORIZATION_CHECK_REQUIRED');
  chromeApi.permissions?.onRemoved?.addListener(() => { void stop('BROWSER_CAPTURE_PERMISSION_REMOVED'); });
  chromeApi.action?.onUserSettingsChanged?.addListener((settings) => {
    if (settings.isOnToolbar === false) void stop('VISIBLE_INDICATOR_NOT_PINNED');
  });
  chromeApi.alarms?.onAlarm?.addListener((alarm) => {
    // A queued alarm from an older, shorter lease must not invalidate a newer lease.
    if (alarm.name === CAPTURE_EXPIRY_ALARM && authorizationDeadline > 0 && Date.now() >= authorizationDeadline) {
      void stop('MONITORING_AUTHORIZATION_EXPIRED');
    }
  });
  // Events before a target is established are harmless: the subsequent tab query
  // selects and verifies the new target. Once established, only a real target
  // change invalidates the in-memory image.
  chromeApi.tabs.onActivated?.addListener((info) => {
    if (activeAttempt?.targetTabId != null && info?.tabId !== activeAttempt.targetTabId) void stop('ACTIVE_TAB_CHANGED');
  });
  chromeApi.tabs.onUpdated?.addListener((tabId, change) => {
    if (activeAttempt?.targetTabId === tabId && (change.url || change.status === 'loading')) void stop('TAB_NAVIGATION');
  });
  chromeApi.windows.onFocusChanged?.addListener((windowId) => {
    if (activeAttempt?.targetWindowId != null && windowId !== activeAttempt.targetWindowId) void stop('WINDOW_FOCUS_LOST');
  });
  chromeApi.idle?.onStateChanged?.addListener((state) => {
    if (activeAttempt && state !== 'active') void stop('BROWSER_IDLE');
  });

  async function handleHeartbeatMonitoring(monitoring) {
    if (monitoring?.allowed === true && monitoring?.visibleIndicator !== false && futureTime(monitoring.allowedUntil)) return true;
    await stop(monitoring?.reason || 'HEARTBEAT_MONITORING_DENIED');
    return false;
  }

  function assertCurrent(policy, version) {
    if (!futureTime(policy.allowedUntil)) throw new Error('MONITORING_AUTHORIZATION_EXPIRED');
    if (generation !== version) throw new Error(lastInvalidation.event || 'MONITORING_AUTHORIZATION_WITHDRAWN');
  }

  async function assertBrowserReady() {
    if (!await hasCapturePermission(chromeApi)) throw new Error('BROWSER_CAPTURE_PERMISSION_REQUIRED');
    if ((await chromeApi.action?.getUserSettings?.())?.isOnToolbar !== true) throw new Error('VISIBLE_INDICATOR_NOT_PINNED');
  }

  async function armIndicator(policy, version) {
    assertCurrent(policy, version);
    const deadline = Date.parse(policy.allowedUntil);
    authorizationDeadline = deadline;
    const timerVersion = ++expiryVersion;
    // Creating an alarm with the same name replaces its previous schedule.
    await chromeApi.alarms.create(CAPTURE_EXPIRY_ALARM, { when: deadline });
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      if (timerVersion === expiryVersion && authorizationDeadline === deadline && Date.now() >= deadline) {
        void stop('MONITORING_AUTHORIZATION_EXPIRED');
      }
    }, Math.max(0, deadline - Date.now()));
    expiryTimer.unref?.();
    const established = await indicatorQueue(async () => {
      assertCurrent(policy, version);
      return setMonitoringIndicator(chromeApi, true);
    });
    if (!established) throw new Error('VISIBLE_INDICATOR_UNAVAILABLE');
    assertCurrent(policy, version);
  }

  async function reportFailure(stored, code) {
    try {
      const backendUrl = resolveBackendUrl(stored, config);
      await fetchImpl(`${backendUrl}/api/v1/screen-monitoring/failures`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Device-Secret': stored.dp_device_secret },
        body: JSON.stringify({ deviceId: stored[config.DEVICE_STORAGE_KEY], failureCode: code }),
      });
    } catch { /* Failure reporting must never create a capture retry loop. */ }
  }

  async function captureAuthorizedActiveTab() {
    if (inFlight) return inFlight;
    inFlight = performCapture().finally(() => { inFlight = null; activeAttempt = null; });
    return inFlight;
  }

  async function performCapture() {
    let stored;
    try {
      await ready;
      const version = generation;
      activeAttempt = { id: captureKey(), generation: version, allowedUntil: null, targetTabId: null, targetWindowId: null, targetUrl: null };
      diagnostic('started');
      await assertBrowserReady();
      diagnostic('browser-permission-verified');
      stored = await readDeviceState(chromeApi, config);
      const policy = await fetchPolicy({ chromeApi, fetchImpl, config, stored });
      activeAttempt.allowedUntil = policy.allowedUntil;
      diagnostic('policy-authorized');
      await armIndicator(policy, version);
      diagnostic('indicator-active');
      if (!intervalElapsed(stored.dp_last_screen_capture_at, policy.intervalSeconds)) return { skipped: true, reason: 'CAPTURE_INTERVAL_NOT_ELAPSED' };
      await assertBrowserReady();
      const tab = await activeVisibleTab(chromeApi);
      activeAttempt.targetTabId = tab.id;
      activeAttempt.targetWindowId = tab.windowId;
      activeAttempt.targetUrl = tab.url;
      // Close the query/listener handoff race by immediately verifying the same
      // active target after recording it.
      const confirmedTab = await activeVisibleTab(chromeApi);
      if (confirmedTab.id !== tab.id || confirmedTab.windowId !== tab.windowId || confirmedTab.url !== tab.url) throw new Error('ACTIVE_TAB_CHANGED');
      if (await chromeApi.action.getBadgeText({}) !== 'ON') throw new Error('VISIBLE_INDICATOR_UNAVAILABLE');
      assertCurrent(policy, version);
      diagnostic('target-verified');
      const capturedAt = new Date().toISOString();
      const dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, { format: CAPTURE_FORMAT, quality: CAPTURE_QUALITY });
      const image = decodeDataUrl(dataUrl);
      const dimensions = imageDimensions(image.bytes, image.mimeType);
      diagnostic('captured');

      diagnostic('reauthorizing');
      const latestDevice = await readDeviceState(chromeApi, config);
      const latestPolicy = await fetchPolicy({ chromeApi, fetchImpl, config, stored: latestDevice });
      if (latestPolicy.deviceId !== policy.deviceId || latestPolicy.backendUrl !== policy.backendUrl || latestDevice.dp_device_secret !== stored.dp_device_secret) throw new Error('MONITORING_DEVICE_CHANGED');
      // A shortened schedule/lease must shorten the badge and cancellation timer,
      // but a refreshed lease must never extend this image's original authority.
      policy.allowedUntil = new Date(Math.min(Date.parse(policy.allowedUntil), Date.parse(latestPolicy.allowedUntil))).toISOString();
      activeAttempt.allowedUntil = policy.allowedUntil;
      await armIndicator(policy, version);
      await assertBrowserReady();
      const latestTab = await activeVisibleTab(chromeApi);
      const latestStored = await chromeApi.storage.local.get(['dp_monitoring_indicator_active']);
      if (latestStored.dp_monitoring_indicator_active !== true || latestTab.id !== tab.id || latestTab.url !== tab.url || latestTab.windowId !== tab.windowId || await chromeApi.action.getBadgeText({}) !== 'ON') throw new Error('MONITORING_WITHDRAWN_BEFORE_UPLOAD');
      // Do not extend the original capture authorization with a newer lease.
      assertCurrent(policy, version);
      assertCurrent(latestPolicy, version);
      diagnostic('upload-authorized');
      uploadController = new AbortController();
      const uploadTimeout = setTimeout(() => uploadController?.abort(), Math.max(0, Math.min(15000, Date.parse(policy.allowedUntil) - Date.now(), Date.parse(latestPolicy.allowedUntil) - Date.now())));

      diagnostic('uploading');
      let response;
      try { response = await fetchImpl(`${latestPolicy.backendUrl}/api/v1/screen-monitoring/captures?deviceId=${encodeURIComponent(latestPolicy.deviceId)}`, {
        method: 'POST',
        redirect: 'error',
        signal: uploadController.signal,
        headers: {
          'Content-Type': image.mimeType,
          'X-Device-Secret': stored.dp_device_secret,
          'X-Capture-Key': captureKey(),
          'X-Captured-At': capturedAt,
          'X-Image-Width': String(dimensions.width),
          'X-Image-Height': String(dimensions.height),
          'X-Application-Name': `${browserName === 'edge' ? 'Edge' : 'Chrome'} - Active Tab`,
        },
        body: image.bytes,
      }); } finally { clearTimeout(uploadTimeout); uploadController = null; }
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true) throw new Error(result.error?.code ? `SCREEN_UPLOAD_${result.error.code}` : `SCREEN_UPLOAD_FAILED_${response.status}`);
      await chromeApi.storage.local.set({ dp_last_screen_capture_at: capturedAt, dp_last_screen_capture_id: result.captureId || null, dp_screen_capture_error: '' });
      diagnostic('complete');
      return { success: true, captureId: result.captureId, capturedAt, dimensions };
    } catch (error) {
      const errorCode = safeCode(error.message);
      diagnostic('failed', { error: errorCode });
      await stop(errorCode);
      if (stored) {
        await chromeApi.storage.local.set({ dp_screen_capture_error: errorCode });
        if (!['CAPTURE_INTERVAL_NOT_ELAPSED', 'MONITORING_NOT_AUTHORIZED', 'SCREEN_POLICY_UNAVAILABLE_403', 'MONITORING_WITHDRAWN_BEFORE_UPLOAD'].includes(errorCode)) await reportFailure(stored, errorCode.startsWith('SCREEN_UPLOAD') ? 'UPLOAD_FAILED' : 'CAPTURE_API_FAILED');
      }
      if (errorCode === 'CAPTURE_INTERVAL_NOT_ELAPSED') return { skipped: true, reason: errorCode };
      return { success: false, error: errorCode };
    }
  }

  return { captureAuthorizedActiveTab, stop, handleHeartbeatMonitoring };
}

export { decodeDataUrl, futureTime, imageDimensions, intervalElapsed };
