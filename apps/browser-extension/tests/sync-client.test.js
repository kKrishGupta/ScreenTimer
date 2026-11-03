import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncClient } from '../background/sync-client.js';
import { CONFIG } from '../shared/constants.js';

const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

function setup({ queue = [], fetchImpl, enrolled = true, monitoringAllowed = enrolled } = {}) {
  const storage = {
    [CONFIG.DEVICE_STORAGE_KEY]: DEVICE_ID,
    [CONFIG.SETTINGS_STORAGE_KEY]: { backendUrl: 'http://127.0.0.1:3001' },
    [CONFIG.SYNC_QUEUE_STORAGE_KEY]: queue,
    dp_device_secret: enrolled ? 'dp_sec_test-secret-never-render' : undefined,
    dp_monitoring_allowed: monitoringAllowed,
    dp_monitoring_allowed_until: monitoringAllowed ? new Date(Date.now() + 3600000).toISOString() : null,
  };
  const chromeApi = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]));
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
  };
  const client = createSyncClient({ chromeApi, fetchImpl, config: CONFIG, browserName: 'chrome' });
  return { client, storage };
}

function makeQueue(count) {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    deviceId: DEVICE_ID,
    source: 'browser_extension',
    type: 'web_session',
    startedAt: '2026-11-03T10:00:00.000Z',
    endedAt: '2026-11-03T10:00:10.000Z',
    durationSeconds: 10,
    web: { domain: 'example.com', browser: 'chrome' },
  }));
}

test('syncs the first 50 of a persisted 159-event queue and preserves the rest', async () => {
  let submitted = 0;
  const { client, storage } = setup({
    queue: makeQueue(159),
    fetchImpl: async (url, options) => {
      assert.match(url, /activity\/events\/batch$/);
      assert.equal(options.headers['X-Device-Secret'], 'dp_sec_test-secret-never-render');
      const body = JSON.parse(options.body);
      submitted = body.events.length;
      return new Response(JSON.stringify({ accepted: 48, deduplicated: 2, acceptedEventIds: body.events.slice(0, 48).map((event) => event.eventId), deduplicatedEventIds: body.events.slice(48, 50).map((event) => event.eventId), rejectedEventIds: [] }), { status: 200 });
    },
  });

  const result = await client.syncQueue();
  assert.equal(result.ok, true);
  assert.equal(submitted, 50);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 109);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY][0].eventId, makeQueue(159)[50].eventId);
  assert.ok(storage.dp_last_successful_sync_at);
});

test('enrollment stores the long-lived secret in background storage and returns only the device ID', async () => {
  const { client, storage } = setup({ enrolled: false, fetchImpl: async (url, options) => {
    assert.match(url, /devices\/enroll$/);
    assert.equal(JSON.parse(options.body).token, 'dp_enroll_one-time');
    return new Response(JSON.stringify({ success: true, deviceId: 'browser-device-1', deviceSecret: 'dp_sec_new-background-secret' }), { status: 201 });
  } });
  const result = await client.enrollBrowserDevice('dp_enroll_one-time', 'browser-device-1');
  assert.deepEqual(result, { success: true, deviceId: 'browser-device-1' });
  assert.equal(storage.dp_device_secret, 'dp_sec_new-background-secret');
  assert.equal(storage.dp_enrollment_status, 'enrolled');
  assert.equal(Object.hasOwn(result, 'deviceSecret'), false);
});

test('an enrolled browser does not resubmit a consumed token or replace its credentials', async () => {
  const { client, storage } = setup({ fetchImpl: async () => { assert.fail('Already enrolled devices must not submit enrollment again'); } });
  const result = await client.enrollBrowserDevice('already-consumed-token', DEVICE_ID);
  assert.deepEqual(result, { success: true, deviceId: DEVICE_ID, alreadyEnrolled: true });
  assert.equal(storage.dp_device_secret, 'dp_sec_test-secret-never-render');
  assert.equal(Object.hasOwn(result, 'deviceSecret'), false);
});

test('concurrent enrollment submissions share one request', async () => {
  let calls = 0;
  const { client } = setup({ enrolled: false, fetchImpl: async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ deviceId: DEVICE_ID, deviceSecret: 'dp_sec_background-only' }), { status: 201 });
  } });
  const results = await Promise.all([client.enrollBrowserDevice('one-use', DEVICE_ID), client.enrollBrowserDevice('one-use', DEVICE_ID)]);
  assert.equal(calls, 1);
  assert.equal(results[0].deviceId, DEVICE_ID);
  assert.deepEqual(results[0], results[1]);
});

