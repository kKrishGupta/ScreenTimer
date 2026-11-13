import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScreenMonitoringPage from '../pages/ScreenMonitoringPage.jsx';

const mocks = vi.hoisted(() => ({ settings: {}, employees: {}, captures: {}, reload: vi.fn(), updateDevice: vi.fn(), updateSettings: vi.fn(), deleteCapture: vi.fn(), query: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: {
  screenSettings: () => mocks.settings,
  screenEmployees: () => mocks.employees,
  screenCaptures: params => { mocks.query(params); return mocks.captures; },
  updateScreenDevice: mocks.updateDevice, updateScreenSettings: mocks.updateSettings, deleteScreenCapture: mocks.deleteCapture,
} }));
vi.mock('../hooks/useApi.js', () => ({ useApi: fetch => ({ data: fetch(), loading: false, reload: mocks.reload }) }));
vi.mock('../components/screenshots/LazyScreenshotImage.jsx', () => ({ default: ({ capture }) => <img src={capture.imageUrl} alt={`Work screen captured for ${capture.employeeName}`} /> }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { settings: { enabled: true, captureIntervalSeconds: 300, retentionDays: 30, workingDays: ['Mon'], shiftStart: '09:00', shiftEnd: '18:00', excludedApplications: [] } };
  mocks.employees = { employees: [{ employeeId: 'emp-1', employeeName: 'Test Employee', email: 'test@example.test', deviceId: 'dev-1', deviceName: 'Work PC', acknowledgedAt: '2026-11-01', selected: false, connectivity: 'offline', policyReason: 'DEVICE_NOT_SELECTED' }] };
  mocks.captures = { captures: [{ id: 'cap-1', employeeName: 'Test Employee', deviceName: 'Work PC', capturedAt: '2026-11-06T10:00:00Z', imageUrl: '/api/v1/screen-monitoring/captures/cap-1/image?token=test', width: 100, height: 100 }], totalPages: 1 };
});

it('explains missing enrollment and does not fabricate devices', () => {
  mocks.employees = { employees: [] };
  render(<ScreenMonitoringPage />);
  expect(screen.getByText('No Windows desktop agent enrolled')).toBeInTheDocument();
  expect(screen.getByText(/Installing the application is not enrollment/)).toBeInTheDocument();
});

it('shows policy and heartbeat diagnostics and selects the exact device', async () => {
  render(<ScreenMonitoringPage />);
  expect(screen.getByText('Select this device for screenshot monitoring.')).toBeInTheDocument();
  expect(screen.getByText(/Never received/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
  await waitFor(() => expect(mocks.updateDevice).toHaveBeenCalledWith('dev-1', true));
});

it('saves existing policy settings and displays confirmation', async () => {
  mocks.updateSettings.mockResolvedValue(mocks.settings);
  render(<ScreenMonitoringPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Save monitoring policy' }));
  await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(mocks.settings.settings));
  expect(await screen.findByText(/Screen monitoring policy saved/)).toBeInTheDocument();
});

it('uses returned image URLs, opens the viewer, filters and deletes the selected capture', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ScreenMonitoringPage />);
  const thumbnail = screen.getByAltText('Work screen captured for Test Employee');
  expect(thumbnail).toHaveAttribute('src', mocks.captures.captures[0].imageUrl);
  fireEvent.click(thumbnail);
  expect(screen.getByRole('dialog', { name: 'Screenshot viewer' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  await waitFor(() => expect(mocks.deleteCapture).toHaveBeenCalledWith('cap-1'));
  fireEvent.change(screen.getByPlaceholderText('Search employee'), { target: { value: 'Test' } });
  await waitFor(() => expect(mocks.query).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'Test', page: 1, pageSize: 12 })));
  vi.restoreAllMocks();
});

it('preserves a valid signed thumbnail URL across gallery polls to prevent duplicate image downloads', () => {
  const futureExpires = Date.now() + 4 * 60_000;
  const firstUrl = `/api/v1/screen-monitoring/captures/cap-1/image?expires=${futureExpires}&token=first`;
  const secondUrl = `/api/v1/screen-monitoring/captures/cap-1/image?expires=${futureExpires + 15_000}&token=second`;
  mocks.captures = {
    captures: [{ id: 'cap-1', employeeName: 'Test Employee', deviceName: 'Work PC', capturedAt: '2026-11-06T10:00:00Z', imageUrl: firstUrl, width: 100, height: 100 }],
    totalPages: 1,
  };
  const { rerender } = render(<ScreenMonitoringPage />);
  expect(screen.getByAltText('Work screen captured for Test Employee')).toHaveAttribute('src', firstUrl);

  mocks.captures = {
    captures: [{ id: 'cap-1', employeeName: 'Test Employee', deviceName: 'Work PC', capturedAt: '2026-11-06T10:00:00Z', imageUrl: secondUrl, width: 100, height: 100 }],
    totalPages: 1,
  };
  rerender(<ScreenMonitoringPage />);
  expect(screen.getByAltText('Work screen captured for Test Employee')).toHaveAttribute('src', firstUrl);
});
