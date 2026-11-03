import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import App from '../App.jsx';
import { setAuthToken } from '../lib/api.js';

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{JSON.stringify({ pathname: location.pathname, search: location.search, hash: location.hash, state: location.state })}</div>;
}

const healthBody = (overrides = {}) => ({
  status: 'ok',
  service: 'digitalpulse-backend',
  version: '0.1.0',
  time: '2026-11-01T18:00:00.000Z',
  uptimeSeconds: 125,
  database: { status: 'up', latencyMs: 3 },
  ...overrides,
});

const defaultRouterFetch = async (url) => {
  const u = typeof url === 'string' ? url : url?.url ?? '';
  if (u.includes('/activity/summary')) {
    return new Response(JSON.stringify({ totalActiveSeconds: 0, totalIdleSeconds: 0, totalEvents: 0 }), { status: 200 });
  }
  if (u.includes('/activity/apps')) {
    return new Response(JSON.stringify({ apps: [] }), { status: 200 });
  }
  if (u.includes('/activity/websites')) {
    return new Response(JSON.stringify({ websites: [] }), { status: 200 });
  }
  if (u.includes('/analytics/daily')) return new Response(JSON.stringify({ date: '2026-11-03', totalActiveMinutes: 0, totalIdleMinutes: 0, breakdown: {} }), { status: 200 });
  if (u.includes('/analytics/weekly')) return new Response(JSON.stringify({ days: [], summary: {} }), { status: 200 });
  if (u.includes('/activity/timeline')) {
    return new Response(JSON.stringify({ events: [], count: 0 }), { status: 200 });
  }
  if (u.includes('/devices/my-monitoring-status')) {
    return new Response(JSON.stringify({ monitoring: { allowed: false, reason: 'USER_CONSENT_REQUIRED' }, settings: { consentGranted: false, adminAuthorized: false } }), { status: 200 });
  }
  if (u.includes('/devices')) {
    return new Response(JSON.stringify({ devices: [], count: 0 }), { status: 200 });
  }
  if (u.includes('/screen/config')) {
    return new Response(
      JSON.stringify({
        consentGranted: false,
        status: 'stopped',
        captureIntervalMinutes: 10,
        retentionDays: 7,
        totalCaptures: 0,
        liveSession: { active: false },
      }),
      { status: 200 },
    );
  }
  if (u.includes('/screen/captures')) {
    return new Response(JSON.stringify({ captures: [], count: 0 }), { status: 200 });
  }
  if (u.includes('/planner/tasks')) {
    return new Response(JSON.stringify({ tasks: [{ id: '1', title: 'Sample Homework Task', category: 'study', targetMinutes: 30, completed: false }], totalCount: 1, completedCount: 0 }), { status: 200 });
  }
  if (u.includes('/planner/goals')) {
    return new Response(JSON.stringify({ goals: [{ id: 'g1', title: 'Daily Limit', category: 'daily', maxMinutesPerDay: 240, actualMinutes: 60, percentUsed: 25 }], count: 1 }), { status: 200 });
  }
  if (u.includes('/planner/focus-sessions')) {
    return new Response(JSON.stringify({ activeSession: null, history: [] }), { status: 200 });
  }
  if (u.includes('/planner/analytics')) {
    return new Response(JSON.stringify({ plannedTaskMinutes: 30, completedTaskMinutes: 0, realActiveMinutes: 60, taskCount: 1, completedTaskCount: 0, goalComparisons: [{ id: 'g1', title: 'Daily Limit', maxMinutesPerDay: 240, actualMinutes: 60, percentUsed: 25 }] }), { status: 200 });
  }
  if (u.includes('/wellbeing/status')) {
    return new Response(JSON.stringify({ breaksCompletedToday: 4, breakIntervalMinutes: 20 }), { status: 200 });
  }
  if (u.includes('/employees/emp-001')) {
    return new Response(JSON.stringify({ employee: {
      id: 'emp-001', employeeId: 'EMP-1001', displayName: 'Alex Mercer', companyEmail: 'alex.mercer@enterprise.com',
      department: 'Engineering', designation: 'Staff Systems Architect', employmentStatus: 'active', monitoringAuthorized: true,
      shiftStart: '09:00', shiftEnd: '18:00', workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], devices: [],
      deviceStatus: 'NOT_CONNECTED', enrollmentStatus: 'PENDING', monitoringStatus: 'NOT_STARTED', lastHeartbeatAt: null, lastSyncAt: null,
      analytics: { hasData: false, totalMonitoredSeconds: null, activeSeconds: null, idleSeconds: null, applicationUsage: [], websiteUsage: [] },
    } }), { status: 200 });
  }
  if (u.includes('/employees/live')) {
    return new Response(JSON.stringify({ employees: [{ id: 'emp-001', displayName: 'Alex Mercer', department: 'Engineering', liveStatus: 'NOT_ENROLLED', activeSecondsToday: 0, idleSecondsToday: 0, currentApplication: 'None', currentDomain: 'None' }], summary: { totalEmployees: 1, activeCount: 0, idleCount: 0, offlineCount: 0, connectedCount: 0, pendingEnrollmentCount: 1, revokedCount: 0 }, timestamp: '2026-11-03T12:00:00.000Z' }), { status: 200 });
  }
  if (u.includes('/invitations')) return new Response(JSON.stringify({ invitations: [], count: 0 }), { status: 200 });
  if (u.includes('/activity/apps')) return new Response(JSON.stringify({ apps: [], totalSeconds: 0 }), { status: 200 });
  if (u.includes('/activity/websites')) return new Response(JSON.stringify({ websites: [], totalSeconds: 0 }), { status: 200 });
  if (u.includes('/employees') || u.includes('/family/members')) {
    return new Response(
      JSON.stringify({
        employees: [
          {
            id: 'emp-001',
            employeeId: 'EMP-1001',
            displayName: 'Alex Mercer',
            firstName: 'Alex',
            lastName: 'Mercer',
            companyEmail: 'alex.mercer@enterprise.com',
            department: 'Engineering',
            designation: 'Staff Systems Architect',
            employmentStatus: 'active',
            monitoringAuthorized: true,
            shiftStart: '09:00',
            shiftEnd: '18:00',
            workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            devices: [],
          },
        ],
        members: [
          { id: 'm1', displayName: 'Alex Mercer', role: 'owner', ageBracket: 'adult', email: 'alex@enterprise.com', assignedDeviceIds: [] },
        ],
        totalCount: 1,
      }),
      { status: 200 },
    );
  }
  if (u.includes('/policies/declarative-rules')) {
    return new Response(JSON.stringify({
      rules: [
        {
          id: 1,
          priority: 1,
          action: { type: 'redirect', redirect: { url: 'http://localhost:5173/blocked?domain=roblox.com&policy=Gaming%20Policy' } },
          condition: { urlFilter: '||roblox.com', resourceTypes: ['main_frame'] }
        }
      ],
      count: 1,
      version: 1
    }), { status: 200 });
  }
  if (u.includes('/policies/violations')) {
    return new Response(JSON.stringify({ violations: [{ id: 'v1', policyName: 'Safe Browsing', target: 'tiktok.com', timestamp: '2026-11-01T12:00:00.000Z', warningMessage: 'Test violation', acknowledged: false }], totalCount: 1 }), { status: 200 });
  }
  if (u.includes('/policies')) {
    return new Response(JSON.stringify({ policies: [{ id: 'p1', name: 'Safe Browsing', category: 'social_media', restrictedDomains: ['tiktok.com'], maxMinutesPerDay: 60, action: 'warn', active: true }], totalCount: 1 }), { status: 200 });
  }
  if (u.includes('/alerts')) {
    return new Response(JSON.stringify({ alerts: [{ id: 'a1', title: 'Test Alert', description: 'Sample warning', severity: 'warning', timestamp: '2026-11-01T12:00:00.000Z', type: 'policy_violation' }], count: 1 }), { status: 200 });
  }
  return new Response(JSON.stringify(healthBody()), { status: 200 });
};

