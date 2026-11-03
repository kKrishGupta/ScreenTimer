import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('employee device setup profile', () => {
  it('reports pending enrollment and no activity without a device, and never exposes device credentials', async () => {
    const employee = {
      id: 'employee-setup-profile-1',
      organizationId: 'org-setup-1',
      role: 'EMPLOYEE',
      displayName: 'Taylor Example',
      email: 'taylor@example.com',
      employmentStatus: 'active',
      monitoringAuthorized: true,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      devices: [],
    };
    const prisma = {
      user: { findMany: async () => [employee] },
      activitySession: { findMany: async () => [] },
      policyViolation: { count: async () => 0 },
    };
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }),
      prisma,
      logger: false,
    });
    const session = await app.authService.createTestSession({
      userId: employee.id,
      email: employee.email,
      displayName: employee.displayName,
      role: 'EMPLOYEE',
      organizationId: employee.organizationId,
    });

    const response = await app.inject({ method: 'GET', url: `/api/v1/employees/${employee.id}`, headers: session.headers });
    assert.equal(response.statusCode, 200, response.body);
    const profile = response.json().employee;
    assert.equal(profile.deviceStatus, 'NOT_CONNECTED');
    assert.equal(profile.enrollmentStatus, 'PENDING');
    assert.equal(profile.monitoringStatus, 'NOT_STARTED');
    assert.equal(profile.lastHeartbeatAt, null);
    assert.deepEqual(profile.analytics, {
      hasData: false,
      totalMonitoredSeconds: null,
      activeSeconds: null,
      idleSeconds: null,
      policyViolationsCount: null,
      firstActiveAt: null,
      lastActiveAt: null,
      applicationUsage: [],
      websiteUsage: [],
    });
    assert.equal(JSON.stringify(profile).includes('secretHash'), false);
    assert.equal(JSON.stringify(profile).includes('secretSalt'), false);
    await app.close();
  });
});
