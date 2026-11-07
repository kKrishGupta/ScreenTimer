import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDevicePolicy, localScheduleState, runScreenshotRetentionCleanup } from '../src/modules/screen/screen.routes.js';

const mondayAtNoonUtc = new Date('2026-11-02T12:00:00.000Z');

function eligibleDevice(overrides = {}) {
  return { id: 'device-1', kind: 'DESKTOP_AGENT', organizationId: 'org-1', userId: 'employee-1', isRevoked: false, screenCaptureEnabled: true, ...overrides };
}

function activeOwner(overrides = {}) {
  return {
    id: 'employee-1', organizationId: 'org-1', employmentStatus: 'active', monitoringAuthorized: true,
    monitoringConsentAt: new Date('2026-01-01T00:00:00.000Z'), monitoringConsentRevokedAt: null,
    screenMonitoringAcknowledgedAt: new Date('2026-01-01T00:00:00.000Z'), workingDays: ['Mon'],
    shiftStart: '09:00', shiftEnd: '18:00', organization: { timezone: 'UTC' }, ...overrides,
  };
}

function prismaFor({ owner = activeOwner(), setting = {} } = {}) {
  return {
    user: { findUnique: async () => owner },
    screenMonitoringSetting: { findUnique: async () => ({
      organizationId: 'org-1', enabled: true, captureIntervalSeconds: 300, retentionDays: 30,
      workingDays: ['Mon'], shiftStart: '09:00', shiftEnd: '18:00',
      excludedApplications: ['1password.exe'], ...setting,
    }) },
  };
}

test('device ownership, consent, revocation and authorization gates fail closed', async () => {
  for (const device of [null, eligibleDevice({ kind: 'BROWSER_EXTENSION' }), eligibleDevice({ isRevoked: true }), eligibleDevice({ userId: null })]) {
    assert.equal((await evaluateDevicePolicy(prismaFor(), device, mondayAtNoonUtc)).allowed, false);
  }
  for (const owner of [activeOwner({ organizationId: 'other-org' }), activeOwner({ monitoringConsentAt: null }), activeOwner({ monitoringConsentRevokedAt: new Date() }), activeOwner({ monitoringAuthorized: false }), activeOwner({ employmentStatus: 'disabled' })]) {
    assert.equal((await evaluateDevicePolicy(prismaFor({ owner }), eligibleDevice(), mondayAtNoonUtc)).allowed, false);
  }
});

test('eligible acknowledged employee receives the five-minute screenshot policy', async () => {
  const result = await evaluateDevicePolicy(prismaFor(), eligibleDevice(), mondayAtNoonUtc);
  assert.equal(result.allowed, true);
  assert.equal(result.intervalSeconds, 300);
  assert.deepEqual(result.excludedApplications, ['1password.exe']);
  assert.equal(result.visibleIndicator, true);
});

test('disabled policy and missing employee acknowledgement stop capture', async () => {
  const disabled = await evaluateDevicePolicy(prismaFor({ setting: { enabled: false } }), eligibleDevice(), mondayAtNoonUtc);
  assert.equal(disabled.reason, 'SCREEN_MONITORING_DISABLED');

  const noNotice = await evaluateDevicePolicy(
    prismaFor({ owner: activeOwner({ screenMonitoringAcknowledgedAt: null }) }), eligibleDevice(), mondayAtNoonUtc,
  );
  assert.equal(noNotice.reason, 'SCREEN_NOTICE_NOT_ACKNOWLEDGED');
});

test('unselected devices and after-hours captures are rejected', async () => {
  const unselected = await evaluateDevicePolicy(prismaFor(), eligibleDevice({ screenCaptureEnabled: false }), mondayAtNoonUtc);
  assert.equal(unselected.reason, 'DEVICE_NOT_SELECTED');
  const afterHours = await evaluateDevicePolicy(prismaFor(), eligibleDevice(), new Date('2026-11-02T20:00:00.000Z'));
  assert.equal(afterHours.reason, 'OUTSIDE_SCHEDULE');
});

test('organization screenshot schedule supports overnight windows', () => {
  const setting = { workingDays: ['Mon'], shiftStart: '22:00', shiftEnd: '06:00' };
  assert.equal(localScheduleState(setting, 'UTC', new Date('2026-11-02T23:00:00Z')).allowed, true);
  assert.equal(localScheduleState(setting, 'UTC', new Date('2026-11-03T05:00:00Z')).allowed, true);
  assert.equal(localScheduleState(setting, 'UTC', new Date('2026-11-03T07:00:00Z')).allowed, false);
});

test('retention cleanup preserves metadata when object deletion fails', async () => {
  const deletedRows = [];
  const prisma = { screenCaptureMetadata: {
    findMany: async () => [
      { id: 'ok', organizationId: 'org-1', storageKey: 'org-1/device/ok.jpg.enc' },
      { id: 'failed', organizationId: 'org-1', storageKey: 'org-1/device/failed.jpg.enc' },
    ],
    delete: async ({ where }) => deletedRows.push(where.id),
  } };
  const store = { delete: async (key) => { if (key.includes('failed')) throw new Error('storage unavailable'); } };
  const result = await runScreenshotRetentionCleanup(prisma, store, { error() {} });
  assert.deepEqual(result, { deleted: 1, failed: 1 });
  assert.deepEqual(deletedRows, ['ok']);
});
