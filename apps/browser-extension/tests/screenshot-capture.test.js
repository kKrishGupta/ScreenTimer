import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenshotCapture, futureTime } from '../background/screenshot-capture.js';
import { CONFIG } from '../shared/constants.js';

const DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'dp_sec_browser-test-secret';

function jpegDataUrl() {
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
  const validBytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
  ]);
  let binary = '';
  validBytes.forEach((value) => { binary += String.fromCharCode(value); });
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

function setup({ policy = {}, fetchImpl, tab = {}, stored = {} } = {}) {
  const storage = {
    [CONFIG.DEVICE_STORAGE_KEY]: DEVICE_ID,
    [CONFIG.SETTINGS_STORAGE_KEY]: { backendUrl: 'http://127.0.0.1:3001' },
    dp_device_secret: SECRET,
    ...stored,
  };
  const badge = [];
  const listeners = {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  let badgeText = '';
  const chromeApi = {
    permissions: { contains: async () => true, onRemoved: event('permissionRemoved') },
    alarms: { create: async () => {}, onAlarm: event('alarm') },
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])); },
      async set(values) { Object.assign(storage, values); },
    } },
    action: {
      async setBadgeText(value) { badgeText = value.text; badge.push(['text', value.text]); },
      getBadgeText: async () => badgeText,
      getUserSettings: async () => ({ isOnToolbar: true }),
      async setBadgeBackgroundColor(value) { badge.push(['color', value.color]); },
      async setTitle(value) { badge.push(['title', value.title]); },
      onUserSettingsChanged: event('userSettingsChanged'),
    },
    windows: { getLastFocused: async () => ({ id: 7, focused: true, type: 'normal' }), onFocusChanged: event('focusChanged') },
    idle: { queryState: async () => 'active', onStateChanged: event('idleChanged') },
    tabs: {
      query: async () => [{ id: 9, windowId: 7, active: true, incognito: false, discarded: false, url: 'https://example.com/work', ...tab }],
      captureVisibleTab: async () => jpegDataUrl(),
      onActivated: event('tabActivated'),
      onUpdated: event('tabUpdated'),
    },
  };
  const requests = [];
  const fetcher = fetchImpl || (async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, async json() { return { policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 300 }, success: true, captureId: 'capture-1' }; } };
  });
  const client = createScreenshotCapture({ chromeApi, fetchImpl: fetcher, config: CONFIG, browserName: 'chrome' });
  return { client, chromeApi, storage, badge, requests, listeners };
}

test('captures and uploads the authorized visible active tab', async () => {
  const { client, requests, storage, badge } = setup();
  const result = await client.captureAuthorizedActiveTab();
  assert.equal(result.success, true);
  assert.equal(requests.at(-1).options.headers['X-Application-Name'], 'Chrome - Active Tab');
  assert.equal(requests.at(-1).options.headers['X-Image-Width'], '3');
  assert.equal(requests.at(-1).options.headers['X-Image-Height'], '2');
  assert.equal(storage.dp_last_screen_capture_id, 'capture-1');
  assert.ok(badge.some(([type, text]) => type === 'text' && text === 'ON'));
});

test('parses a valid future policy lease and rejects invalid or expired values', () => {
  assert.equal(futureTime(new Date(Date.now() + 60_000).toISOString()), true);
  assert.equal(futureTime(new Date(Date.now() + 60_000).toUTCString()), true);
  assert.equal(futureTime(new Date(Date.now() - 1).toISOString()), false);
  assert.equal(futureTime('not-a-date'), false);
});

test('does not capture when organization monitoring or employee authorization is denied', async () => {
  for (const reason of ['SCREEN_MONITORING_DISABLED', 'SCREEN_NOTICE_NOT_ACKNOWLEDGED', 'DEVICE_REVOKED']) {
    let captures = 0;
    const { client } = setup({ fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, async json() { return { policy: { allowed: false, visibleIndicator: true, reason, allowedUntil: null } }; } };
      if (!options || !options.body || !url.includes('/captures?')) return { ok: true, status: 204, async json() { return {}; } };
      captures += 1;
      return { ok: true, status: 201, async json() { return { success: true, captureId: 'unexpected' }; } };
    } });
    const result = await client.captureAuthorizedActiveTab();
    assert.equal(result.success, false);
    assert.equal(captures, 0);
  }
});

