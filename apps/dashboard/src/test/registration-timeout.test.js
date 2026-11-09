import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('allows registration longer than eight seconds without retrying the write', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ success: true }), { status: 201 })), 12000)));
  vi.stubGlobal('fetch', fetch);
  const request = api.registerOrganization({ email: 'test@example.test' });
  await vi.advanceTimersByTimeAsync(12000);
  expect(await request).toEqual({ success: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
});

it('identifies timeouts separately from network failures', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  const assertion = expect(api.registerOrganization({})).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(45000);
  await assertion;
});