const mockFetch = (impl) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
  const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
  if (requestUrl.includes('/auth/me')) {
    return new Response(JSON.stringify({
      success: true,
      user: {
        id: 'admin-001',
        email: 'admin@example.com',
        displayName: 'Test Administrator',
        role: 'ORGANIZATION_ADMIN',
        organization: { name: 'Test Organization' },
      },
    }), { status: 200 });
  }
  return impl(url, options);
});

beforeEach(() => {
  vi.restoreAllMocks();
  setAuthToken(null);
});

describe('dashboard shell and navigation', () => {
  it('renders the employee activity monitoring sections in the sidebar', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/');
    await waitFor(() => {
      for (const label of [
        'Overview',
        'Employees',
        'Activity',
        'Schedule',
        'Reports',
      ]) {
        expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
      }
    });
  });

  it('shows real health data from the backend response', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/');
    const healthDetails = await screen.findByTestId('health-details');
    expect(healthDetails).toHaveTextContent('Connected (3 ms)');
    expect(healthDetails).toHaveTextContent('2m 05s');
    expect(await screen.findByText('Backend online')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), expect.any(Object));
  });

  it('shows organization metrics and a linked onboarding empty state from backend data', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Organization overview' })).toBeInTheDocument();
    expect(await screen.findByText('Complete employee onboarding and connect a device to begin collecting authorized activity.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invite or set up employees' })).toHaveAttribute('href', '/employees');
    expect(screen.getByRole('link', { name: 'Review device setup' })).toHaveAttribute('href', '/devices');
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/employees\/live$/), expect.any(Object));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/devices$/), expect.any(Object));
  });

  it('renders the employee and date filtered activity reports with CSV export', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/reports');
    expect(await screen.findByText('Activity reports')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter reports by employee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByText('No historical activity')).toBeInTheDocument();
  });

  it('shows the exact no-device employee message and opens the installation guide', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/employees');
    fireEvent.click(await screen.findByText('Alex Mercer'));
    expect(await screen.findByText('No device connected yet. Send your employee the setup instructions to install the DigitalPulse agent.')).toBeInTheDocument();
    expect(screen.getByText('Not Connected')).toBeInTheDocument();
    expect(screen.getAllByText('Pending', { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText('Not Started')).toBeInTheDocument();
    expect(screen.getAllByText('No data available').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'View Installation Guide' }));
    expect(await screen.findByText('Set up DigitalPulse on your device')).toBeInTheDocument();
  });

  it('calls the canonical reminder URL and prevents duplicate reminder submissions', async () => {
    let resolveReminder;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options = {}) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'admin-001', email: 'admin@example.com', role: 'ORGANIZATION_ADMIN' } }), { status: 200 });
      if (requestUrl.endsWith('/employees/emp-001/setup-reminder') && options.method === 'POST') {
        return new Promise((resolve) => {
          resolveReminder = () => resolve(new Response(JSON.stringify({
            success: true,
            emailSent: false,
            notificationQueued: true,
            deliveryStatus: 'queued',
            message: 'Email is unavailable. The setup reminder was queued in DigitalPulse.',
            setupUrl: 'http://localhost:5173/employee-setup',
          }), { status: 202 }));
        });
      }
      return defaultRouterFetch(url, options);
    });

    renderAt('/employees');
    fireEvent.click(await screen.findByText('Alex Mercer'));
    const button = await screen.findByRole('button', { name: 'Send setup reminder' });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(fetchSpy.mock.calls.filter(([url, options]) => String(url).endsWith('/employees/emp-001/setup-reminder') && options?.method === 'POST')).toHaveLength(1));
    expect(button).toBeDisabled();

    await act(async () => resolveReminder());
    expect(await screen.findByRole('status')).toHaveTextContent('Email is unavailable. The setup reminder was queued in DigitalPulse.');
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/employees/emp-001/setup-reminder', expect.objectContaining({ method: 'POST' }));
  });

  it('shows separate installation instructions and does not generate enrollment tokens automatically', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'employee-1', email: 'employee@example.com', displayName: 'Employee One', role: 'EMPLOYEE' } }), { status: 200 });
      return defaultRouterFetch(url, options);
    });
    renderAt('/employee-setup');
    expect(await screen.findByRole('heading', { name: 'Install Windows Agent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Install Chrome Extension' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Install Edge Extension' })).toBeInTheDocument();
    expect(screen.getByText('Windows Agent', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Chrome Extension', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Edge Extension', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('LOCAL DEVELOPMENT / INTERNAL TEST BUILD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate one-time enrollment token/i })).toBeEnabled();
    expect(screen.queryByText(/dp_enroll_/)).not.toBeInTheDocument();
    expect(await screen.findAllByText('Not Installed')).toHaveLength(3);
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/devices\/my-enrollment-token$/), expect.anything());
    fireEvent.click(screen.getAllByRole('button', { name: 'I have started installation' })[1]);
    await waitFor(() => expect(screen.getByTestId('device-status-chrome-extension')).toHaveTextContent('Installation Pending'));
    localStorage.removeItem('dp_install_started_employee-1');
  });

  it('offers three independent verified downloads and rejects a failed or HTML package response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const u = String(url);
      if (u.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'employee-1', role: 'EMPLOYEE' } }), { status: 200 });
      if (u.startsWith('/downloads/')) {
        expect(options.method).toBe('HEAD');
        if (u.includes('chrome')) return new Response(null, { status: 404 });
        if (u.includes('edge')) return new Response(null, { status: 200, headers: { 'content-type': 'text/html', 'content-length': '1200' } });
        return new Response(null, { status: 200, headers: { 'content-type': 'application/zip', 'content-length': '1024' } });
      }
      return defaultRouterFetch(url, options);
    });
    renderAt('/employee-setup');
    expect(await screen.findByRole('link', { name: 'Install Windows Agent' })).toHaveAttribute('href', '/downloads/digitalpulse-windows-agent.zip');
    expect(await screen.findByRole('button', { name: 'Install Chrome Extension (Unavailable)' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Install Edge Extension (Unavailable)' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Install Chrome Extension' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Install Edge Extension' })).not.toBeInTheDocument();
    const calls = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(calls).toContain('/downloads/digitalpulse-chrome-extension.zip');
    expect(calls).toContain('/downloads/digitalpulse-edge-extension.zip');
  });

  it('creates and copies a scoped token once while keeping monitoring paused', async () => {
    let finish;
    const token = 'dp_enroll_test-only';
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const u = String(url);
      if (u.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'employee-1', role: 'EMPLOYEE' } }), { status: 200 });
      if (u.endsWith('/devices/my-enrollment-token')) {
        expect(JSON.parse(options.body)).toEqual({ deviceKind: 'DESKTOP_AGENT' });
        return new Promise((resolve) => { finish = () => resolve(new Response(JSON.stringify({ token, expiresAt: new Date(Date.now() + 4 * 3600000).toISOString() }), { status: 201 })); });
      }
      return defaultRouterFetch(url, options);
    });
    renderAt('/employee-setup');
    const button = await screen.findByRole('button', { name: 'Generate one-time enrollment token' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(spy.mock.calls.filter(([url]) => String(url).endsWith('/devices/my-enrollment-token'))).toHaveLength(1));
    await act(async () => finish());
    expect(await screen.findByDisplayValue(token)).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Generate one-time enrollment token' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy enrollment token' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(token));
    expect(await screen.findByText('Enrollment token copied.')).toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain(token);
    expect(screen.getByText(/Monitoring: Paused/)).toBeInTheDocument();
    expect(screen.getAllByText('Not Installed')).toHaveLength(3);
  });

  it('shows connected only for a backend device with a recent authenticated heartbeat', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'employee-1', email: 'employee@example.com', displayName: 'Employee One', role: 'EMPLOYEE' } }), { status: 200 });
      if (requestUrl.endsWith('/devices')) return new Response(JSON.stringify({ devices: [
        { id: 'agent-1', kind: 'desktop_agent', name: 'Windows Agent', status: 'offline', lastSeenAt: null },
        { id: 'chrome-1', kind: 'browser_extension', browser: 'chrome', name: 'Chrome Extension', status: 'online', lastSeenAt: new Date().toISOString() },
        { id: 'edge-1', kind: 'browser_extension', browser: 'edge', name: 'Edge Extension', status: 'offline', lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      ] }), { status: 200 });
      return defaultRouterFetch(url, options);
    });
    renderAt('/employee-setup');
    await waitFor(() => {
      expect(screen.getByTestId('device-status-windows-agent')).toHaveTextContent('Connection Pending');
      expect(screen.getByTestId('device-status-chrome-extension')).toHaveTextContent('Connected');
      expect(screen.getByTestId('device-status-edge-extension')).toHaveTextContent('Offline');
    });
  });
  it('creates an invitation and shows the backend link in a copyable success state', async () => {
    const invitationUrl = 'http://localhost:5173/accept-invitation#token=dp_inv_real-backend-token';
    let invitationCreated = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options = {}) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'admin-001', email: 'admin@example.com', role: 'ORGANIZATION_ADMIN' } }), { status: 200 });
      if (requestUrl.endsWith('/invitations') && options.method === 'POST') {
        invitationCreated = true;
        return new Response(JSON.stringify({
          success: true,
          invitation: { id: 'invite-1', displayName: 'Jamie Employee', email: 'jamie@example.com', role: 'EMPLOYEE' },
          invitationUrl,
          expiresAt: '2026-11-10T12:00:00.000Z',
          emailSent: false,
        }), { status: 201 });
      }
      if (requestUrl.endsWith('/invitations')) return new Response(JSON.stringify({ invitations: invitationCreated ? [{ id: 'invite-1', displayName: 'Jamie Employee', email: 'jamie@example.com', status: 'pending', expiresAt: '2026-11-10T12:00:00.000Z' }] : [], count: invitationCreated ? 1 : 0 }), { status: 200 });
      return defaultRouterFetch(url, options);
    });
    renderAt('/employees');
    fireEvent.click(await screen.findByRole('button', { name: '+ Invite Employee' }));
    fireEvent.change(screen.getByPlaceholderText('Employee name'), { target: { value: 'Jamie Employee' } });
    fireEvent.change(screen.getByPlaceholderText('employee@company.com'), { target: { value: 'jamie@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Department'), { target: { value: 'Engineering' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Invitation' }));

    expect(await screen.findByText('Invitation created successfully')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Resend Invitation' })).toBeInTheDocument();
    expect(screen.getByText('The invitation is saved and remains active, but email delivery is unavailable. Copy and send this link to the employee.')).toBeInTheDocument();
    expect(screen.getByText(invitationUrl)).toBeInTheDocument();
    expect(screen.getByText('Pending Acceptance', { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Invitation Link' })[0]);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(invitationUrl));
    expect(await screen.findByText('Invitation link copied.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy Invitation Link' })[1]);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/invitations$/), expect.objectContaining({ method: 'POST' }));
  });

  it('validates a fragment invitation token and redirects an accepted employee to device setup', async () => {
    setAuthToken(null);
    let authenticated = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options = {}) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) {
        if (!authenticated) return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        const user = { id: 'employee-001', email: 'jamie@example.com', displayName: 'Jamie Employee', role: 'EMPLOYEE' };
        return new Response(JSON.stringify({ user }), { status: 200 });
      }
      if (requestUrl.endsWith('/invitations/validate')) {
        const body = JSON.parse(options.body);
        expect(body.token).toBe('dp_inv_real-backend-token');
        return new Response(JSON.stringify({ valid: true, invitation: {
          displayName: 'Jamie Employee', email: 'jamie@example.com', role: 'EMPLOYEE', department: 'Engineering',
          shiftStart: '09:00', shiftEnd: '17:00', shiftTimezone: 'UTC', expiresAt: '2026-11-10T12:00:00.000Z', organizationName: 'Acme',
        } }), { status: 200 });
      }
      if (requestUrl.endsWith('/invitations/accept')) return new Response(JSON.stringify({ success: true, user: { id: 'employee-001', email: 'jamie@example.com', role: 'EMPLOYEE' } }), { status: 200 });
      if (requestUrl.endsWith('/auth/login')) {
        authenticated = true;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return defaultRouterFetch(url, options);
    });
    renderAt('/accept-invitation#token=dp_inv_real-backend-token');
    expect(await screen.findByText('Acme invited you to DigitalPulse')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'StrongPassword123!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'StrongPassword123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Set up DigitalPulse on your device')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/invitations\/accept$/), expect.objectContaining({ method: 'POST' }));
  });

  it('shows an understandable rejection for an expired invitation without showing the password form', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'admin-001', email: 'admin@example.com', role: 'ORGANIZATION_ADMIN' } }), { status: 200 });
      if (requestUrl.endsWith('/invitations/validate')) return new Response(JSON.stringify({ error: { code: 'INVITATION_VALIDATION_FAILED', message: 'This invitation has expired. Ask your organization to resend it.' } }), { status: 410 });
      return defaultRouterFetch(url);
    });
    renderAt('/accept-invitation#token=expired-token-value');
    expect(await screen.findByText('This invitation has expired. Ask your organization to resend it.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows a degraded state when the database is down (503)', async () => {
    mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url?.url ?? '';
      if (u.includes('/health')) {
        return new Response(
          JSON.stringify(
            healthBody({ status: 'degraded', database: { status: 'down', latencyMs: 1, error: 'ECONNREFUSED' } }),
          ),
          { status: 503 },
        );
      }
      return defaultRouterFetch(url);
    });
    renderAt('/');
    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
    expect(await screen.findByText('Database unreachable')).toBeInTheDocument();
  });

  it('shows an error state when the backend is unreachable', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderAt('/');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toHaveTextContent('Cannot reach the DigitalPulse service');
    expect(await screen.findByText('Backend offline')).toBeInTheDocument();
  });

  it('shows an explanatory empty state instead of mock activity when no apps exist', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/applications');
    expect(await screen.findByText('No application usage recorded')).toBeInTheDocument();
  });

  it('renders real dynamic application usage when data is returned', async () => {
    mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url?.url ?? '';
      if (u.includes('/activity/apps')) {
        return new Response(
          JSON.stringify({
            apps: [
              { name: 'Code.exe', executable: 'Code.exe', durationSeconds: 150.0, sessionCount: 5 },
            ],
          }),
          { status: 200 },
        );
      }
      return defaultRouterFetch(url);
    });
    renderAt('/applications');
    expect(await screen.findByText('Code.exe')).toBeInTheDocument();
    expect(screen.getByText('2m 30s')).toBeInTheDocument();
  });

  it('renders real timeline entries when events are returned', async () => {
    mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url?.url ?? '';
      if (u.includes('/activity/timeline')) {
        return new Response(
          JSON.stringify({
            events: [
              {
                id: '123e4567-e89b-12d3-a456-426614174000',
                type: 'app_session',
                startedAt: '2026-11-01T12:00:00.000Z',
                endedAt: '2026-11-01T12:02:00.000Z',
                durationSeconds: 120.0,
                app: { name: 'Windows Terminal', executable: 'wt.exe', processId: 987 },
              },
            ],
            count: 1,
          }),
          { status: 200 },
        );
      }
      return defaultRouterFetch(url);
    });
    renderAt('/timeline');
    expect(await screen.findByText('Windows Terminal')).toBeInTheDocument();
    expect(screen.getByText('PID: 987')).toBeInTheDocument();
    expect(screen.getByText('2m 00s')).toBeInTheDocument();
  });

  it('renders real devices list when collectors are registered', async () => {
    mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url?.url ?? '';
      if (u.includes('/devices')) {
        return new Response(
          JSON.stringify({
            devices: [
              {
                id: '550e8400-e29b-41d4-a716-446655440000',
                kind: 'desktop_agent',
                name: 'DESKTOP-TEST',
                platform: 'windows_11',
                agentVersion: '0.1.0',
                createdAt: '2026-11-01T10:00:00.000Z',
              },
            ],
            count: 1,
          }),
          { status: 200 },
        );
      }
      return defaultRouterFetch(url);
    });
    renderAt('/devices');
    expect(await screen.findByText('DESKTOP-TEST')).toBeInTheDocument();
    expect(screen.getByText('Windows Desktop Agent')).toBeInTheDocument();
  });

  it('renders Milestone 7 screen monitoring consent flow when consent is not yet granted', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/screen-monitoring');
    expect(await screen.findByText('Explicit User Consent Required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grant Consent & Enable' })).toBeInTheDocument();
  });

  it('renders Milestone 7 active screen monitoring controls and captures when consent is granted', async () => {
    mockFetch(async (url) => {
      const u = typeof url === 'string' ? url : url?.url ?? '';
      if (u.includes('/screen/config')) {
        return new Response(
          JSON.stringify({
            consentGranted: true,
            status: 'active',
            captureIntervalMinutes: 10,
            retentionDays: 7,
            totalCaptures: 1,
            liveSession: { active: false },
          }),
          { status: 200 },
        );
      }
      if (u.includes('/screen/captures')) {
        return new Response(
          JSON.stringify({
            captures: [
              {
                id: 'cap-1',
                timestamp: '2026-11-01T14:30:00.000Z',
                applicationName: 'Visual Studio Code',
                previewUrl: 'data:image/svg+xml;utf8,<svg></svg>',
                width: 1920,
                height: 1080,
                sizeBytes: 85000,
              },
            ],
            count: 1,
          }),
          { status: 200 },
        );
      }
      return defaultRouterFetch(url);
    });
    renderAt('/screen-monitoring');
    expect(await screen.findByText(/Status: active/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture Now' })).toBeInTheDocument();
    expect(screen.getByText('Visual Studio Code')).toBeInTheDocument();
  });

  it('renders the employee work schedule editor', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/time-planner');
    expect(await screen.findByText('Work schedule')).toBeInTheDocument();
    expect(await screen.findByText('Alex Mercer')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save schedule' }).length).toBeGreaterThan(0);
  });

  it('redirects the legacy wellbeing route into the focused reports area', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/digital-wellbeing');
    expect(await screen.findByText('Activity reports')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('renders Milestone 9 Family Members page with household profiles', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/employees');
    expect(await screen.findByText(/Employee Directory & Monitoring Governance/i)).toBeInTheDocument();
    expect(await screen.findByText('Alex Mercer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add New Employee' })).toBeInTheDocument();
  });

  it('renders Milestone 9 Family Policies page with policies and simulator', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/policies');
    expect(await screen.findByText(/Enterprise Website Access Policies & Governance/i)).toBeInTheDocument();
    const policyHeaders = await screen.findAllByText('Safe Browsing');
    expect(policyHeaders.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Test Evaluation' })).toBeInTheDocument();
  });

  it('renders Milestone 9 Alerts and Notifications center', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/alerts');
    expect(await screen.findByText('Alerts & Notification Center')).toBeInTheDocument();
    expect(await screen.findByText('Test Alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('renders MV3 DeclarativeNetRequest Policy Engine page with live rules and simulator', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/policies/declarative-rules');
    expect(await screen.findByText('MV3 DeclarativeNetRequest Policy Engine')).toBeInTheDocument();
    expect(await screen.findByText('roblox.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download rules.json' })).toBeInTheDocument();
  });

  it('renders Blocked Page when an employee hits a restricted domain', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/blocked?domain=roblox.com&policy=Gaming%20Policy');
    expect(await screen.findByText(/Access Restricted/i)).toBeInTheDocument();
    const domains = await screen.findAllByText(/roblox.com/i);
    expect(domains.length).toBeGreaterThan(0);
    expect(await screen.findByText('Gaming Policy')).toBeInTheDocument();
  });
});

