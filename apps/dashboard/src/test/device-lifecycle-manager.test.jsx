import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DeviceLifecycleManager from '../components/devices/DeviceLifecycleManager.jsx';

const mocks = vi.hoisted(() => ({
  revoke: vi.fn(), archive: vi.fn(), restore: vi.fn(), deleteDevice: vi.fn(), authorize: vi.fn(),
  details: vi.fn(), audit: vi.fn(), bulk: vi.fn(), duplicates: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({ api: {
  revokeDevice: mocks.revoke,
  archiveDevice: mocks.archive,
  restoreDevice: mocks.restore,
  deleteDevice: mocks.deleteDevice,
  updateScreenDevice: mocks.authorize,
  deviceDetails: mocks.details,
  deviceAudit: mocks.audit,
  bulkDeviceAction: mocks.bulk,
  duplicateDeviceReview: mocks.duplicates,
  revokeEnrollmentToken: mocks.revokeToken,
} }));

const active = {
  id: 'device-active', name: 'Chrome Work', kind: 'browser_extension', browser: 'chrome', platform: 'windows',
  lifecycleStatus: 'ACTIVE', connectionStatus: 'ONLINE', authorizationStatus: 'AUTHORIZED', screenCaptureEnabled: true,
  assignedUser: { displayName: 'Alice', email: 'alice@example.test' }, createdAt: '2026-11-01T10:00:00Z', lastSeenAt: '2026-11-08T10:00:00Z',
};
const archived = { ...active, id: 'device-archived', name: 'Old PC', lifecycleStatus: 'ARCHIVED', connectionStatus: 'OFFLINE', authorizationStatus: 'UNAUTHORIZED', screenCaptureEnabled: false };
const revoked = { ...active, id: 'device-revoked', name: 'Revoked Chrome', lifecycleStatus: 'REVOKED', connectionStatus: 'OFFLINE', authorizationStatus: 'UNAUTHORIZED', screenCaptureEnabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revoke.mockResolvedValue({ success: true });
  mocks.archive.mockResolvedValue({ success: true });
  mocks.restore.mockResolvedValue({ success: true });
  mocks.deleteDevice.mockResolvedValue({ success: true });
  mocks.authorize.mockResolvedValue({ success: true });
});

it('keeps lifecycle, connection, authorization and pending enrollment as separate filterable states', () => {
  render(<DeviceLifecycleManager devices={[active, archived]} pendingEnrollments={[{ id: 'token-1', lifecycleStatus: 'PENDING', connectionStatus: 'UNKNOWN', authorizationStatus: 'UNAUTHORIZED', deviceKind: 'DESKTOP_AGENT' }]} reload={vi.fn()} announce={vi.fn()} />);
  expect(screen.getAllByText('Alice')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
  expect(screen.getByText('Enrollment pending')).toBeInTheDocument();
  expect(screen.queryByText('Chrome Work')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
  expect(screen.getByText('Old PC')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
});

it('requires confirmation and passes the administrator reason when revoking', async () => {
  const reload = vi.fn().mockResolvedValue();
  const announce = vi.fn();
  render(<DeviceLifecycleManager devices={[active]} reload={reload} announce={announce} />);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(screen.getByText(/Revocation is permanent/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Employee offboarded' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('device-active', 'Employee offboarded'));
  expect(reload).toHaveBeenCalled();
  expect(announce).toHaveBeenCalledWith('Device revoke completed successfully.');
});

it('reports partial bulk results and keeps failed devices selected for recovery', async () => {
  mocks.bulk.mockResolvedValue({ results: [
    { deviceId: 'device-active', success: true },
    { deviceId: 'device-archived', success: false, message: 'Already archived' },
  ] });
  const announce = vi.fn();
  render(<DeviceLifecycleManager devices={[active, { ...archived, lifecycleStatus: 'ACTIVE' }]} reload={vi.fn()} announce={announce} />);
  fireEvent.click(screen.getByLabelText('Select Chrome Work'));
  fireEvent.click(screen.getByLabelText('Select Old PC'));
  fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(mocks.bulk).toHaveBeenCalledWith('archive', ['device-active', 'device-archived'], '', undefined));
  expect(announce).toHaveBeenCalledWith('1 of 2 devices archived. 1 failed: Already archived');
  expect(screen.getByText('1 selected')).toBeInTheDocument();
});

it('offers permanent deletion only for revoked devices and requires typing DELETE', async () => {
  const reload = vi.fn().mockResolvedValue();
  const announce = vi.fn();
  render(<DeviceLifecycleManager devices={[active, revoked]} reload={reload} announce={announce} />);
  expect(screen.getAllByRole('button', { name: 'Delete Permanently' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }));
  expect(screen.getByText('This device will be permanently removed from your device list.')).toBeInTheDocument();
  expect(screen.getByText('device-revoked')).toBeInTheDocument();
  const confirm = screen.getAllByRole('button', { name: 'Delete Permanently' }).find((button) => button.disabled);
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.deleteDevice).toHaveBeenCalledWith('device-revoked', 'DELETE'));
  expect(reload).toHaveBeenCalled();
  expect(announce).toHaveBeenCalledWith('Device permanently removed successfully.');
});
