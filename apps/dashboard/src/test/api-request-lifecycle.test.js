import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, getJson } from '../lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('API request lifecycle', () => {
  it('allows a slow response that completes before the configured timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve(response({ employees: [{ deviceId: 'dev-1' }] })), 9_000);
    })));

    const pending = api.screenEmployees();
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(pending).resolves.toEqual({ employees: [{ deviceId: 'dev-1' }] });
  });

  it('keeps the timeout active while a response body is loading', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    })));

    const assertion = expect(getJson('/slow-body', { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('forwards caller cancellation after response headers arrive', async () => {
    const caller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    })));

    const request = getJson('/cancel-body', { signal: caller.signal });
    caller.abort(new DOMException('Unmounted', 'AbortError'));
    await expect(request).rejects.toMatchObject({ code: 'CANCELED' });
  });

  it('distinguishes HTTP, backend-offline, and network failures', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: { code: 'INVALID_INPUT', message: 'Bad request' } }, 400))
      .mockResolvedValueOnce(response({ error: { code: 'BACKEND_OFFLINE', message: 'Origin unavailable' } }, 503))
      .mockRejectedValueOnce(new TypeError('network failed'));
    vi.stubGlobal('fetch', fetch);

    await expect(getJson('/bad')).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(api.health({ maxRetries: 0 })).rejects.toMatchObject({ status: 503, code: 'BACKEND_OFFLINE' });
    await expect(getJson('/network')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('recovers after a timeout without retrying the timed-out request', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }))
      .mockResolvedValueOnce(response({ status: 'ok' }));
    vi.stubGlobal('fetch', fetch);

    const first = expect(getJson('/health', { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    await expect(getJson('/health', { timeoutMs: 1_000 })).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('allows an invitation resend to survive the normal eight-second cold-start window without retrying', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve(response({ success: true, invitationUrl: 'https://app.example.test/accept-invitation#token=test' })), 9_000);
    }));
    vi.stubGlobal('fetch', fetch);

    const pending = api.resendInvitation('invite-1');
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries only bounded transient GET failures and then succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: { code: 'UPSTREAM', message: 'Bad gateway' } }, 502))
      .mockResolvedValueOnce(response({ error: { code: 'BUSY', message: 'Busy' } }, 503))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const pending = getJson('/transient');
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry authorization failures', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403));
    vi.stubGlobal('fetch', fetch);
    await expect(getJson('/private')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
