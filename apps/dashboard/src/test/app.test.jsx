import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import App from '../App.jsx';

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
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
  if (u.includes('/activity/timeline')) {
    return new Response(JSON.stringify({ events: [], count: 0 }), { status: 200 });
  }
  if (u.includes('/devices')) {
    return new Response(JSON.stringify({ devices: [], count: 0 }), { status: 200 });
  }
  return new Response(JSON.stringify(healthBody()), { status: 200 });
};

const mockFetch = (impl) => vi.spyOn(globalThis, 'fetch').mockImplementation(impl);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('dashboard shell', () => {
  it('renders navigation for all six pages', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/');
    for (const label of [
      'Overview',
      'Activity Timeline',
      'Application Usage',
      'Website Usage',
      'Device Status',
      'Settings',
    ]) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('shows real health data from the backend response', async () => {
    mockFetch(defaultRouterFetch);
    renderAt('/');
    expect(await screen.findByText('Connected (3 ms)')).toBeInTheDocument();
    expect(screen.getByText('2m 05s')).toBeInTheDocument();
    expect(await screen.findByText('Backend online')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/health', expect.any(Object));
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
    expect(alerts[0]).toHaveTextContent('Cannot reach the DigitalPulse backend');
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
});
