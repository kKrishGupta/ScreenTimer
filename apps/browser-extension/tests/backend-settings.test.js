import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackendUrl, saveBackendUrl } from '../shared/backend-settings.js';
import { CONFIG } from '../shared/constants.js';

test('backend settings accept loopback HTTP or HTTPS origins and reject unsafe endpoints', () => {
  assert.equal(normalizeBackendUrl(' http://127.0.0.1:3001/ '), CONFIG.DEFAULT_BACKEND_URL);
  assert.equal(normalizeBackendUrl('https://trusted.example/'), 'https://trusted.example');
  for (const value of ['http://127.0.0.1.evil.example', 'http://remote.example', 'file:///tmp', 'https://user:pass@trusted.example', 'https://trusted.example/api', 'https://trusted.example/?token=secret', 'https://trusted.example/#fragment', 'not a URL']) {
    assert.throws(() => normalizeBackendUrl(value));
  }
});

test('backend save requests exactly the HTTPS host and preserves other settings and queue', async () => {
  const stored = { dp_settings: { syncIntervalSecs: 30 }, dp_sync_queue: [] };
  const permissions = [];
  const chrome = {
    permissions: { request: async (request) => { permissions.push(request); return true; } },
    storage: { local: { get: async () => stored, set: async (values) => Object.assign(stored, values) } },
  };
  await saveBackendUrl(chrome, 'https://trusted.example/');
  assert.deepEqual(permissions, [{ origins: ['https://trusted.example/*'] }]);
  assert.deepEqual(stored.dp_settings, { syncIntervalSecs: 30, backendUrl: 'https://trusted.example' });
  assert.deepEqual(stored.dp_sync_queue, []);
  stored.dp_device_secret = 'protected';
  stored.dp_sync_queue = [{ eventId: 'retained' }];
  await assert.rejects(saveBackendUrl(chrome, 'https://other.example'), /credentials or pending events/);
  assert.equal(stored.dp_settings.backendUrl, 'https://trusted.example');
  assert.equal(stored.dp_sync_queue.length, 1);
});

test('declined host permission does not change settings', async () => {
  let writes = 0;
  const chrome = { permissions: { request: async () => false }, storage: { local: { set: async () => { writes++; } } } };
  await assert.rejects(saveBackendUrl(chrome, 'https://trusted.example'), /declined/);
  assert.equal(writes, 0);
});
