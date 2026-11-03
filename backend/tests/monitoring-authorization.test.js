import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { getMonitoringAuthorization, isEventWithinSchedule } from '../src/modules/devices/monitoring-authorization.js';

function authorizedUser(overrides = {}) {
  return {
    id: 'employee-1',
    organizationId: 'org-1',
    employmentStatus: 'active',
    monitoringAuthorized: true,
    monitoringConsentAt: new Date('2026-01-01T00:00:00.000Z'),
    monitoringConsentRevokedAt: null,
    shiftStart: '09:00',
    shiftEnd: '17:00',
    workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    organization: { timezone: 'UTC' },
    ...overrides,
  };
}

test('monitoring fails closed when consent, organization time zone, or schedule is missing', () => {
  assert.equal(getMonitoringAuthorization(authorizedUser({ monitoringConsentAt: null }), new Date('2026-11-03T10:00:00Z')).reason, 'USER_CONSENT_REQUIRED');
  assert.equal(getMonitoringAuthorization(authorizedUser({ organization: { timezone: null } }), new Date('2026-11-03T10:00:00Z')).reason, 'ORGANIZATION_TIMEZONE_REQUIRED');
  assert.equal(getMonitoringAuthorization(authorizedUser({ shiftStart: null }), new Date('2026-11-03T10:00:00Z')).reason, 'SCHEDULE_NOT_CONFIGURED');
});

test('schedule authorization observes the current time and returns the exact shift end', () => {
  const status = getMonitoringAuthorization(authorizedUser(), new Date('2026-11-03T10:00:00.000Z'));
  assert.equal(status.allowed, true);
  assert.equal(status.allowedUntil, '2026-11-03T17:00:00.000Z');
  assert.equal(getMonitoringAuthorization(authorizedUser(), new Date('2026-11-03T18:00:00.000Z')).reason, 'OUTSIDE_SCHEDULE');
  assert.equal(getMonitoringAuthorization(authorizedUser(), new Date('2026-11-07T10:00:00.000Z')).reason, 'OUTSIDE_SCHEDULE');
});

test('overnight schedule carries the prior working day through midnight', () => {
  const user = authorizedUser({ shiftStart: '22:00', shiftEnd: '06:00', workingDays: ['Thu'] });
  const status = getMonitoringAuthorization(user, new Date('2026-11-06T02:00:00.000Z'));
  assert.equal(status.allowed, true);
  assert.equal(status.allowedUntil, '2026-11-06T06:00:00.000Z');
  assert.equal(isEventWithinSchedule(user, '2026-11-05T23:50:00.000Z', '2026-11-06T00:10:00.000Z'), true);
  assert.equal(isEventWithinSchedule(user, '2026-11-06T05:50:00.000Z', '2026-11-06T06:01:00.000Z'), false);
});

test('schedule windows resolve repeated and skipped local times around daylight saving changes', () => {
  const repeated = authorizedUser({
    shiftStart: '01:30', shiftEnd: '02:30', workingDays: ['Sun'],
    organization: { timezone: 'America/New_York' },
  });
  const fallBack = getMonitoringAuthorization(repeated, new Date('2026-11-01T05:45:00.000Z'));
  assert.equal(fallBack.allowed, true);
  assert.equal(fallBack.allowedFrom, '2026-11-01T05:30:00.000Z');
  assert.equal(fallBack.allowedUntil, '2026-11-01T07:30:00.000Z');

  const skipped = authorizedUser({
    shiftStart: '02:30', shiftEnd: '04:00', workingDays: ['Sun'],
    organization: { timezone: 'America/New_York' },
  });
  const springForward = getMonitoringAuthorization(skipped, new Date('2026-03-08T07:15:00.000Z'));
  assert.equal(springForward.allowed, true);
  assert.equal(springForward.allowedFrom, '2026-03-08T07:00:00.000Z');
  assert.equal(springForward.allowedUntil, '2026-03-08T08:00:00.000Z');
});

