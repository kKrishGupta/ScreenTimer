import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syncBlockingRules,
  syncBlockingRulesWithStatus,
  enforceBlockedTabs,
  handleBlockedNavigationCompleted,
  handleTabLoading,
  markTabBlockedByDnr,
  clearBlockedTabEnforcementState,
  doesRuleBlockUrl,
  buildBlockedPageUrl,
  extractOriginalUrlFromBlockedPage,
  isUrlBlockedByCurrentRules,
  ENFORCED_TABS_STORAGE_KEY,
} from '../background/policy-sync.js';

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

test('reloads already-open restricted tabs once when newly blocked without repeating on subsequent syncs', async () => {
  let installedRules = [];
  const reloaded = [];
  const tabs = [
    { id: 10, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { id: 11, url: 'https://youtube.com.evil.example/watch' },
    { id: 12, url: 'https://docs.google.com/document/d/1' },
    { id: 13, url: 'chrome://extensions' },
  ];
  const chromeApi = createChrome();
  chromeApi.declarativeNetRequest.getDynamicRules = async () => installedRules;
  chromeApi.declarativeNetRequest.updateDynamicRules = async (update) => {
    chromeApi.updates.push(update);
    installedRules = update.addRules;
  };
  chromeApi.tabs = {
    async query() {
      return tabs;
    },
    async reload(tabId) {
      reloaded.push(tabId);
    },
  };

  const youtubeRule = {
    id: 1,
    priority: 1,
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
    action: { type: 'redirect', redirect: { url: 'http://localhost:5173/blocked?domain=youtube.com' } },
  };

  // First sync: youtube.com is newly restricted -> open YouTube tab is reloaded once.
  await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [youtubeRule] }),
  }));
  assert.deepEqual(reloaded, [10]);

  // Second sync with identical active policy -> already-enforced tab is not reloaded again.
  await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [youtubeRule] }),
  }));
  assert.deepEqual(reloaded, [10]);

  // Policy removed (unblocked) -> no reloads, enforcement state cleared.
  await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [] }),
  }));
  assert.deepEqual(reloaded, [10]);

  // Policy re-enabled -> open YouTube tab is transitioned to blocked state again.
  await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [youtubeRule] }),
  }));
  assert.deepEqual(reloaded, [10, 10]);
});

test('isolates tab reload errors and retries failed tabs on the next policy sync', async () => {
  let installedRules = [];
  const reloaded = [];
  let failFirstTabOnce = true;
  const chromeApi = createChrome();
  chromeApi.declarativeNetRequest.getDynamicRules = async () => installedRules;
  chromeApi.declarativeNetRequest.updateDynamicRules = async (update) => {
    installedRules = update.addRules;
  };
  chromeApi.tabs = {
    async query() {
      return [
        { id: 21, url: 'https://www.youtube.com/watch?v=1' },
        { id: 22, url: 'https://m.youtube.com/watch?v=2' },
      ];
    },
    async reload(tabId) {
      if (tabId === 21 && failFirstTabOnce) {
        failFirstTabOnce = false;
        throw new Error('Tab is temporarily busy');
      }
      reloaded.push(tabId);
    },
  };

  const youtubeRule = {
    id: 1,
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
    action: { type: 'block' },
  };

  const first = await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [youtubeRule] }),
  }));
  assert.deepEqual(first, { updated: true, count: 1 });
  assert.deepEqual(reloaded, [22]);

  // Next sync retries only tab 21 (which failed previously) and skips tab 22 (already enforced).
  const second = await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [youtubeRule] }),
  }));
  assert.deepEqual(second, { updated: true, count: 1 });
  assert.deepEqual(reloaded, [22, 21]);
});

