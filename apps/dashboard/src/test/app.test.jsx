import { describe, expect, it, vi } from 'vitest';
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

const mockFetch = (impl) => vi.spyOn(globalThis, 'fetch').mockImplementation(impl);

describe('dashboard shell', () => {
  it('renders navigation for all six pages', async () => {
    mockFetch(async () => new Response(JSON.stringify(healthBody()), { status: 200 }));
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
    mockFetch(async () => new Response(JSON.stringify(healthBody()), { status: 200 }));
    renderAt('/');
    expect(await screen.findByText('Connected (3 ms)')).toBeInTheDocument();
    expect(screen.getByText('2m 05s')).toBeInTheDocument();
    expect(await screen.findByText('Backend online')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/health', expect.any(Object));
  });

  it('shows a degraded state when the database is down (503)', async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify(
            healthBody({ status: 'degraded', database: { status: 'down', latencyMs: 1, error: 'ECONNREFUSED' } }),
          ),
          { status: 503 },
        ),
    );
    renderAt('/');
    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
    expect(await screen.findByText('Database unreachable')).toBeInTheDocument();
  });

  it('shows an error state when the backend is unreachable', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderAt('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the DigitalPulse backend');
    expect(await screen.findByText('Backend offline')).toBeInTheDocument();
  });

  it('shows an explanatory empty state instead of mock activity', async () => {
    mockFetch(async () => new Response(JSON.stringify(healthBody()), { status: 200 }));
    renderAt('/applications');
    expect(await screen.findByText('No application usage recorded')).toBeInTheDocument();
  });
});