test('authenticated admin can set organization time zone, own schedule, consent, and self-enrollment only', async (t) => {
  const adminId = 'monitoring-admin-1';
  const orgId = 'monitoring-org-1';
  const owner = {
    id: adminId, organizationId: orgId, employmentStatus: 'active', monitoringAuthorized: false,
    monitoringConsentAt: null, monitoringConsentRevokedAt: null, monitoringConsentVersion: null,
    shiftStart: null, shiftEnd: null, workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    organization: { timezone: null },
  };
  const tokenRows = [];
  const logs = [];
  const consentTargets = [];
  const prisma = {
    user: {
      findUnique: async ({ where }) => where.id === owner.id ? { ...owner, organization: { ...owner.organization } } : null,
      findFirst: async ({ where }) => where.id === owner.id && where.organizationId === owner.organizationId ? { id: owner.id } : null,
      updateMany: async ({ where, data }) => {
        consentTargets.push(where.id);
        if (where.id !== owner.id || where.organizationId !== owner.organizationId) return { count: 0 };
        Object.assign(owner, data);
        return { count: 1 };
      },
    },
    organization: {
      updateMany: async ({ where, data }) => {
        if (where.id !== orgId) return { count: 0 };
        Object.assign(owner.organization, data);
        return { count: 1 };
      },
    },
    deviceEnrollmentToken: { create: async ({ data }) => { tokenRows.push(data); return data; } },
    auditLog: { create: async ({ data }) => { logs.push(data); return data; } },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }), prisma, logger: false });
  t.after(() => app.close());
  const session = await app.authService.createTestSession({ userId: adminId, role: 'ORG_ADMIN', organizationId: orgId, email: 'admin@example.com' });

  const initial = await app.inject({ method: 'GET', url: '/api/v1/devices/my-monitoring-status', headers: session.headers });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().monitoring.reason, 'ADMIN_AUTHORIZATION_REQUIRED');

  const timezone = await app.inject({ method: 'PATCH', url: '/api/v1/devices/organization-timezone', headers: session.headers, payload: { timezone: 'Asia/Kolkata' } });
  assert.equal(timezone.statusCode, 200);
  const schedule = await app.inject({ method: 'PATCH', url: '/api/v1/devices/my-monitoring-schedule', headers: session.headers, payload: { shiftStart: '22:00', shiftEnd: '06:00', workingDays: ['Thu'] } });
  assert.equal(schedule.statusCode, 200);
  const consent = await app.inject({ method: 'POST', url: '/api/v1/devices/my-monitoring-consent', headers: session.headers, payload: { consent: true, userId: 'someone-else' } });
  assert.equal(consent.statusCode, 200);
  assert.equal(owner.monitoringConsentAt instanceof Date, true);

  const authorization = await app.inject({ method: 'PATCH', url: '/api/v1/devices/my-monitoring-authorization', headers: session.headers, payload: { authorized: true, userId: 'someone-else' } });
  assert.equal(authorization.statusCode, 200);
  assert.equal(owner.monitoringAuthorized, true);
  assert.ok(consentTargets.length >= 1 && consentTargets.every((targetId) => targetId === adminId));
  assert.equal(logs.some((log) => log.action === 'ACTIVITY_MONITORING_CONSENT_GRANTED'), true);
  assert.equal(logs.some((log) => log.action === 'ACTIVITY_MONITORING_ADMIN_AUTHORIZED'), true);

  const tokenResponse = await app.inject({ method: 'POST', url: '/api/v1/devices/my-enrollment-token', headers: session.headers, payload: { deviceKind: 'BROWSER_EXTENSION', userId: 'someone-else' } });
  assert.equal(tokenResponse.statusCode, 201, JSON.stringify(tokenResponse.json()));
  assert.equal(tokenRows.length, 1);
  assert.equal(tokenRows[0].userId, adminId);
  assert.equal(tokenRows[0].organizationId, orgId);
  assert.equal(tokenRows[0].token, undefined);

  const employeeSession = await app.authService.createTestSession({ userId: 'monitoring-employee-2', role: 'EMPLOYEE', organizationId: orgId, email: 'employee@example.com' });
  const deniedSelfAuthorization = await app.inject({ method: 'PATCH', url: '/api/v1/devices/my-monitoring-authorization', headers: employeeSession.headers, payload: { authorized: true } });
  assert.equal(deniedSelfAuthorization.statusCode, 403);
});

test('only an organization administrator can authorize an employee within its own organization', async (t) => {
  const organizationId = 'monitoring-org-2';
  const employee = {
    id: 'monitoring-employee-3', organizationId, role: 'EMPLOYEE', employmentStatus: 'active',
    monitoringAuthorized: false, monitoringConsentAt: null, workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  };
  const auditRows = [];
  const prisma = {
    user: {
      findFirst: async ({ where }) => employee.id === where.id && employee.organizationId === where.organizationId && employee.role === where.role ? { id: employee.id } : null,
      findMany: async () => [{ ...employee, devices: [] }],
      updateMany: async ({ where, data }) => {
        if (where.id !== employee.id || where.organizationId !== employee.organizationId) return { count: 0 };
        Object.assign(employee, data);
        return { count: 1 };
      },
    },
    auditLog: { create: async ({ data }) => { auditRows.push(data); return data; } },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }), prisma, logger: false });
  t.after(() => app.close());
  const admin = await app.authService.createTestSession({ userId: 'monitoring-admin-2', role: 'ORG_ADMIN', organizationId, email: 'admin@example.com' });
  const otherAdmin = await app.authService.createTestSession({ userId: 'monitoring-admin-3', role: 'ORG_ADMIN', organizationId: 'monitoring-org-3', email: 'other-admin@example.com' });
  const manager = await app.authService.createTestSession({ userId: 'monitoring-manager-2', role: 'MANAGER', organizationId, email: 'manager@example.com' });

  const deniedManager = await app.inject({ method: 'PATCH', url: `/api/v1/employees/${employee.id}/monitoring-authorization`, headers: manager.headers, payload: { authorized: true } });
  assert.equal(deniedManager.statusCode, 403);
  const deniedCrossTenant = await app.inject({ method: 'PATCH', url: `/api/v1/employees/${employee.id}/monitoring-authorization`, headers: otherAdmin.headers, payload: { authorized: true } });
  assert.equal(deniedCrossTenant.statusCode, 404);
  const authorized = await app.inject({ method: 'PATCH', url: `/api/v1/employees/${employee.id}/monitoring-authorization`, headers: admin.headers, payload: { authorized: true } });
  assert.equal(authorized.statusCode, 200, authorized.body);
  assert.equal(employee.monitoringAuthorized, true);
  assert.equal(auditRows[0].action, 'ACTIVITY_MONITORING_ADMIN_AUTHORIZED');
});