test('enforces open YouTube tab with bypassCache when DNR rule was already installed before extension startup', async () => {
  const existingYoutubeRule = {
    id: 1,
    priority: 1,
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
    action: { type: 'block' },
  };
  const reloadCalls = [];
  const chromeApi = createChrome([existingYoutubeRule]);
  chromeApi.tabs = {
    async query() {
      return [{ id: 31, url: 'https://www.youtube.com/watch?v=already-open' }];
    },
    async reload(tabId, options) {
      reloadCalls.push({ tabId, options });
    },
  };

  await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [existingYoutubeRule] }),
  }));

  assert.deepEqual(reloadCalls, [{ tabId: 31, options: { bypassCache: true } }]);

  // Subsequent sync does not reload again.
  await syncBlockingRules(chromeApi, async () => ({
    ok: true,
    json: async () => ({ rules: [existingYoutubeRule] }),
  }));
  assert.equal(reloadCalls.length, 1);
});

test('preserves enforcement across MV3 service-worker restarts and re-enforces after extension/browser restart', async () => {
  const youtubeRule = {
    id: 1,
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
    action: { type: 'block' },
  };
  const persistedStorage = {
    dp_device_id: 'device-1',
    dp_device_secret: 'secret-1',
    dp_settings: { backendUrl: 'http://127.0.0.1:3001' },
  };
  let installedRules = [youtubeRule];
  const tabs = [{ id: 41, url: 'https://www.youtube.com/watch?v=persisted' }];
  const reloads = [];

  function createWorkerChromeInstance() {
    return {
      storage: {
        local: {
          async get(keys) {
            if (!Array.isArray(keys)) return structuredClone(persistedStorage);
            return Object.fromEntries(keys.filter((k) => k in persistedStorage).map((k) => [k, structuredClone(persistedStorage[k])]));
          },
          async set(values) {
            Object.assign(persistedStorage, structuredClone(values));
          },
        },
      },
      declarativeNetRequest: {
        async getDynamicRules() {
          return installedRules;
        },
        async updateDynamicRules(update) {
          installedRules = update.addRules;
        },
      },
      tabs: {
        async query() {
          return tabs;
        },
        async reload(tabId, options) {
          reloads.push({ tabId, options });
        },
      },
    };
  }

  // Worker instance #1 enforces Tab 41 and persists state in chrome.storage.local.
  const worker1 = createWorkerChromeInstance();
  await syncBlockingRules(worker1, async () => ({ ok: true, json: async () => ({ rules: [youtubeRule] }) }));
  assert.equal(reloads.length, 1);
  assert.ok(persistedStorage[ENFORCED_TABS_STORAGE_KEY]?.[41]);

  // Worker instance #2 wakes up on alarm (MV3 service-worker restart):
  // Tab 41 is already enforced -> no reload loop; newly opened Tab 42 IS enforced.
  tabs.push({ id: 42, url: 'https://www.youtube.com/shorts/new-tab' });
  const worker2 = createWorkerChromeInstance();
  await syncBlockingRules(worker2, async () => ({ ok: true, json: async () => ({ rules: [youtubeRule] }) }));
  assert.deepEqual(reloads.map((r) => r.tabId), [41, 42]);

  // Browser restart / extension reload clears persisted tab state and re-enforces open restricted tabs.
  const worker3 = createWorkerChromeInstance();
  await clearBlockedTabEnforcementState(worker3);
  await syncBlockingRules(worker3, async () => ({ ok: true, json: async () => ({ rules: [youtubeRule] }) }));
  assert.deepEqual(reloads.map((r) => r.tabId), [41, 42, 41, 42]);
});

test('handles YouTube service-worker-controlled navigation with bypassCache without reload loops', async () => {
  const youtubeRule = {
    id: 1,
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
    action: { type: 'block' },
  };
  const reloads = [];
  const tabs = [{ id: 51, url: 'https://www.youtube.com/watch?v=sw-cached' }];
  const chromeApi = createChrome([youtubeRule]);
  chromeApi.tabs = {
    async query() {
      return tabs;
    },
    async reload(tabId, options) {
      reloads.push({ tabId, options });
    },
  };

  // Suppose Tab 51 was previously marked blocked at root URL, then user navigates via YouTube Service Worker / SPA.
  await markTabBlockedByDnr(chromeApi, {
    tabId: 51,
    frameId: 0,
    url: 'https://www.youtube.com/',
    error: 'net::ERR_BLOCKED_BY_CLIENT',
  });

  // Service worker serves cached YouTube watch page without network error -> onCompleted / onHistoryStateUpdated fires.
  const navResult = await handleBlockedNavigationCompleted(chromeApi, {
    tabId: 51,
    frameId: 0,
    url: 'https://www.youtube.com/watch?v=sw-cached',
  });
  assert.deepEqual(navResult.reloadedTabIds, [51]);
  assert.deepEqual(reloads, [{ tabId: 51, options: { bypassCache: true } }]);

  // Completion of the bypassCache reload itself is consumed without triggering a second reload.
  const followUp = await handleBlockedNavigationCompleted(chromeApi, {
    tabId: 51,
    frameId: 0,
    url: 'https://www.youtube.com/watch?v=sw-cached',
  });
  assert.deepEqual(followUp.reloadedTabIds, []);
  assert.equal(reloads.length, 1);

  // Subsequent periodic sync also does not reload the blocked tab.
  await enforceBlockedTabs(chromeApi, [youtubeRule]);
  assert.equal(reloads.length, 1);
});