test('rejects expired authorization, inactive tabs, hidden tabs, and incognito tabs', async () => {
  const expired = setup({ fetchImpl: async () => ({ ok: true, status: 200, async json() { return { policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() - 1).toISOString(), intervalSeconds: 300 } }; } }) });
  assert.equal((await expired.client.captureAuthorizedActiveTab()).success, false);

  for (const tab of [{ active: false }, { incognito: true }]) {
    const { client } = setup({ tab, fetchImpl: async (url) => {
      if (url.includes('device-policy')) return { ok: true, status: 200, async json() { return { policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 300 } }; } };
      return { ok: true, status: 201, async json() { return { success: true, captureId: 'unexpected' }; } };
    } });
    assert.equal((await client.captureAuthorizedActiveTab()).success, false);
  }
});

test('rechecks authorization before upload and discards a capture when withdrawn', async () => {
  let policyCalls = 0;
  let uploads = 0;
  const { client } = setup({ fetchImpl: async (url) => {
    if (url.includes('device-policy')) {
      policyCalls += 1;
      return { ok: true, status: 200, async json() { return { policy: policyCalls === 1 ? { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 300 } : { allowed: false, visibleIndicator: true, reason: 'USER_CONSENT_REQUIRED' } }; } };
    }
    if (!url.includes('/captures?')) return { ok: true, status: 204, async json() { return {}; } };
    uploads += 1;
    return { ok: true, status: 201, async json() { return { success: true, captureId: 'unexpected' }; } };
  } });
  const result = await client.captureAuthorizedActiveTab();
  assert.equal(result.success, false);
  assert.equal(uploads, 0);
});

test('coalesces overlapping captures and skips a recent capture after worker restart', async () => {
  let captures = 0;
  const first = setup({ fetchImpl: async (url, options) => {
    if (url.includes('device-policy')) return { ok: true, status: 200, async json() { return { policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 300 }, success: true, captureId: 'capture-1' }; } };
    captures += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, status: 201, async json() { return { success: true, captureId: 'capture-1' }; } };
  } });
  const [one, two] = await Promise.all([first.client.captureAuthorizedActiveTab(), first.client.captureAuthorizedActiveTab()]);
  assert.equal(one.captureId, two.captureId);
  assert.equal(captures, 1);

  const restarted = setup({ stored: { dp_last_screen_capture_at: new Date().toISOString() } });
  const result = await restarted.client.captureAuthorizedActiveTab();
  assert.deepEqual(result, { skipped: true, reason: 'CAPTURE_INTERVAL_NOT_ELAPSED' });
});

test('keeps the failure safe when upload fails and retries on the next authorized run', async () => {
  let uploads = 0;
  const { client, storage } = setup({ fetchImpl: async (url) => {
    if (url.includes('device-policy')) return { ok: true, status: 200, async json() { return { policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 300 } }; } };
    if (!url.includes('/captures?')) return { ok: true, status: 204, async json() { return {}; } };
    uploads += 1;
    return uploads === 1
      ? { ok: false, status: 503, async json() { return { error: { code: 'TEMPORARY_FAILURE' } }; } }
      : { ok: true, status: 201, async json() { return { success: true, captureId: 'capture-2' }; } };
  } });
  assert.equal((await client.captureAuthorizedActiveTab()).success, false);
  assert.match(storage.dp_screen_capture_error, /SCREEN_UPLOAD_TEMPORARY_FAILURE/);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await client.captureAuthorizedActiveTab()).success, true);
  assert.equal(uploads, 2);
});

