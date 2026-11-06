import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackendUrl, resolveBackendUrl, saveBackendUrl } from '../shared/backend-settings.js';
const config = { DEFAULT_BACKEND_URL: 'https://api.example.com', SETTINGS_STORAGE_KEY: 'dp_settings', SYNC_QUEUE_STORAGE_KEY: 'dp_sync_queue' };
test('normalizes API paths and rejects insecure remote servers', () => {
  assert.equal(normalizeBackendUrl('https://api.example.com/api/v1'), config.DEFAULT_BACKEND_URL);
  assert.throws(() => normalizeBackendUrl('http://remote.example'));
});
test('ignores user server overrides', () => {
  assert.equal(resolveBackendUrl({ dp_settings: { backendUrl: 'https://other.example' } }, config), config.DEFAULT_BACKEND_URL);
});
test('refuses to send existing credentials to another backend', () => {
  assert.throws(() => resolveBackendUrl({ dp_device_secret: 'secret', dp_settings: { backendUrl: 'https://other.example' } }, config), /different backend/);
});
test('server mutations are disabled', async () => {
  await assert.rejects(saveBackendUrl({}, 'https://other.example'), /managed by your administrator/);
});
