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
    const { reportingPeriod, ...emptyAnalytics } = profile.analytics;
    assert.deepEqual(emptyAnalytics, {
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
    assert.equal(reportingPeriod.timezone, 'UTC');
    assert.match(reportingPeriod.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(new Date(reportingPeriod.end) > new Date(reportingPeriod.start));
    assert.equal(JSON.stringify(profile).includes('secretHash'), false);
    assert.equal(JSON.stringify(profile).includes('secretSalt'), false);
    await app.close();
  });

  it('returns one organization-local reporting window with clipped, exclusive app and website breakdowns', async () => {
    const employee = {
      id: 'employee-analytics-1', organizationId: 'org-analytics-1', role: 'EMPLOYEE',
      displayName: 'Analytics Employee', email: 'analytics@example.com', employmentStatus: 'active',
      monitoringAuthorized: true, createdAt: new Date('2026-11-01T00:00:00Z'),
      devices: [{ id: 'desktop-1', userId: 'employee-analytics-1', kind: 'DESKTOP_AGENT', isRevoked: false }],
    };
    const now = new Date();
    const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
    const at = (minutes) => new Date(day.getTime() + minutes * 60000);
    const editor = { executableName: 'editor.exe', displayName: 'Editor.exe' };
    const terminal = { executableName: 'terminal.exe', displayName: 'Terminal.exe' };
    const sessions = [
      { id: 'a', activityEventId: 'a', deviceId: 'desktop-1', type: 'APP_SESSION', startedAt: at(-5), endedAt: at(5), application: editor },
      { id: 'b', activityEventId: 'b', deviceId: 'desktop-1', type: 'APP_SESSION', startedAt: at(3), endedAt: at(10), application: terminal },
      { id: 'b-copy', activityEventId: 'b', deviceId: 'desktop-1', type: 'APP_SESSION', startedAt: at(3), endedAt: at(10), application: terminal },
      { id: 'web', activityEventId: 'web', deviceId: 'desktop-1', type: 'WEB_SESSION', startedAt: at(10), endedAt: at(12), website: { domain: 'www.github.com' } },
      { id: 'idle', activityEventId: 'idle', deviceId: 'desktop-1', type: 'IDLE_SESSION', startedAt: at(8), endedAt: at(15) },
    ];
    let activityWhere;
    const prisma = {
      user: { findMany: async () => [employee] },
      organization: { findUnique: async () => ({ timezone: 'UTC' }) },
      activitySession: { findMany: async ({ where }) => { activityWhere = where; return sessions; } },
      policyViolation: { count: async () => 0 },
    };
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }), prisma, logger: false,
    });
    const admin = await app.authService.createTestSession({ role: 'ADMIN', organizationId: employee.organizationId });
    const response = await app.inject({ method: 'GET', url: `/api/v1/employees/${employee.id}`, headers: admin.headers });
    assert.equal(response.statusCode, 200, response.body);
    const analytics = response.json().employee.analytics;
    assert.equal(analytics.reportingPeriod.timezone, 'UTC');
    assert.equal(analytics.activeSeconds, 720);
    assert.equal(analytics.idleSeconds, 180);
    assert.equal(analytics.totalMonitoredSeconds, 900);
    assert.deepEqual(analytics.applicationUsage.map(({ name, seconds }) => ({ name, seconds })), [
      { name: 'Terminal.exe', seconds: 420 },
      { name: 'Editor.exe', seconds: 180 },
    ]);
    assert.deepEqual(analytics.websiteUsage.map(({ name, seconds }) => ({ name, seconds })), [
      { name: 'github.com', seconds: 120 },
    ]);
    assert.ok(activityWhere.startedAt.lt instanceof Date);
    assert.ok(activityWhere.endedAt.gt instanceof Date);
    await app.close();
  });
});