test('missing, denied or revoked browser permission prevents capture and clears the badge', async () => {
  for (const contains of [async () => false, async () => { throw new Error('API unavailable'); }]) {
    const { client, chromeApi, storage, requests } = setup();
    chromeApi.permissions.contains = contains;
    chromeApi.tabs.captureVisibleTab = () => assert.fail('must not capture');
    assert.equal((await client.captureAuthorizedActiveTab()).error, 'BROWSER_CAPTURE_PERMISSION_REQUIRED');
    assert.equal(storage.dp_monitoring_indicator_active, false);
    assert.equal(requests.length, 0);
  }
});

test('permission removed during capture invalidates image even if subsequently regranted', async () => {
  const { client, chromeApi, listeners, requests, storage } = setup();
  chromeApi.tabs.captureVisibleTab = async () => { listeners.permissionRemoved({ origins: ['<all_urls>'] }); return jpegDataUrl(); };
  assert.equal((await client.captureAuthorizedActiveTab()).success, false);
  assert.equal(requests.filter(({ url }) => url.includes('/captures?')).length, 0);
  assert.equal(storage.dp_monitoring_indicator_active, false);
});

test('expiry during asynchronous tab checks prevents capture and upload', async () => {
  for (const expireOnQuery of [1, 3]) {
    const { client, chromeApi, requests } = setup();
    let queries = 0;
    const query = chromeApi.tabs.query;
    const now = Date.now;
    let captures = 0;
    chromeApi.tabs.captureVisibleTab = async () => { captures++; return jpegDataUrl(); };
    chromeApi.tabs.query = async (...args) => {
      const tabs = await query(...args);
      if (++queries === expireOnQuery) Date.now = () => now() + 120_000;
      return tabs;
    };
    try {
      assert.equal((await client.captureAuthorizedActiveTab()).success, false);
      assert.equal(captures, expireOnQuery === 1 ? 0 : 1);
      assert.equal(requests.filter(({ url }) => url.includes('/captures?')).length, 0);
    } finally { Date.now = now; }
  }
});

test('hidden, inactive, incognito, navigating and minimized targets fail closed', async () => {
  for (const tab of [{ hidden: true }, { active: false }, { incognito: true }, { pendingUrl: 'https://example.org/' }, { discarded: true }]) {
    const { client, chromeApi } = setup({ tab });
    chromeApi.tabs.captureVisibleTab = () => assert.fail('must not capture');
    assert.equal((await client.captureAuthorizedActiveTab()).success, false);
  }
  for (const window of [{ focused: false }, { state: 'minimized' }, { state: 'fullscreen' }, { incognito: true }]) {
    const { client, chromeApi } = setup();
    chromeApi.windows.getLastFocused = async () => ({ id: 7, focused: true, type: 'normal', ...window });
    chromeApi.tabs.captureVisibleTab = () => assert.fail('must not capture');
    assert.equal((await client.captureAuthorizedActiveTab()).success, false);
  }
});

test('unpinned toolbar, badge failure or policy fetch failure clears indicator and prevents capture', async () => {
  for (const failure of ['unpinned', 'badge', 'network']) {
    const fixture = setup(failure === 'network' ? { fetchImpl: async () => { throw new Error('offline'); } } : {});
    const { client, chromeApi, storage } = fixture;
    if (failure === 'unpinned') chromeApi.action.getUserSettings = async () => ({ isOnToolbar: false });
    if (failure === 'badge') chromeApi.action.setBadgeBackgroundColor = async () => { throw new Error('badge failure'); };
    chromeApi.tabs.captureVisibleTab = () => assert.fail('must not capture');
    assert.equal((await client.captureAuthorizedActiveTab()).success, false);
    assert.equal(storage.dp_monitoring_indicator_active, false);
    assert.equal(await chromeApi.action.getBadgeText({}), '');
  }
});

