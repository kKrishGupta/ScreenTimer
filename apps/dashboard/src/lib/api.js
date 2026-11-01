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
 * GET a JSON resource. Non-2xx responses with a JSON body are still returned when
 * `acceptStatuses` includes their status (e.g. 503 from /health carries useful data).
 */
export async function getJson(path, { signal, acceptStatuses = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
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

  const body = await res.json().catch(() => null);
  if (res.ok || acceptStatuses.includes(res.status)) return body;
  throw new ApiError(body?.error?.message ?? `Request failed with status ${res.status}`, {
    status: res.status,
    code: body?.error?.code ?? 'HTTP_ERROR',
    body,
  });
}

export const api = {
  health: (opts) => getJson('/health', { ...opts, acceptStatuses: [503] }),
};

