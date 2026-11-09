import { CONFIG } from '../shared/constants.js';
import { resolveBackendUrl } from '../shared/backend-settings.js';

export const ENFORCED_TABS_STORAGE_KEY = 'dp_enforced_blocked_tabs';
export const BLOCKED_PAGE_PATH = 'popup/blocked.html';

const enforcementStateByChrome = new WeakMap();

function getEnforcementState(chromeApi) {
  let state = enforcementStateByChrome.get(chromeApi);
  if (!state) {
    state = {
      hydrated: false,
      enforcedTabKeys: new Map(),
      failedTabIds: new Set(),
      activeBypassReloads: new Map(),
    };
    enforcementStateByChrome.set(chromeApi, state);
  }
  return state;
}

async function hydrateEnforcementState(chromeApi, state) {
  if (state.hydrated) return;
  state.hydrated = true;
  if (typeof chromeApi?.storage?.local?.get !== 'function') return;
  try {
    const stored = await chromeApi.storage.local.get([ENFORCED_TABS_STORAGE_KEY]);
    const persisted = stored?.[ENFORCED_TABS_STORAGE_KEY];
    if (persisted && typeof persisted === 'object') {
      for (const [rawTabId, signature] of Object.entries(persisted)) {
        const tabId = Number(rawTabId);
        if (Number.isInteger(tabId) && tabId >= 0 && typeof signature === 'string' && !state.enforcedTabKeys.has(tabId)) {
          state.enforcedTabKeys.set(tabId, signature);
        }
      }
    }
  } catch {
    // Best-effort storage hydration; in-memory state remains active.
  }
}

async function persistEnforcementState(chromeApi, state) {
  if (typeof chromeApi?.storage?.local?.set !== 'function') return;
  try {
    const serialized = Object.fromEntries(state.enforcedTabKeys.entries());
    await chromeApi.storage.local.set({ [ENFORCED_TABS_STORAGE_KEY]: serialized });
  } catch {
    // Best-effort storage persistence.
  }
}

export async function clearBlockedTabEnforcementState(chromeApi = globalThis.chrome) {
  if (!chromeApi) return;
  const state = getEnforcementState(chromeApi);
  state.hydrated = true;
  state.enforcedTabKeys.clear();
  state.failedTabIds.clear();
  state.activeBypassReloads.clear();
  await persistEnforcementState(chromeApi, state);
}

function normalizeDomainPattern(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/^\.+|\.+$/g, '');
}

export function getBlockingRuleKey(rule) {
  if (!rule || rule.action?.type !== 'block' || !rule.condition) return null;
  const { resourceTypes, excludedResourceTypes, urlFilter, requestDomains, domains, excludedRequestDomains, excludedDomains } = rule.condition;
  if (Array.isArray(resourceTypes) && !resourceTypes.includes('main_frame')) return null;
  if (Array.isArray(excludedResourceTypes) && excludedResourceTypes.includes('main_frame')) return null;

  const exclusions = [
    ...(Array.isArray(excludedRequestDomains) ? excludedRequestDomains : []),
    ...(Array.isArray(excludedDomains) ? excludedDomains : []),
  ]
    .map(normalizeDomainPattern)
    .filter(Boolean)
    .sort();
  const exclusionSuffix = exclusions.length ? `!${exclusions.join(',')}` : '';

  if (typeof urlFilter === 'string' && urlFilter.trim()) {
    return `filter:${urlFilter.trim().toLowerCase()}${exclusionSuffix}`;
  }
  const domainList = Array.isArray(requestDomains)
    ? requestDomains
    : Array.isArray(domains)
      ? domains
      : null;
  if (domainList?.length) {
    const normalized = domainList.map(normalizeDomainPattern).filter(Boolean).sort();
    if (normalized.length) return `domains:${normalized.join(',')}${exclusionSuffix}`;
  }
  return Number.isInteger(rule.id) ? `id:${rule.id}${exclusionSuffix}` : null;
}