test('expiry alarm clears a successful indicator and restart revalidates permission', async () => {
  const first = setup();
  assert.equal((await first.client.captureAuthorizedActiveTab()).success, true);
  const deadline = Date.parse(first.storage.dp_screen_capture_diagnostic.allowedUntil);
  const now = Date.now;
  try {
    first.listeners.alarm({ name: 'dp_screen_authorization_expiry' });
    await new Promise(setImmediate);
    assert.equal(first.storage.dp_monitoring_indicator_active, true, 'stale early alarm is ignored');
    Date.now = () => deadline + 1;
    first.listeners.alarm({ name: 'dp_screen_authorization_expiry' });
    await new Promise(setImmediate);
    assert.equal(first.storage.dp_monitoring_indicator_active, false);
  } finally { Date.now = now; }
  const restarted = setup({ stored: { ...first.storage, dp_monitoring_indicator_active: true } });
  restarted.chromeApi.permissions.contains = async () => false;
  assert.equal((await restarted.client.captureAuthorizedActiveTab()).success, false);
  assert.equal(restarted.storage.dp_monitoring_indicator_active, false);
});

test('permission removal aborts an in-flight upload', async () => {
  let fixture;
  fixture = setup({ fetchImpl: async (url, options) => {
    if (url.includes('device-policy')) return { ok: true, json: async () => ({ policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString() } }) };
    if (url.includes('/captures?')) {
      fixture.listeners.permissionRemoved({ origins: ['<all_urls>'] });
      assert.equal(options.signal.aborted, true);
      throw new Error('aborted');
    }
    return { ok: true };
  } });
  assert.equal((await fixture.client.captureAuthorizedActiveTab()).success, false);
  assert.equal(fixture.storage.dp_last_screen_capture_id, undefined);
});

test('pre-upload policy shortens the indicator deadline without extending the original lease', async () => {
  for (const remaining of [10_000, 120_000]) {
    const firstDeadline = Date.now() + 60_000;
    const secondDeadline = Date.now() + remaining;
    let calls = 0;
    const { client, chromeApi } = setup({ fetchImpl: async (url) => {
      if (url.includes('device-policy')) return { ok: true, json: async () => ({ policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(++calls === 1 ? firstDeadline : secondDeadline).toISOString() } }) };
      return { ok: true, json: async () => ({ success: true, captureId: 'test-capture' }) };
    } });
    let armedUntil;
    chromeApi.alarms.create = async (_name, { when }) => { armedUntil = when; };
    assert.equal((await client.captureAuthorizedActiveTab()).success, true);
    assert.equal(armedUntil, Math.min(firstDeadline, secondDeadline));
    await client.stop();
  }
});

test('stable target events and an ordinary authorized heartbeat do not invalidate a pending capture', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = setup();
  fixture.chromeApi.tabs.captureVisibleTab = async () => {
    fixture.listeners.tabActivated({ tabId: 9, windowId: 7 });
    fixture.listeners.focusChanged(7);
    await gate;
    return jpegDataUrl();
  };
  const pending = fixture.client.captureAuthorizedActiveTab();
  for (let i = 0; i < 20 && fixture.storage.dp_screen_capture_diagnostic?.stage !== 'target-verified'; i++) await new Promise(setImmediate);
  assert.equal(await fixture.client.handleHeartbeatMonitoring({
    allowed: true,
    allowedUntil: new Date(Date.now() + 60_000).toISOString(),
  }), true);
  release();
  assert.equal((await pending).success, true);
  assert.equal(fixture.storage.dp_screen_capture_diagnostic.stage, 'complete');
});

test('an expected initial tab/focus event selects the target instead of invalidating authorization', async () => {
  let policyCalls = 0;
  let fixture;
  fixture = setup({ fetchImpl: async (url) => {
    if (url.includes('device-policy')) {
      policyCalls++;
      if (policyCalls === 1) {
        fixture.listeners.tabActivated({ tabId: 9, windowId: 7 });
        fixture.listeners.focusChanged(7);
      }
      return { ok: true, json: async () => ({ policy: { allowed: true, visibleIndicator: true, allowedUntil: new Date(Date.now() + 60_000).toISOString() } }) };
    }
    return { ok: true, json: async () => ({ success: true, captureId: 'initial-event-capture' }) };
  } });
  assert.equal((await fixture.client.captureAuthorizedActiveTab()).success, true);
});

