import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DevicesPage from '../pages/DevicesPage.jsx';

const mocks = vi.hoisted(() => ({
  settings: {}, role: 'ADMIN', reload: vi.fn(),
  saveTimezone: vi.fn(), saveSchedule: vi.fn(),
}));
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'user', role: mocks.role } }) }));
vi.mock('../lib/api.js', () => ({ api: {
  devices: () => ({ devices: [] }),
  deviceDirectory: () => ({ devices: [], pendingEnrollments: [] }),
  myMonitoringStatus: () => ({ settings: mocks.settings, monitoring: { allowed: false, reason: 'ORGANIZATION_TIMEZONE_REQUIRED' } }),
  updateOrganizationTimezone: mocks.saveTimezone,
  updateMyMonitoringSchedule: mocks.saveSchedule,
} }));
vi.mock('../hooks/useApi.js', () => ({ useApi: fetcher => ({ data: fetcher(), reload: mocks.reload, loading: false }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.settings = { shiftStart: '09:00', shiftEnd: '18:00', workingDays: ['Mon'], organizationTimezone: '' };
});

it('distinguishes a placeholder from a saved timezone and saves a confirmed value', async () => {
  mocks.saveTimezone.mockResolvedValue({ success: true, timezone: 'Asia/Kolkata' });
  render(<MemoryRouter><DevicesPage /></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Save time zone' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('IANA time zone'), { target: { value: 'Asia/Kolkata' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }));
  await waitFor(() => expect(mocks.saveTimezone).toHaveBeenCalledWith('Asia/Kolkata'));
  expect(await screen.findByText(/Organization time zone saved: Asia\/Kolkata/)).toBeInTheDocument();
});

it('preserves schedule edits when the organization timezone refreshes', async () => {
  const view = render(<MemoryRouter><DevicesPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Monitoring shift start'), { target: { value: '10:00' } });
  mocks.settings = { ...mocks.settings, organizationTimezone: 'Asia/Kolkata' };
  view.rerender(<MemoryRouter><DevicesPage /></MemoryRouter>);
  expect(screen.getByLabelText('Monitoring shift start')).toHaveValue('10:00');
});

it('saves an organization schedule once and reloads persisted settings', async () => {
  mocks.saveSchedule.mockResolvedValue({
    success: true,
    syncedUsers: 4,
    settings: { ...mocks.settings, organizationTimezone: 'Asia/Kolkata' },
  });
  render(<MemoryRouter><DevicesPage /></MemoryRouter>);
  const save = screen.getByRole('button', { name: 'Save organization schedule' });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(mocks.saveSchedule).toHaveBeenCalledTimes(1));
  expect(mocks.saveSchedule).toHaveBeenCalledWith({ shiftStart: '09:00', shiftEnd: '18:00', workingDays: ['Mon'] });
  await waitFor(() => expect(mocks.reload).toHaveBeenCalled());
});

it('warns employees that a saved schedule still needs an organization timezone', async () => {
  mocks.role = 'EMPLOYEE';
  mocks.saveSchedule.mockResolvedValue({ settings: mocks.settings });
  render(<MemoryRouter><DevicesPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Save my schedule' }));
  expect(await screen.findByText(/Schedule saved:.*Monitoring remains paused/)).toBeInTheDocument();
  expect(screen.queryByLabelText('IANA time zone')).not.toBeInTheDocument();
});
