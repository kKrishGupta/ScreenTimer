import test from 'node:test';
import assert from 'node:assert/strict';
import { recordBlockedAttempt, flushBlockedAttempts } from '../background/blocked-attempts.js';
import { CONFIG } from '../shared/constants.js';

test('reports only main-frame policy matches, strips URL paths, and retries failed delivery', async () => {
  const state = { dp_device_id: 'device-1', dp_device_secret: 'secret', dp_settings: { backendUrl: CONFIG.DEFAULT_BACKEND_URL } };
  const chrome = {
    storage: { local: { get: async () => structuredClone(state), set: async (data) => Object.assign(state, data) } },
    declarativeNetRequest: { getDynamicRules: async () => [{ action: { type: 'block' }, condition: { urlFilter: '||instagram.com' } }] },
  };
  const event = { frameId: 0, error: 'net::ERR_BLOCKED_BY_CLIENT', url: 'https://www.instagram.com/private?token=secret' };
  await recordBlockedAttempt({ ...event, frameId: 1 }, chrome);
  await recordBlockedAttempt({ ...event, url: 'https://instagram.com.evil.example' }, chrome);
  await recordBlockedAttempt({ ...event, error: 'net::ERR_NAME_NOT_RESOLVED' }, chrome);
  assert.equal(state.dp_blocked_attempts, undefined);
  await recordBlockedAttempt(event, chrome);
  await recordBlockedAttempt(event, chrome);
  assert.equal(state.dp_blocked_attempts.length, 1);
  await flushBlockedAttempts(chrome, async () => ({ ok: false, status: 503 }));
  assert.equal(state.dp_blocked_attempts.length, 1);
  await flushBlockedAttempts(chrome, async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.domain, 'www.instagram.com');
    assert.equal(payload.url, undefined);
    assert.equal(options.headers['X-Device-Secret'], 'secret');
    return { ok: true };
  });
  assert.equal(state.dp_blocked_attempts.length, 0);
});