test('tab switch during capture cancels and discards the image with a specific diagnostic', async () => {
  const fixture = setup();
  fixture.chromeApi.tabs.captureVisibleTab = async () => {
    fixture.listeners.tabActivated({ tabId: 10, windowId: 7 });
    return jpegDataUrl();
  };
  const result = await fixture.client.captureAuthorizedActiveTab();
  assert.equal(result.error, 'ACTIVE_TAB_CHANGED');
  assert.equal(fixture.requests.filter(({ url }) => url.includes('/captures?')).length, 0);
  assert.equal(fixture.storage.dp_screen_capture_diagnostic.invalidationEvent, 'ACTIVE_TAB_CHANGED');
});

test('navigation during capture cancels and discards the image', async () => {
  const fixture = setup();
  fixture.chromeApi.tabs.captureVisibleTab = async () => {
    fixture.listeners.tabUpdated(9, { status: 'loading', url: 'https://example.com/next' });
    return jpegDataUrl();
  };
  const result = await fixture.client.captureAuthorizedActiveTab();
  assert.equal(result.error, 'TAB_NAVIGATION');
  assert.equal(fixture.requests.filter(({ url }) => url.includes('/captures?')).length, 0);
});

test('genuine authorization expiry is distinct from target invalidation', async () => {
  const fixture = setup();
  const now = Date.now;
  fixture.chromeApi.tabs.captureVisibleTab = async () => {
    const deadline = Date.parse(fixture.storage.dp_screen_capture_diagnostic.allowedUntil);
    Date.now = () => deadline + 1;
    fixture.listeners.alarm({ name: 'dp_screen_authorization_expiry' });
    return jpegDataUrl();
  };
  try {
    const result = await fixture.client.captureAuthorizedActiveTab();
    assert.equal(result.error, 'MONITORING_AUTHORIZATION_EXPIRED');
    assert.equal(fixture.requests.filter(({ url }) => url.includes('/captures?')).length, 0);
  } finally { Date.now = now; }
});

test('server policy denial is retained as the exact sanitized reason', async () => {
  const fixture = setup({ fetchImpl: async (url) => {
    if (url.includes('device-policy')) return { ok: true, json: async () => ({ policy: { allowed: false, visibleIndicator: true, allowedUntil: null, reason: 'SCREEN_MONITORING_DISABLED' } }) };
    return { ok: true, json: async () => ({ success: true }) };
  } });
  assert.equal((await fixture.client.captureAuthorizedActiveTab()).error, 'SCREEN_MONITORING_DISABLED');
  assert.equal(fixture.storage.dp_screen_capture_diagnostic.invalidationEvent, 'SCREEN_MONITORING_DISABLED');
});

test('focus restoration to the target window is stable; actual focus loss cancels until a new attempt', async () => {
  const fixture = setup();
  fixture.chromeApi.tabs.captureVisibleTab = async () => {
    fixture.listeners.focusChanged(7);
    fixture.listeners.focusChanged(-1);
    fixture.listeners.focusChanged(7);
    return jpegDataUrl();
  };
  assert.equal((await fixture.client.captureAuthorizedActiveTab()).error, 'WINDOW_FOCUS_LOST');
  assert.equal(fixture.requests.filter(({ url }) => url.includes('/captures?')).length, 0);
  fixture.chromeApi.tabs.captureVisibleTab = async () => {
    fixture.listeners.focusChanged(7);
    return jpegDataUrl();
  };
  assert.equal((await fixture.client.captureAuthorizedActiveTab()).success, true);
});

test('worker restart clears stale indicator and creates a fresh diagnostic generation', async () => {
  const fixture = setup({ stored: { dp_monitoring_indicator_active: true } });
  await new Promise(setImmediate);
  assert.equal(fixture.storage.dp_monitoring_indicator_active, false);
  assert.equal(fixture.storage.dp_screen_capture_diagnostic.invalidationEvent, 'AUTHORIZATION_CHECK_REQUIRED');
  assert.equal(fixture.storage.dp_screen_capture_diagnostic.currentGeneration, 1);
  assert.equal((await fixture.client.captureAuthorizedActiveTab()).success, true);
  assert.equal(fixture.storage.dp_screen_capture_diagnostic.captureGeneration, 1);
});