test('reconciles open tabs against installed DNR rules even when backend fetch fails', async () => {
  const youtubeRule = {
    id: 1,
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
    action: { type: 'block' },
  };
  const reloads = [];
  const chromeApi = createChrome([youtubeRule]);
  chromeApi.tabs = {
    async query() {
      return [{ id: 61, url: 'https://www.youtube.com/watch?v=offline' }];
    },
    async reload(tabId, options) {
      reloads.push({ tabId, options });
    },
  };

  const httpFailure = await syncBlockingRules(chromeApi, async () => ({ ok: false, status: 503 }));
  assert.deepEqual(httpFailure, { updated: false, reason: 'backend-503' });
  assert.deepEqual(chromeApi.updates, []);
  assert.deepEqual(reloads, [{ tabId: 61, options: { bypassCache: true } }]);
});

test('domain and exclusion matching respects DNR semantics and rejects lookalike domains', () => {
  const rule = {
    id: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: '||youtube.com',
      resourceTypes: ['main_frame'],
      excludedRequestDomains: ['music.youtube.com'],
    },
  };

  assert.equal(doesRuleBlockUrl(rule, 'https://youtube.com/'), true);
  assert.equal(doesRuleBlockUrl(rule, 'https://www.youtube.com/watch?v=123'), true);
  assert.equal(doesRuleBlockUrl(rule, 'https://m.youtube.com/shorts/abc'), true);
  assert.equal(doesRuleBlockUrl(rule, 'https://music.youtube.com/watch?v=123'), false);
  assert.equal(doesRuleBlockUrl(rule, 'https://sub.music.youtube.com/'), false);
  assert.equal(doesRuleBlockUrl(rule, 'https://notyoutube.com/'), false);
  assert.equal(doesRuleBlockUrl(rule, 'https://youtube.com.attacker.example/'), false);
  assert.equal(doesRuleBlockUrl(rule, 'https://example.com/?next=https://youtube.com'), false);
  assert.equal(doesRuleBlockUrl(rule, 'chrome://extensions'), false);

  const subFrameOnlyRule = {
    id: 2,
    action: { type: 'block' },
    condition: { urlFilter: '||youtube.com', resourceTypes: ['sub_frame'] },
  };
  assert.equal(doesRuleBlockUrl(subFrameOnlyRule, 'https://www.youtube.com/'), false);

  const excludedMainFrameRule = {
    id: 3,
    action: { type: 'block' },
    condition: { urlFilter: '||youtube.com', excludedResourceTypes: ['main_frame'] },
  };
  assert.equal(doesRuleBlockUrl(excludedMainFrameRule, 'https://www.youtube.com/'), false);
});

