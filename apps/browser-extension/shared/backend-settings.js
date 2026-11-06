import { CONFIG } from './constants.js';

export function normalizeBackendUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Enter a valid backend URL.'); }
  if (url.username || url.password || url.search || url.hash || !['', '/', '/api/v1', '/api/v1/'].includes(url.pathname)) {
    throw new Error('Use the backend origin only, without credentials, a path, query, or fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Remote backends require HTTPS. HTTP is allowed only for loopback development.');
  }
  return url.origin;
}

export async function verifyBackend(value, fetchImpl = globalThis.fetch) {
  const origin = normalizeBackendUrl(value);
  const response = await fetchImpl(`${origin}/api/v1/health`, {
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000),
  });
  let health;
  try { health = await response.json(); } catch { throw new Error('This address did not return a DigitalPulse API response.'); }
  if (health.service !== 'digitalpulse-backend') throw new Error('This address is not a DigitalPulse backend.');
  if (!response.ok || health.status !== 'ok') throw new Error('Backend is reachable but not ready. Ask your administrator to check its database.');
  return origin;
}

export async function saveBackendUrl(chromeApi, value, fetchImpl = globalThis.fetch) {
  throw new Error('Server address is managed by your administrator. Rebuild the extension from the configured environment.');
}

export function resolveBackendUrl(stored, config = CONFIG) {
  const configured = normalizeBackendUrl(config.DEFAULT_BACKEND_URL);
  const previous = stored[config.SETTINGS_STORAGE_KEY]?.backendUrl || 'http://127.0.0.1:3001';
  if (previous && normalizeBackendUrl(previous) !== configured && (stored.dp_device_secret || stored[config.SYNC_QUEUE_STORAGE_KEY]?.length)) {
    throw new Error('This device belongs to a different backend. Use a fresh browser profile and enroll with your administrator.');
  }
  return configured;
}