export function doesRuleBlockUrl(rule, rawUrl) {
  if (!rule || rule.action?.type !== 'block' || !rule.condition) return false;
  const {
    resourceTypes,
    excludedResourceTypes,
    urlFilter,
    requestDomains,
    domains,
    excludedRequestDomains,
    excludedDomains,
  } = rule.condition;
  if (Array.isArray(resourceTypes) && !resourceTypes.includes('main_frame')) return false;
  if (Array.isArray(excludedResourceTypes) && excludedResourceTypes.includes('main_frame')) return false;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();

  const exclusions = [
    ...(Array.isArray(excludedRequestDomains) ? excludedRequestDomains : []),
    ...(Array.isArray(excludedDomains) ? excludedDomains : []),
  ];
  for (const excluded of exclusions) {
    const cleanExcluded = normalizeDomainPattern(excluded);
    if (cleanExcluded && (hostname === cleanExcluded || hostname.endsWith(`.${cleanExcluded}`))) {
      return false;
    }
  }

  const domainList = [
    ...(Array.isArray(requestDomains) ? requestDomains : []),
    ...(Array.isArray(domains) ? domains : []),
  ];
  for (const domain of domainList) {
    const cleanDomain = normalizeDomainPattern(domain);
    if (cleanDomain && (hostname === cleanDomain || hostname.endsWith(`.${cleanDomain}`))) {
      return true;
    }
  }

  if (typeof urlFilter === 'string' && urlFilter.startsWith('||')) {
    const withoutAnchor = urlFilter.slice(2).replace(/\^$/, '');
    const slashIndex = withoutAnchor.indexOf('/');
    const hostPart = (slashIndex === -1 ? withoutAnchor : withoutAnchor.slice(0, slashIndex))
      .replace(/\^$/, '')
      .split(':')[0]
      .trim();
    const cleanHost = normalizeDomainPattern(hostPart);
    const pathPrefix = slashIndex === -1 ? '' : withoutAnchor.slice(slashIndex).replace(/\^$/, '');
    const hostMatches = Boolean(cleanHost) && (hostname === cleanHost || hostname.endsWith(`.${cleanHost}`));
    const pathMatches = !pathPrefix || `${parsed.pathname}${parsed.search}`.startsWith(pathPrefix);
    return hostMatches && pathMatches;
  }

  return false;
}

async function findMatchingBlockingRules(chromeApi, activeBlockingRules, tabUrl) {
  const matched = [];
  const fallbackCandidates = [];

  for (const rule of activeBlockingRules) {
    if (doesRuleBlockUrl(rule, tabUrl)) {
      matched.push(rule);
    } else if (
      typeof rule.condition?.urlFilter === 'string' &&
      !rule.condition.urlFilter.startsWith('||') &&
      typeof chromeApi?.declarativeNetRequest?.testMatchOutcome === 'function'
    ) {
      fallbackCandidates.push(rule);
    }
  }

  if (fallbackCandidates.length > 0) {
    try {
      const outcome = await chromeApi.declarativeNetRequest.testMatchOutcome({
        url: tabUrl,
        type: 'main_frame',
      });
      const matchedIds = new Set((outcome?.matchedRules || []).map((r) => r.ruleId));
      for (const candidate of fallbackCandidates) {
        if (matchedIds.has(candidate.id)) matched.push(candidate);
      }
    } catch {
      // Ignore optional testMatchOutcome errors when feedback permission is absent.
    }
  }

  return matched;
}

function buildEnforcementKey(tabUrl, matchingRules) {
  const ruleSignature = matchingRules.map(getBlockingRuleKey).filter(Boolean).sort().join('\n');
  return `${tabUrl}\n\n${ruleSignature}`;
}

function describePolicyRule(matchingRules, fallbackDomain) {
  for (const rule of matchingRules || []) {
    const cond = rule?.condition || {};
    if (typeof cond.urlFilter === 'string' && cond.urlFilter.trim()) {
      return cond.urlFilter.trim().replace(/^\|\|/, '').replace(/\^$/, '');
    }
    const domainList = Array.isArray(cond.requestDomains)
      ? cond.requestDomains
      : Array.isArray(cond.domains)
        ? cond.domains
        : [];
    if (domainList.length > 0) {
      return normalizeDomainPattern(domainList[0]) || fallbackDomain;
    }
  }
  return fallbackDomain || 'Organization website policy';
}

