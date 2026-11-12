import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setSuperAdminOrganizationScope } from '../lib/api.js';

function jsonResponse(body = {}) {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  setSuperAdminOrganizationScope('');
  vi.unstubAllGlobals();
});

describe('Super Admin organization request scope', () => {
  it('switches GET requests from organization A to B', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ employees: [] }));
    vi.stubGlobal('fetch', fetch);

    setSuperAdminOrganizationScope('org-A');
    await api.employees();

    setSuperAdminOrganizationScope('org-B');
    await api.employees();

    expect(new URL(fetch.mock.calls[0][0], 'http://localhost').searchParams.get('organizationId')).toBe('org-A');
    expect(new URL(fetch.mock.calls[1][0], 'http://localhost').searchParams.get('organizationId')).toBe('org-B');
  });

  it('overrides a stale organizationId supplied by the caller', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ employees: [] }));
    vi.stubGlobal('fetch', fetch);

    setSuperAdminOrganizationScope('org-B');
    await api.employees({ organizationId: 'org-A', status: 'active' });

    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.getAll('organizationId')).toEqual(['org-B']);
    expect(url.searchParams.get('status')).toBe('active');
  });

  it('scopes employee creation and invitation payloads', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    setSuperAdminOrganizationScope('org-B');
    await api.createEmployee({ displayName: 'Example Employee', organizationId: 'org-A' });
    await api.inviteEmployee({ email: 'employee@example.com', organizationId: 'org-A' });

    expect(JSON.parse(fetch.mock.calls[0][1].body).organizationId).toBe('org-B');
    expect(JSON.parse(fetch.mock.calls[1][1].body).organizationId).toBe('org-B');
  });

  it('scopes screen-monitoring writes and invitation resend', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetch);

    setSuperAdminOrganizationScope('org-B');
    await api.updateScreenSettings({ enabled: false });
    await api.resendInvitation('invite-1');

    for (const call of fetch.mock.calls) {
      const url = new URL(call[0], 'http://localhost');
      expect(url.searchParams.get('organizationId')).toBe('org-B');
    }
  });

  it('clears the request scope when the session resets', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ employees: [] }));
    vi.stubGlobal('fetch', fetch);

    setSuperAdminOrganizationScope('org-A');
    await api.employees();

    setSuperAdminOrganizationScope('');
    await api.employees();

    const url = new URL(fetch.mock.calls[1][0], 'http://localhost');
    expect(url.searchParams.has('organizationId')).toBe(false);
  });

  it('does not attach organization scope to global organization discovery', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ organizations: [] }));
    vi.stubGlobal('fetch', fetch);

    setSuperAdminOrganizationScope('org-B');
    await api.organizations();

    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.has('organizationId')).toBe(false);
  });
});
