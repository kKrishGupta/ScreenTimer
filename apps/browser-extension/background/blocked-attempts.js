import { CONFIG } from '../shared/constants.js';
import { resolveBackendUrl } from '../shared/backend-settings.js';

let pending = Promise.resolve();
function serialize(task) { const result = pending.then(task); pending = result.catch(() => {}); return result; }

export function recordBlockedAttempt(details, chromeApi = globalThis.chrome) {
  return serialize(async () => {
    if (details.frameId !== 0 || details.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
    let url;
    try { url = new URL(details.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const domain = url.hostname.toLowerCase();
    const rules = await chromeApi.declarativeNetRequest.getDynamicRules();
    const matched = rules.some((rule) => {
      const filter = rule.condition?.urlFilter;
      if (rule.action?.type !== 'block' || !filter?.startsWith('||')) return false;
      const host = filter.slice(2).replace(/\^$/, '');
      return domain === host || domain.endsWith(`.${host}`);
    });
    if (!matched) return;
    const stored = await chromeApi.storage.local.get(['dp_blocked_attempts', CONFIG.DEVICE_STORAGE_KEY, 'dp_device_secret']);
    if (!stored.dp_device_secret) return;
    const queue = stored.dp_blocked_attempts || [];
    if (queue.some((event) => event.domain === domain && Date.now() - event.at < 5000)) return;
    queue.push({ eventId: crypto.randomUUID(), deviceId: stored[CONFIG.DEVICE_STORAGE_KEY], domain, at: Date.now() });
    await chromeApi.storage.local.set({ dp_blocked_attempts: queue.slice(-100) });
  });
}

export function flushBlockedAttempts(chromeApi = globalThis.chrome, fetchImpl = globalThis.fetch) {
  return serialize(async () => {
    const stored = await chromeApi.storage.local.get([CONFIG.SETTINGS_STORAGE_KEY, CONFIG.SYNC_QUEUE_STORAGE_KEY, 'dp_device_secret', 'dp_blocked_attempts']);
    if (!stored.dp_device_secret) return;
    const origin = resolveBackendUrl(stored);
    const queue = stored.dp_blocked_attempts || [];
    while (queue.length) {
      const { at, ...event } = queue[0];
      const response = await fetchImpl(`${origin}/api/v1/policies/blocked-attempts`, {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'X-Device-Secret': stored.dp_device_secret }, body: JSON.stringify(event),
      });
      if (!response.ok && response.status !== 409) break;
      queue.shift();
      await chromeApi.storage.local.set({ dp_blocked_attempts: queue });
    }
  });
}
