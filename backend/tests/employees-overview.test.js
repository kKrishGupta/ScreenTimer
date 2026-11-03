import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('organization employee overview data', () => {
  it('scopes employee totals and derives live states from persisted heartbeat and activity records', async () => {
    const organizationId = 'overview-org-1';
    const now = Date.now();
    const makeDevice = (id, userId, { seenAt = null, revoked = false } = {}) => ({
      id, organizationId, userId, name: id, kind: 'DESKTOP_AGENT', platform: 'windows', browser: null,
      agentVersion: '1.0.0', isRevoked: revoked, lastSeenAt: seenAt ? new Date(seenAt) : null, lastSyncAt: null,
    });
    const makeEmployee = (id, extra = {}) => ({
      id, organizationId, role: 'EMPLOYEE', displayName: id, email: `${id}@example.com`, employmentStatus: 'active',
      monitoringAuthorized: true, createdAt: new Date(), devices: [], ...extra,
    });
    const working = makeEmployee('working', { devices: [makeDevice('device-working', 'working', { seenAt: now })] });
    const connected = makeEmployee('connected', { devices: [makeDevice('device-connected', 'connected', { seenAt: now })] });
    const offline = makeEmployee('offline', { devices: [makeDevice('device-offline', 'offline', { seenAt: now - 10 * 60_000 })] });
    const pending = makeEmployee('pending');
    const revoked = makeEmployee('revoked', { devices: [makeDevice('device-revoked', 'revoked', { revoked: true })] });
    const manager = { ...makeEmployee('manager'), role: 'MANAGER' };
    const terminated = makeEmployee('terminated', { employmentStatus: 'terminated' });
    const users = [working, connected, offline, pending, revoked, manager, terminated];
    const recentSession = {
      id: 'recent-app-session', organizationId, type: 'APP_SESSION', startedAt: new Date(now - 60_000), endedAt: new Date(now - 10_000),
      durationSeconds: 50, application: { displayName: 'Editor', executableName: 'editor.exe' }, website: null,
      device: { userId: working.id },
    };
    const prisma = {
      user: {
        findMany: async ({ where }) => users.filter((user) => (!where.role || user.role === where.role) && (!where.organizationId || user.organizationId === where.organizationId)),
      },
      activitySession: { findMany: async () => [recentSession] },
    };
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }),
      prisma,
      logger: false,
    });
    const admin = await app.authService.createTestSession({ role: 'ORGANIZATION_ADMIN', organizationId });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/employees', headers: admin.headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().totalCount, 5, 'managers and terminated users are not counted as active employees');

    const response = await app.inject({ method: 'GET', url: '/api/v1/employees/live', headers: admin.headers });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.summary, {
      totalEmployees: 5,
      activeCount: 1,
      idleCount: 0,
      offlineCount: 1,
      connectedCount: 1,
      pendingEnrollmentCount: 1,
      revokedCount: 1,
    });
    assert.equal(body.employees.find((employee) => employee.id === working.id).liveStatus, 'WORKING');
    assert.equal(body.employees.find((employee) => employee.id === connected.id).liveStatus, 'CONNECTED');
    assert.equal(body.employees.find((employee) => employee.id === offline.id).liveStatus, 'OFFLINE');
    assert.equal(body.employees.find((employee) => employee.id === pending.id).liveStatus, 'NOT_ENROLLED');
    assert.equal(body.employees.find((employee) => employee.id === revoked.id).liveStatus, 'REVOKED');
    await app.close();
  });
});
