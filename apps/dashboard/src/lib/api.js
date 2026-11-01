// Thin API client for the local DigitalPulse backend. Requests go through the Vite proxy
// (same origin) unless VITE_API_BASE_URL is set.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
const DEFAULT_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Executes an HTTP fetch request with timeout and error wrapping.
 */
async function request(path, { method = 'GET', body, signal, acceptStatuses = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError('Cannot reach the DigitalPulse backend at 127.0.0.1:3001.', {
      code: err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const resBody = await res.json().catch(() => null);
  if (res.ok || acceptStatuses.includes(res.status)) return resBody;
  throw new ApiError(resBody?.error?.message ?? `Request failed with status ${res.status}`, {
    status: res.status,
    code: resBody?.error?.code ?? 'HTTP_ERROR',
    body: resBody,
  });
}

export function getJson(path, opts) {
  return request(path, { ...opts, method: 'GET' });
}

export function postJson(path, body, opts) {
  return request(path, { ...opts, method: 'POST', body });
}

export function deleteJson(path, opts) {
  return request(path, { ...opts, method: 'DELETE' });
}

export const api = {
  health: (opts) => getJson('/health', { ...opts, acceptStatuses: [503] }),
  summary: (params = {}, opts = {}) => {
    const q = new URLSearchParams(params).toString();
    return getJson(`/activity/summary${q ? `?${q}` : ''}`, opts);
  },
  timeline: (params = {}, opts = {}) => {
    const q = new URLSearchParams(params).toString();
    return getJson(`/activity/timeline${q ? `?${q}` : ''}`, opts);
  },
  apps: (params = {}, opts = {}) => {
    const q = new URLSearchParams(params).toString();
    return getJson(`/activity/apps${q ? `?${q}` : ''}`, opts);
  },
  websites: (params = {}, opts = {}) => {
    const q = new URLSearchParams(params).toString();
    return getJson(`/activity/websites${q ? `?${q}` : ''}`, opts);
  },
  devices: (opts = {}) => getJson('/devices', opts),

  // Screen Monitoring (Milestone 7)
  screenConfig: (opts = {}) => getJson('/screen/config', opts),
  screenCaptures: (params = {}, opts = {}) => {
    const q = new URLSearchParams(params).toString();
    return getJson(`/screen/captures${q ? `?${q}` : ''}`, opts);
  },
  postScreenConsent: (consent, opts = {}) => postJson('/screen/consent', { consent }, opts),
  postScreenState: (action, pauseMinutes, opts = {}) => postJson('/screen/state', { action, pauseMinutes }, opts),
  postScreenCapture: (applicationName, opts = {}) => postJson('/screen/capture', { applicationName }, opts),
  deleteScreenCapture: (id, opts = {}) => deleteJson(`/screen/captures/${id}`, opts),
  purgeScreenCaptures: (olderThanDays, opts = {}) => postJson('/screen/retention/purge', { olderThanDays }, opts),
  startLiveSession: (durationMinutes, opts = {}) => postJson('/screen/live-session/start', { durationMinutes }, opts),
  stopLiveSession: (opts = {}) => postJson('/screen/live-session/stop', {}, opts),
};
