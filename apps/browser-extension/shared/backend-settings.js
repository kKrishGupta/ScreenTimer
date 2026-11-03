import { CONFIG } from './constants.js';

export function normalizeBackendUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Enter a valid backend URL.'); }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use the backend origin only, without credentials, a path, query, or fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Remote backends require HTTPS. HTTP is allowed only for loopback development.');
  }
  return url.origin;
}

export async function saveBackendUrl(chromeApi, value) {
  const backendUrl = normalizeBackendUrl(value);
  // Ask for only this host, directly in the Save button's user gesture.
  if (backendUrl.startsWith('https://') && chromeApi.permissions) {
    const granted = await chromeApi.permissions.request({ origins: [`${backendUrl}/*`] });
    if (!granted) throw new Error('Backend host permission was declined. Settings were not changed.');
  }
  const stored = await chromeApi.storage.local.get([CONFIG.SETTINGS_STORAGE_KEY, CONFIG.SYNC_QUEUE_STORAGE_KEY, 'dp_device_secret']);
  const previous = normalizeBackendUrl(stored[CONFIG.SETTINGS_STORAGE_KEY]?.backendUrl || CONFIG.DEFAULT_BACKEND_URL);
  if (backendUrl !== previous && (stored.dp_device_secret || stored[CONFIG.SYNC_QUEUE_STORAGE_KEY]?.length)) {
    throw new Error('This device has credentials or pending events for its current backend. Ask your administrator to migrate it before changing hosts.');
  }
  await chromeApi.storage.local.set({ [CONFIG.SETTINGS_STORAGE_KEY]: { ...stored[CONFIG.SETTINGS_STORAGE_KEY], backendUrl } });
  return backendUrl;
}
