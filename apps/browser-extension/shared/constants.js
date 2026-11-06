import { BACKEND_URL } from './deployment.js';
// Shared constants for the browser extension
export const CONFIG = {
  DEFAULT_BACKEND_URL: BACKEND_URL,
  DEFAULT_SYNC_INTERVAL_SECS: 30,
  IDLE_THRESHOLD_SECS: 60,
  ENROLLMENT_UI_ENABLED: true,
  SCHEMA_VERSION: 1,
  DEVICE_STORAGE_KEY: 'dp_device_id',
  SYNC_QUEUE_STORAGE_KEY: 'dp_sync_queue',
  ACTIVE_SESSION_STORAGE_KEY: 'dp_active_session',
  SETTINGS_STORAGE_KEY: 'dp_settings'
};

/**
 * Extracts a normalized hostname from a URL string.
 * Returns null if the URL is not http/https or is internal/invalid.
 * Strictly domain-level only: no path, query params, or fragments.
 */
export function extractDomain(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    let host = parsed.hostname.toLowerCase().trim();
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }
    // Validate domain format
    if (!host || host === 'localhost' || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)) {
      // Localhost or direct IP addresses can either be ignored or treated as local development
      return host || null;
    }
    const knownBases = ['instagram.com', 'whatsapp.com', 'facebook.com', 'reddit.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com'];
    for (const base of knownBases) {
      if (host === base || host.endsWith('.' + base)) {
        return base;
      }
    }
    if (/^[a-z0-9.-]+$/.test(host)) {
      return host;
    }
    return null;
  } catch {
    return null;
  }
}

