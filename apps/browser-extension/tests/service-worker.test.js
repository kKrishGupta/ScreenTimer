import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../shared/constants.js';

test('real worker wiring preserves enrollment, recovers alarms and never uses heartbeat as screenshot permission', async (t) => {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  const events = new Map();
  const event = (name) => ({ addListener(fn) { events.set(name, [...(events.get(name) || []), fn]); } });
  const emit = (name, value) => { for (const fn of events.get(name) || []) fn(value); };
  const state = {
    dp_device_id: '11111111-2222-4333-8444-555555555555', dp_device_secret: 'test-only',
    dp_settings: { backendUrl: CONFIG.DEFAULT_BACKEND_URL }, dp_last_screen_capture_at: new Date().toISOString(),
  };
  const alarms = new Map();
  let granted = false;
  let denied = false;
  let badge = '';
  let syncCount = 0;
  let policies = 0;
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]])),
      set: async (values) => { Object.assign(state, values); if (values.dp_automatic_sync) syncCount++; },
      remove: async (key) => { delete state[key]; },
      setAccessLevel: async () => {},
    } },
    permissions: { contains: async () => granted, onRemoved: event('removed') },
    action: {
      setBadgeText: async ({ text }) => { badge = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
      getBadgeText: async () => badge, getUserSettings: async () => ({ isOnToolbar: true }),
    },
    alarms: { get: async (name) => alarms.get(name), create: async (name, options) => { alarms.set(name, { name, ...options }); }, onAlarm: event('alarm') },
    tabs: {
      query: async () => [{ id: 9, windowId: 7, active: true, url: 'https://example.com/' }],
      captureVisibleTab: () => assert.fail('recent capture or denied permission must prevent capture'),
      onActivated: event('activated'), onUpdated: event('updated'),
    },
    windows: { getLastFocused: async () => ({ id: 7, focused: true, type: 'normal' }), onFocusChanged: event('focus') },
    idle: { queryState: async () => 'active', setDetectionInterval() {}, onStateChanged: event('idle') },
    runtime: { getManifest: () => ({ version: '0.1.3' }), onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    webNavigation: { onErrorOccurred: event('navigationError') },
    declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
  };
  globalThis.fetch = async (url) => {
    const lease = { allowed: true, allowedUntil: new Date(Date.now() + 60_000).toISOString() };
    let payload;
    if (url.includes('/heartbeat')) payload = { status: 'healthy', monitoring: lease }; // Actual heartbeat has no visibleIndicator field.
    else if (url.includes('declarative-rules')) payload = { rules: [] };
    else if (url.includes('device-policy')) { policies++; payload = { policy: { ...lease, allowed: !denied, visibleIndicator: true, intervalSeconds: 300, reason: denied ? 'SCREEN_MONITORING_DISABLED' : null } }; }
    else payload = { success: true };
    return { ok: true, status: 200, json: async () => payload };
  };
  t.after(async () => {
    emit('alarm', { name: 'dp_screen_authorization_expiry' });
    await new Promise(setImmediate);
    Object.assign(globalThis, previous);
  });
  async function waitForSync(count) {
    for (let i = 0; i < 100 && syncCount < count; i++) await new Promise(setImmediate);
    assert.ok(syncCount >= count, 'worker synchronization completed');
  }
  await import('../background/service-worker.js');
  await waitForSync(1);
  assert.equal(alarms.get('dp_sync').periodInMinutes, 0.5);
  assert.equal(badge, '');
  assert.equal(policies, 0);
  assert.equal(state.dp_active_domain, 'example.com', 'heartbeat activity must not require screenshot-specific fields');
  granted = true;
  emit('alarm', { name: 'dp_sync' });
  await waitForSync(2);
  assert.equal(badge, 'ON');
  assert.ok(alarms.has('dp_screen_authorization_expiry'));
  denied = true;
  emit('alarm', { name: 'dp_sync' });
  await waitForSync(3);
  assert.equal(badge, '');
  assert.equal(state.dp_monitoring_indicator_active, false);
  assert.equal(state.dp_device_secret, 'test-only');
  assert.equal(state.dp_device_id, '11111111-2222-4333-8444-555555555555');
});