describe('authentication entry flow', () => {
  beforeEach(() => {
    setAuthToken(null);
  });

  it('validates the session profile before redirecting an administrator', async () => {
    let authenticated = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/login')) {
        authenticated = true;
        return new Response(JSON.stringify({
          success: true,
          user: { id: 'admin-1', role: 'ORGANIZATION_ADMIN' },
        }), { status: 200 });
      }
      if (requestUrl.includes('/auth/me')) {
        if (!authenticated) return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        expect(options?.credentials).toBe('include');
        expect(options?.headers?.Authorization).toBeUndefined();
        return new Response(JSON.stringify({
          success: true,
          user: {
            id: 'admin-1',
            email: 'admin@example.com',
            displayName: 'Admin User',
            role: 'ORGANIZATION_ADMIN',
            organization: { name: 'Acme' },
          },
        }), { status: 200 });
      }
      return defaultRouterFetch(url, options);
    });

    renderAt('/login');
    await screen.findByLabelText('Work email');
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getAllByText('Overview').length).toBeGreaterThan(0);
    });
    expect(localStorage.getItem('dp_auth_token')).toBeNull();
    expect(sessionStorage.getItem('dp_auth_token')).toBeNull();
    expect(screen.queryByDisplayValue('correct-password')).not.toBeInTheDocument();
  });

  it('redirects an employee away from administrator directory routes to the employee portal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) {
        return new Response(JSON.stringify({ success: true, user: {
          id: 'employee-1', email: 'employee@example.com', displayName: 'Employee User', role: 'EMPLOYEE',
        } }), { status: 200 });
      }
      return defaultRouterFetch(url, options);
    });

    render(
      <MemoryRouter initialEntries={['/employees']}>
        <LocationProbe />
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(JSON.parse(screen.getByTestId('router-location').textContent).pathname).toBe('/employee-portal'));
    expect(await screen.findByRole('heading', { name: /Good morning, Employee User/i })).toBeInTheDocument();
  });

  it('keeps the email, clears the password, and uses a generic error on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) {
        return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
      }
      if (requestUrl.includes('/auth/login')) {
        return new Response(JSON.stringify({
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
        }), { status: 401 });
      }
      return defaultRouterFetch(url);
    });

    renderAt('/login');
    await screen.findByLabelText('Work email');
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'unknown@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to sign in. Check your credentials and try again.',
    );
    expect(screen.getByDisplayValue('unknown@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(localStorage.getItem('dp_auth_token')).toBeNull();
  });

  it('keeps the invited email read-only and returns from sign-in to accept with the existing account', async () => {
    setAuthToken(null);
    let authenticated = false;
    const acceptedPayloads = [];
    const invitation = {
      organizationName: 'Acme',
      displayName: 'invitee@example.com',
      email: 'invitee@example.com',
      role: 'EMPLOYEE',
      expiresAt: '2026-12-01T00:00:00.000Z',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options = {}) => {
      const requestUrl = typeof url === 'string' ? url : url?.url ?? '';
      if (requestUrl.includes('/auth/me')) {
        if (!authenticated) return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        return new Response(JSON.stringify({ success: true, user: { id: 'employee-1', email: invitation.email, displayName: 'Invitee Person', role: 'EMPLOYEE' } }), { status: 200 });
      }
      if (requestUrl.includes('/invitations/validate')) {
        return new Response(JSON.stringify({ valid: true, invitation }), { status: 200 });
      }
      if (requestUrl.includes('/auth/invitations/accept')) {
        const payload = JSON.parse(options.body);
        acceptedPayloads.push({ payload, authorization: options.headers?.Authorization, credentials: options.credentials });
        if (acceptedPayloads.length === 1) {
          return new Response(JSON.stringify({ error: { code: 'EXISTING_ACCOUNT_REQUIRES_AUTH', message: 'This email already has a DigitalPulse account. Sign in with the invited email to accept this invitation.' } }), { status: 409 });
        }
        return new Response(JSON.stringify({ success: true, existingAccount: true, user: { id: 'employee-1', email: invitation.email, role: 'EMPLOYEE' } }), { status: 200 });
      }
      if (requestUrl.includes('/auth/login')) {
        expect(options?.credentials).toBe('include');
        authenticated = true;
        return new Response(JSON.stringify({ success: true, user: { email: invitation.email, role: 'EMPLOYEE' } }), { status: 200 });
      }
      return defaultRouterFetch(url, options);
    });

    render(
      <MemoryRouter initialEntries={['/accept-invitation#token=dp_inv_secure-token-value-1234567890']}>
        <LocationProbe />
        <App />
      </MemoryRouter>,
    );
    const invitedEmail = await screen.findByLabelText('Invited email');
    expect(invitedEmail).toHaveValue(invitation.email);
    expect(invitedEmail).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Full name')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Invitee Person' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ExistingPass123!' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ExistingPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/already has a DigitalPulse account/i);
    expect(acceptedPayloads[0].payload.displayName).toBe('Invitee Person');

    fireEvent.click(screen.getByRole('link', { name: 'Sign in to accept invitation' }));
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(JSON.parse(screen.getByTestId('router-location').textContent).state.from.pathname).toBe('/accept-invitation');
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: invitation.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ExistingPass123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(JSON.parse(screen.getByTestId('router-location').textContent).pathname).toBe('/accept-invitation'));
    const acceptExisting = await screen.findByRole('button', { name: 'Accept invitation' });
    fireEvent.click(acceptExisting);
    await waitFor(() => expect(acceptedPayloads).toHaveLength(2));
    expect(acceptedPayloads[1].payload).toEqual({ token: 'dp_inv_secure-token-value-1234567890' });
    expect(acceptedPayloads[1].authorization).toBeUndefined();
    expect(acceptedPayloads[1].credentials).toBe('include');
    expect(await screen.findByRole('heading', { name: 'Set up DigitalPulse on your device' })).toBeInTheDocument();
  });
});