export function buildBlockedPageUrl(chromeApi, rawUrl, matchingRules = []) {
  if (typeof chromeApi?.runtime?.getURL !== 'function') return null;
  let baseUrl;
  try {
    baseUrl = chromeApi.runtime.getURL(BLOCKED_PAGE_PATH);
  } catch {
    return null;
  }
  if (!baseUrl || typeof baseUrl !== 'string') return null;

  let domain = '';
  try {
    domain = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    domain = '';
  }
  const policyLabel = describePolicyRule(matchingRules, domain);
  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  if (policyLabel) params.set('policy', policyLabel);
  if (rawUrl) params.set('url', rawUrl);
  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

export function extractOriginalUrlFromBlockedPage(chromeApi, rawTabUrl) {
  if (!rawTabUrl || typeof rawTabUrl !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(rawTabUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'chrome-extension:' && parsed.protocol !== 'extension:') {
    return null;
  }
  if (typeof chromeApi?.runtime?.getURL === 'function') {
    try {
      const expectedBase = new URL(chromeApi.runtime.getURL(BLOCKED_PAGE_PATH));
      if (parsed.origin !== expectedBase.origin || parsed.pathname !== expectedBase.pathname) {
        return null;
      }
    } catch {
      if (!parsed.pathname.endsWith(`/${BLOCKED_PAGE_PATH}`)) return null;
    }
  } else if (!parsed.pathname.endsWith(`/${BLOCKED_PAGE_PATH}`)) {
    return null;
  }

  const original = parsed.searchParams.get('url');
  if (!original || !/^https?:\/\//i.test(original)) return null;
  return original;
}

export async function isUrlBlockedByCurrentRules(chromeApi, rawUrl, rules = null) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false;
  let effectiveRules = rules;
  if (!Array.isArray(effectiveRules)) {
    if (typeof chromeApi?.declarativeNetRequest?.getDynamicRules !== 'function') {
      return false;
    }
    effectiveRules = await chromeApi.declarativeNetRequest.getDynamicRules();
  }
  const activeBlockingRules = effectiveRules.filter((rule) => getBlockingRuleKey(rule) !== null);
  if (activeBlockingRules.length === 0) return false;
  const matched = await findMatchingBlockingRules(chromeApi, activeBlockingRules, rawUrl);
  return matched.length > 0;
}

/**
 * Reconciles open tabs against active DNR blocking rules.
 * When a tab is still displaying restricted content (already-open tab, tab
 * activation, or Service Worker cached shell such as YouTube's sw.js),
 * transitions the tab to the extension-owned blocked page (`popup/blocked.html`)
 * so the site's Service Worker cannot intercept the navigation, falling back to
 * `tabs.reload(tabId, { bypassCache: true })` when `tabs.update`/`runtime.getURL`
 * are unavailable. Also restores open extension blocked pages when a policy is
 * removed.
 */
export async function enforceBlockedTabs(chromeApi, rules = null) {
  const canUpdateTab = typeof chromeApi?.tabs?.update === 'function' && typeof chromeApi?.runtime?.getURL === 'function';
  const canReloadTab = typeof chromeApi?.tabs?.reload === 'function';
  if (!chromeApi?.tabs?.query || (!canUpdateTab && !canReloadTab)) {
    return { reloadedTabIds: [], transitionedTabIds: [], restoredTabIds: [], failedTabIds: [] };
  }

  const state = getEnforcementState(chromeApi);
  await hydrateEnforcementState(chromeApi, state);

  let effectiveRules = rules;
  if (!Array.isArray(effectiveRules)) {
    if (typeof chromeApi?.declarativeNetRequest?.getDynamicRules !== 'function') {
      return { reloadedTabIds: [], transitionedTabIds: [], restoredTabIds: [], failedTabIds: [] };
    }
    effectiveRules = await chromeApi.declarativeNetRequest.getDynamicRules();
  }

  const activeBlockingRules = effectiveRules.filter((rule) => getBlockingRuleKey(rule) !== null);
  const activeRuleKeys = new Set(activeBlockingRules.map(getBlockingRuleKey).filter(Boolean));
  let stateChanged = false;

  if (activeBlockingRules.length === 0) {
    if (state.enforcedTabKeys.size > 0) {
      state.enforcedTabKeys.clear();
      stateChanged = true;
    }
    state.failedTabIds.clear();
    state.activeBypassReloads.clear();
  } else {
    for (const [tabId, signature] of state.enforcedTabKeys.entries()) {
      const [, ruleSignature = ''] = String(signature).split('\n\n');
      const keys = ruleSignature.split('\n').filter(Boolean);
      if (!keys.some((key) => activeRuleKeys.has(key))) {
        state.enforcedTabKeys.delete(tabId);
        state.activeBypassReloads.delete(tabId);
        stateChanged = true;
      }
    }
  }

  if (activeBlockingRules.length === 0 && !canUpdateTab) {
    if (stateChanged) await persistEnforcementState(chromeApi, state);
    return { reloadedTabIds: [], transitionedTabIds: [], restoredTabIds: [], failedTabIds: [] };
  }

  let tabs = [];
  try {
    tabs = await chromeApi.tabs.query({});
  } catch {
    if (stateChanged) await persistEnforcementState(chromeApi, state);
    return { reloadedTabIds: [], transitionedTabIds: [], restoredTabIds: [], failedTabIds: [] };
  }

  const openTabIds = new Set();
  const reloadedTabIds = [];
  const transitionedTabIds = [];
  const restoredTabIds = [];
  const failedTabIds = [];

  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!Number.isInteger(tab?.id) || tab.id < 0) continue;
    openTabIds.add(tab.id);

    const tabUrl = tab.url || tab.pendingUrl || '';
    const originalBlockedUrl = extractOriginalUrlFromBlockedPage(chromeApi, tabUrl);
    if (originalBlockedUrl) {
      const stillBlockedRules =
        activeBlockingRules.length > 0
          ? await findMatchingBlockingRules(chromeApi, activeBlockingRules, originalBlockedUrl)
          : [];
      if (stillBlockedRules.length === 0 && canUpdateTab) {
        try {
          await chromeApi.tabs.update(tab.id, { url: originalBlockedUrl });
          restoredTabIds.push(tab.id);
        } catch {
          // Best-effort tab restoration after policy removal.
        }
      }
      if (state.enforcedTabKeys.delete(tab.id)) stateChanged = true;
      state.failedTabIds.delete(tab.id);
      state.activeBypassReloads.delete(tab.id);
      continue;
    }

    if (!/^https?:\/\//i.test(tabUrl)) {
      if (state.enforcedTabKeys.delete(tab.id)) stateChanged = true;
      state.failedTabIds.delete(tab.id);
      state.activeBypassReloads.delete(tab.id);
      continue;
    }

    if (activeBlockingRules.length === 0) {
      if (state.enforcedTabKeys.delete(tab.id)) stateChanged = true;
      state.failedTabIds.delete(tab.id);
      state.activeBypassReloads.delete(tab.id);
      continue;
    }

    const matchingRules = await findMatchingBlockingRules(chromeApi, activeBlockingRules, tabUrl);
    if (matchingRules.length === 0) {
      if (state.enforcedTabKeys.delete(tab.id)) stateChanged = true;
      state.failedTabIds.delete(tab.id);
      state.activeBypassReloads.delete(tab.id);
      continue;
    }

    const enforcementKey = buildEnforcementKey(tabUrl, matchingRules);
    const alreadyEnforced = state.enforcedTabKeys.get(tab.id) === enforcementKey && !state.failedTabIds.has(tab.id);

    if (!alreadyEnforced) {
      try {
        const blockedPageUrl = canUpdateTab ? buildBlockedPageUrl(chromeApi, tabUrl, matchingRules) : null;
        if (blockedPageUrl && typeof chromeApi.tabs?.update === 'function') {
          state.activeBypassReloads.delete(tab.id);
          await chromeApi.tabs.update(tab.id, { url: blockedPageUrl });
          transitionedTabIds.push(tab.id);
        } else {
          state.activeBypassReloads.set(tab.id, enforcementKey);
          await chromeApi.tabs.reload(tab.id, { bypassCache: true });
        }
        state.enforcedTabKeys.set(tab.id, enforcementKey);
        state.failedTabIds.delete(tab.id);
        stateChanged = true;
        reloadedTabIds.push(tab.id);
      } catch {
        state.activeBypassReloads.delete(tab.id);
        state.enforcedTabKeys.delete(tab.id);
        state.failedTabIds.add(tab.id);
        failedTabIds.push(tab.id);
      }
    }
  }

  for (const trackedTabId of [...state.enforcedTabKeys.keys()]) {
    if (!openTabIds.has(trackedTabId)) {
      state.enforcedTabKeys.delete(trackedTabId);
      state.activeBypassReloads.delete(trackedTabId);
      stateChanged = true;
    }
  }
  for (const failedTabId of [...state.failedTabIds]) {
    if (!openTabIds.has(failedTabId)) state.failedTabIds.delete(failedTabId);
  }

  if (stateChanged) {
    await persistEnforcementState(chromeApi, state);
  }

  return { reloadedTabIds, transitionedTabIds, restoredTabIds, failedTabIds };
}

