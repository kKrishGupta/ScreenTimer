import { CONFIG } from '../shared/constants.js';
import { normalizeBackendUrl } from '../shared/backend-settings.js';

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
  const backendUrl = normalizeBackendUrl(stored[CONFIG.SETTINGS_STORAGE_KEY]?.backendUrl || CONFIG.DEFAULT_BACKEND_URL);
  const deviceId = stored[CONFIG.DEVICE_STORAGE_KEY];
  const deviceSecret = stored.dp_device_secret || '';
  if (!deviceId || !deviceSecret) return { updated: false, reason: 'device-not-enrolled' };

  const res = await fetchImpl(
    `${backendUrl}/api/v1/policies/declarative-rules?deviceId=${encodeURIComponent(deviceId)}`,
    { headers: { 'X-Device-Secret': deviceSecret }, redirect: 'error', signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) return { updated: false, reason: `backend-${res.status}` };

  const payload = await res.json();
  const rules = Array.isArray(payload.rules)
    ? payload.rules.filter((rule) => Number.isInteger(rule.id) && rule.condition && rule.action)
    : [];
  const existing = await chromeApi.declarativeNetRequest.getDynamicRules();
  await chromeApi.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: rules,
  });
  return { updated: true, count: rules.length };
}