test('transitions Service Worker-controlled YouTube tab to extension-owned blocked page and restores on unblock without redirect loops', async () => {
  const youtubeRule = {
    id: 501,
    action: { type: 'block' },
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
  };
  let dynamicRules = [youtubeRule];
  const tabState = {
    id: 77,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'complete',
  };
  const updatedTabs = [];
  const reloadedTabs = [];

  const chromeApi = {
    runtime: {
      getURL(path) {
        return `chrome-extension://abcdefghijklmnop/${path}`;
      },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return dynamicRules;
      },
    },
    tabs: {
      async query() {
        return [{ ...tabState }];
      },
      async update(tabId, props) {
        updatedTabs.push({ tabId, props });
        if (props.url) tabState.url = props.url;
        return { ...tabState };
      },
      async reload(tabId, props) {
        reloadedTabs.push({ tabId, props });
      },
    },
  };

  // 1. Open or Service-Worker-served YouTube tab is transitioned to extension-owned blocked page
  const firstEnforcement = await enforceBlockedTabs(chromeApi);
  assert.deepEqual(firstEnforcement.transitionedTabIds, [77]);
  assert.equal(updatedTabs.length, 1);
  assert.equal(reloadedTabs.length, 0);
  assert.match(updatedTabs[0].props.url, /^chrome-extension:\/\/abcdefghijklmnop\/popup\/blocked\.html\?/);
  assert.equal(
    extractOriginalUrlFromBlockedPage(chromeApi, tabState.url),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  assert.equal(await isUrlBlockedByCurrentRules(chromeApi, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);

  // 2. Repeated enforcement while on popup/blocked.html does not cause a redirect loop
  const secondEnforcement = await enforceBlockedTabs(chromeApi);
  assert.deepEqual(secondEnforcement.transitionedTabIds, []);
  assert.deepEqual(secondEnforcement.restoredTabIds, []);
  assert.equal(updatedTabs.length, 1);

  // 3. Removing the YouTube policy restores the blocked tab to the original YouTube URL
  dynamicRules = [];
  assert.equal(await isUrlBlockedByCurrentRules(chromeApi, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
  const unblockEnforcement = await enforceBlockedTabs(chromeApi, []);
  assert.deepEqual(unblockEnforcement.restoredTabIds, [77]);
  assert.equal(tabState.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  // 4. Re-enabling the policy transitions the YouTube tab back to the blocked page immediately
  dynamicRules = [youtubeRule];
  const reblockEnforcement = await enforceBlockedTabs(chromeApi, [youtubeRule]);
  assert.deepEqual(reblockEnforcement.transitionedTabIds, [77]);
  assert.match(tabState.url, /^chrome-extension:\/\/abcdefghijklmnop\/popup\/blocked\.html\?/);
});

test('handleTabLoading + handleBlockedNavigationCompleted intercepts YouTube Service Worker cached navigation', async () => {
  const youtubeRule = {
    id: 601,
    action: { type: 'block' },
    condition: { urlFilter: '||youtube.com', resourceTypes: ['main_frame'] },
  };
  const tabState = {
    id: 88,
    url: 'https://www.youtube.com/',
    status: 'complete',
  };
  const updatedTabs = [];

  const chromeApi = {
    runtime: {
      getURL(path) {
        return `chrome-extension://abcdefghijklmnop/${path}`;
      },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return [youtubeRule];
      },
    },
    tabs: {
      async query() {
        return [{ ...tabState }];
      },
      async update(tabId, props) {
        updatedTabs.push({ tabId, props });
        if (props.url) tabState.url = props.url;
        return { ...tabState };
      },
      async reload() {},
    },
  };

  // Suppose tab 88 previously had a native DNR block recorded
  await markTabBlockedByDnr(chromeApi, {
    tabId: 88,
    frameId: 0,
    url: 'https://www.youtube.com/',
    error: 'net::ERR_BLOCKED_BY_CLIENT',
  });

  // User navigates to https://www.youtube.com/ again; YouTube's sw.js intercepts
  // the fetch and serves cached HTML (200 OK from Service Worker) without firing onErrorOccurred.
  await handleTabLoading(chromeApi, 88, { status: 'loading' }, tabState);
  const completionResult = await handleBlockedNavigationCompleted(chromeApi, {
    tabId: 88,
    frameId: 0,
    url: 'https://www.youtube.com/',
  });

  assert.deepEqual(completionResult.transitionedTabIds, [88]);
  assert.equal(updatedTabs.length, 1);
  assert.equal(
    updatedTabs[0].props.url,
    buildBlockedPageUrl(chromeApi, 'https://www.youtube.com/', [youtubeRule]),
  );
});