/**
 * Clears any stale enforcement marker when a tab starts a fresh navigation so
 * that if a website's Service Worker serves cached content instead of failing
 * with `net::ERR_BLOCKED_BY_CLIENT`, completion handlers immediately transition
 * the tab to the extension-owned blocked page.
 */
export async function handleTabLoading(chromeApi, tabId, changeInfo, tab) {
  if (!chromeApi || changeInfo?.status !== 'loading') return;
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const candidateUrl = changeInfo.url || tab?.url || tab?.pendingUrl || '';
  if (extractOriginalUrlFromBlockedPage(chromeApi, candidateUrl)) return;

  const state = getEnforcementState(chromeApi);
  await hydrateEnforcementState(chromeApi, state);
  if (state.activeBypassReloads.has(tabId)) return;

  if (state.enforcedTabKeys.delete(tabId)) {
    await persistEnforcementState(chromeApi, state);
  }
}

/**
 * Records that Chrome's DNR engine blocked a top-frame navigation natively so
 * follow-up tab events do not trigger a redundant reload.
 */
export async function markTabBlockedByDnr(chromeApi, details) {
  if (!chromeApi || details?.frameId !== 0 || details?.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
  const tabId = details.tabId;
  if (!Number.isInteger(tabId) || tabId < 0 || !/^https?:\/\//i.test(details.url || '')) return;

  const state = getEnforcementState(chromeApi);
  await hydrateEnforcementState(chromeApi, state);
  state.activeBypassReloads.delete(tabId);
  state.failedTabIds.delete(tabId);

  if (typeof chromeApi?.declarativeNetRequest?.getDynamicRules !== 'function') return;
  const rules = await chromeApi.declarativeNetRequest.getDynamicRules();
  const activeBlockingRules = rules.filter((rule) => getBlockingRuleKey(rule) !== null);
  const matchingRules = await findMatchingBlockingRules(chromeApi, activeBlockingRules, details.url);
  if (matchingRules.length === 0) return;

  const enforcementKey = buildEnforcementKey(details.url, matchingRules);
  if (state.enforcedTabKeys.get(tabId) !== enforcementKey) {
    state.enforcedTabKeys.set(tabId, enforcementKey);
    await persistEnforcementState(chromeApi, state);
  }
}

/**
 * Handles top-frame navigations that completed without `net::ERR_BLOCKED_BY_CLIENT`
 * (for example when a site's Service Worker serves cached HTML or performs an SPA
 * pushState navigation on a restricted domain) and forces a cache-bypassing reload.
 */
export async function handleBlockedNavigationCompleted(chromeApi, details) {
  if (!chromeApi || (details?.frameId !== undefined && details.frameId !== 0)) {
    return { reloadedTabIds: [], failedTabIds: [] };
  }
  const tabId = details?.tabId;
  const url = details?.url || '';
  if (!Number.isInteger(tabId) || tabId < 0 || !/^https?:\/\//i.test(url)) {
    return { reloadedTabIds: [], failedTabIds: [] };
  }

  const state = getEnforcementState(chromeApi);
  await hydrateEnforcementState(chromeApi, state);

  // If this completion event belongs to the bypassCache reload we just issued,
  // consume the in-flight marker without re-reloading the tab.
  if (state.activeBypassReloads.has(tabId)) {
    state.activeBypassReloads.delete(tabId);
    return { reloadedTabIds: [], failedTabIds: [] };
  }

  if (typeof chromeApi?.declarativeNetRequest?.getDynamicRules !== 'function') {
    return { reloadedTabIds: [], failedTabIds: [] };
  }
  const rules = await chromeApi.declarativeNetRequest.getDynamicRules();
  const activeBlockingRules = rules.filter((rule) => getBlockingRuleKey(rule) !== null);
  const matchingRules = await findMatchingBlockingRules(chromeApi, activeBlockingRules, url);
  if (matchingRules.length === 0) {
    if (state.enforcedTabKeys.delete(tabId)) {
      await persistEnforcementState(chromeApi, state);
    }
    return { reloadedTabIds: [], failedTabIds: [] };
  }

  // The page completed loading a restricted URL (e.g. via Service Worker cache
  // or SPA navigation) instead of failing with ERR_BLOCKED_BY_CLIENT.
  state.enforcedTabKeys.delete(tabId);
  return enforceBlockedTabs(chromeApi, rules);
}

/**
 * Replaces the extension's dynamic rules with the authenticated device policy.
 * Removing all existing rules first prevents deleted or expired policies from
 * remaining active after a backend update.
 */
export async function syncBlockingRules(chromeApi = globalThis.chrome, fetchImpl = globalThis.fetch) {
  if (!chromeApi?.declarativeNetRequest?.updateDynamicRules) return { updated: false, reason: 'unsupported' };

  const stored = await chromeApi.storage.local.get([
    CONFIG.SETTINGS_STORAGE_KEY,
    CONFIG.DEVICE_STORAGE_KEY,
    'dp_device_secret',
  ]);
  const backendUrl = resolveBackendUrl(stored);
  const deviceId = stored[CONFIG.DEVICE_STORAGE_KEY];
  const deviceSecret = stored.dp_device_secret || '';
  if (!deviceId || !deviceSecret) return { updated: false, reason: 'device-not-enrolled' };

  const existing = await chromeApi.declarativeNetRequest.getDynamicRules();

  let res;
  try {
    res = await fetchImpl(
      `${backendUrl}/api/v1/policies/declarative-rules?deviceId=${encodeURIComponent(deviceId)}`,
      { headers: { 'X-Device-Secret': deviceSecret }, redirect: 'error', signal: AbortSignal.timeout(10000) },
    );
  } catch (error) {
    await enforceBlockedTabs(chromeApi, existing);
    throw error;
  }

  if (!res.ok) {
    await enforceBlockedTabs(chromeApi, existing);
    return { updated: false, reason: `backend-${res.status}` };
  }

  const payload = await res.json();
  if (!Array.isArray(payload.rules)) {
    await enforceBlockedTabs(chromeApi, existing);
    return { updated: false, reason: 'invalid-policy-response' };
  }
  const rules = payload.rules
    .filter((rule) => Number.isInteger(rule.id) && rule.condition && rule.action)
    .map((rule) => ({
      ...rule,
      // Redirects require permission for each intercepted website. Native
      // blocks work with declarativeNetRequest without broad host access.
      action: rule.action.type === 'redirect' ? { type: 'block' } : rule.action,
    }));

  await chromeApi.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: rules,
  });
  await enforceBlockedTabs(chromeApi, rules);
  return { updated: true, count: rules.length };
}

export async function syncBlockingRulesWithStatus(chromeApi = globalThis.chrome, fetchImpl = globalThis.fetch) {
  let result;
  try {
    result = await syncBlockingRules(chromeApi, fetchImpl);
  } catch (error) {
    result = { updated: false, reason: error.message || 'Policy sync failed' };
  }
  await chromeApi.storage.local.set({ dp_policy_sync: { ...result, checkedAt: new Date().toISOString() } });
  return result;
}
