import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBlockingRules, syncBlockingRulesWithStatus } from '../background/policy-sync.js';

function createChrome(existingRules = []) {
  const updates = [];
  return {
    storage: {
      local: {
        async get() {
          return {
            dp_device_id: 'device-1',
            dp_device_secret: 'secret-1',
            dp_settings: { backendUrl: 'http://127.0.0.1:3001' },
          };
        },
      },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return existingRules;
      },
      async updateDynamicRules(update) {
        updates.push(update);
      },
    },
    updates,
  };
}

test('installs authenticated backend rules and removes stale rules', async () => {
  const chromeApi = createChrome([{ id: 8 }]);
  let request;
  const result = await syncBlockingRules(chromeApi, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return {
          rules: [
            { id: 1, condition: { urlFilter: '||blocked.example' }, action: { type: 'block' } },
            { id: 'invalid', condition: {}, action: {} },
          ],
        };
      },
    };
  });

  assert.deepEqual(result, { updated: true, count: 1 });
  assert.equal(request.options.headers['X-Device-Secret'], 'secret-1');
  assert.match(request.url, /deviceId=device-1/);
  assert.deepEqual(chromeApi.updates, [{
    removeRuleIds: [8],
    addRules: [{ id: 1, condition: { urlFilter: '||blocked.example' }, action: { type: 'block' } }],
  }]);
});

test('does not alter rules when the device is not enrolled', async () => {
  const chromeApi = createChrome();
  chromeApi.storage.local.get = async () => ({});
  const result = await syncBlockingRules(chromeApi, async () => {
    throw new Error('network should not be called');
  });

  assert.deepEqual(result, { updated: false, reason: 'device-not-enrolled' });
  assert.deepEqual(chromeApi.updates, []);
});

test('converts backend redirects to native blocks without requiring website host access', async () => {
  const chromeApi = createChrome();
  const rule = { id: 1, priority: 1, condition: { urlFilter: '||instagram.com', resourceTypes: ['main_frame'] }, action: { type: 'redirect', redirect: { url: 'http://localhost:5173/blocked' } } };
  await syncBlockingRules(chromeApi, async () => ({ ok: true, json: async () => ({ rules: [rule] }) }));
  assert.deepEqual(chromeApi.updates[0].addRules, [{ ...rule, action: { type: 'block' } }]);
});

test('failed or malformed policy responses preserve installed rules', async () => {
  for (const response of [{ ok: false, status: 401 }, { ok: true, json: async () => ({}) }]) {
    const chromeApi = createChrome([{ id: 1 }]);
    assert.equal((await syncBlockingRules(chromeApi, async () => response)).updated, false);
    assert.deepEqual(chromeApi.updates, []);
  }
});

test('stores policy installation errors for popup diagnostics', async () => {
  const chromeApi = createChrome();
  let stored;
  chromeApi.storage.local.set = async (value) => { stored = value; };
  chromeApi.declarativeNetRequest.updateDynamicRules = async () => { throw new Error('Rule installation failed'); };
  const result = await syncBlockingRulesWithStatus(chromeApi, async () => ({ ok: true, json: async () => ({ rules: [] }) }));
  assert.equal(result.updated, false);
  assert.equal(stored.dp_policy_sync.reason, 'Rule installation failed');
});