test('removes only acknowledged IDs when backend acknowledgement is incomplete', async () => {
  const original = makeQueue(159);
  const { client, storage } = setup({
    queue: original,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({ accepted: 49, deduplicated: 0, acceptedEventIds: body.events.slice(0, 49).map((event) => event.eventId), deduplicatedEventIds: [], rejectedEventIds: [] }), { status: 200 });
    },
  });

  const result = await client.syncQueue();
  assert.equal(result.ok, false);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 110);
  assert.match(storage.dp_sync_error, /acknowledged 49 of 50/i);
  assert.ok(storage.dp_last_successful_sync_at);
});

test('keeps queued activity when the extension has no device credential', async () => {
  let requestCount = 0;
  const { client, storage } = setup({ queue: makeQueue(159), enrolled: false, fetchImpl: async () => { requestCount++; } });
  const result = await client.syncQueue();
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.match(result.error, /one-time token/i);
  assert.equal(requestCount, 0);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 159);
  assert.equal(storage.dp_sync_error, '');
});

test('does not send an unauthenticated heartbeat or show an enrollment error before setup is available', async () => {
  let requestCount = 0;
  const { client, storage } = setup({ enrolled: false, fetchImpl: async () => { requestCount++; } });
  const result = await client.sendHeartbeat();
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.match(result.error, /one-time token/i);
  assert.equal(requestCount, 0);
  assert.equal(storage.dp_device_connection_status, 'pending');
  assert.equal(storage.dp_enrollment_status, 'pending');
  assert.equal(storage.dp_sync_error, '');
});

test('marks the extension connected only after a healthy authenticated heartbeat response', async () => {
  let request;
  const { client, storage } = setup({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ status: 'healthy', serverTime: new Date().toISOString(), monitoring: { allowed: true, allowedUntil: new Date(Date.now() + 60000).toISOString(), reason: null } }), { status: 200 });
    },
  });
  const result = await client.sendHeartbeat();
  assert.equal(result.ok, true);
  assert.equal(storage.dp_device_connection_status, 'connected');
  assert.match(request.url, /devices\/11111111-2222-4333-8444-555555555555\/heartbeat$/);
  assert.equal(request.options.headers['X-Device-Secret'], 'dp_sec_test-secret-never-render');
  assert.ok(storage.dp_last_heartbeat_at);
  assert.equal(storage.dp_monitoring_allowed, true);
});

test('preserves pending events while monitoring authorization is paused', async () => {
  const original = makeQueue(3);
  let requests = 0;
  const { client, storage } = setup({ queue: original, monitoringAllowed: false, fetchImpl: async () => { requests += 1; } });
  const result = await client.syncQueue();
  assert.equal(result.monitoringPaused, true);
  assert.equal(requests, 0);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 3);
});

test('retains malformed and conflicting queued rows during sync', async () => {
  const queue = [...makeQueue(1), { eventId: 'bad', deviceId: DEVICE_ID, type: 'web_session' }];
  let requestIds = [];
  const { client, storage } = setup({ queue, fetchImpl: async (_url, options) => {
    requestIds = JSON.parse(options.body).events.map((event) => event.eventId);
    return new Response(JSON.stringify({ accepted: 1, deduplicated: 0, acceptedEventIds: requestIds, deduplicatedEventIds: [], rejectedEventIds: [] }), { status: 200 });
  } });
  const result = await client.syncQueue();
  assert.equal(result.ok, true);
  assert.equal(result.audit.malformed, 1);
  assert.equal(requestIds.length, 1);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 1);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY][0].eventId, 'bad');
});

test('backend-rejected events remain queued and are excluded from automatic retries', async () => {
  const queue = makeQueue(2);
  let requests = 0;
  const { client, storage } = setup({ queue, fetchImpl: async (_url, options) => {
    requests += 1;
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ accepted: 1, deduplicated: 0, acceptedEventIds: [body.events[0].eventId], deduplicatedEventIds: [], rejectedEventIds: [body.events[1].eventId] }), { status: 200 });
  } });
  const first = await client.syncQueue();
  assert.equal(first.ok, false);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 1);
  assert.equal(storage.dp_rejected_event_ids.length, 1);
  const second = await client.syncQueue();
  assert.equal(second.monitoringPaused, undefined);
  assert.equal(requests, 1);
  assert.equal(storage[CONFIG.SYNC_QUEUE_STORAGE_KEY].length, 1);
});
