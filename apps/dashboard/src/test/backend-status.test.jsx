import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api.js';
import { backendStatusKey } from '../components/layout/BackendStatus.jsx';

describe('backend health classification', () => {
  it('does not treat canceled or timed-out checks as proof of outage', () => {
    for (const code of ['CANCELED', 'TIMEOUT']) {
      expect(backendStatusKey({ error: new ApiError('Unavailable', { code }), loading: false })).toBe('unknown');
    }
    expect(
      backendStatusKey({
        data: { status: 'ok' },
        error: new ApiError('Request was canceled', { code: 'CANCELED' }),
        loading: false,
      }),
    ).toBe('ok');
    expect(
      backendStatusKey({
        data: { status: 'ok' },
        error: new ApiError('Transient failure', { code: 'NETWORK_ERROR' }),
        loading: false,
      }),
    ).toBe('unknown');
  });

  it('uses offline for an explicit backend-offline response or initial unreachable network error', () => {
    expect(backendStatusKey({ error: new ApiError('Offline', { code: 'BACKEND_OFFLINE' }), loading: false })).toBe('offline');
    expect(backendStatusKey({ error: new ApiError('Unreachable', { code: 'NETWORK_ERROR' }), loading: false })).toBe('offline');
    expect(backendStatusKey({ data: { status: 'ok' }, loading: false })).toBe('ok');
  });
});
