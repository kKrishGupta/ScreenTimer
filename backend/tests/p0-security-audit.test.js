import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { hashPassword, Roles } from '../src/modules/auth/auth.service.js';

function createAuditTestPrisma() {
  const users = [];
  const sessions = [];
  const devices = [];
  const tokens = [];
  const policies = [];
  const captures = [];
  const auditLogs = [];
  const orgs = [
    { id: 'org-1111-aaaa-1111-aaaaaaaaaaaa', name: 'Acme Corp', slug: 'acme', timezone: 'UTC' },
    { id: 'org-2222-bbbb-2222-bbbbbbbbbbbb', name: 'Beta Ltd', slug: 'beta', timezone: 'UTC' },
  ];

  return {
    organization: {
      findUnique: async ({ where }) => orgs.find((o) => o.id === where.id || o.slug === where.slug) || null,
      create: async ({ data }) => {
        const row = { id: `org-${Date.now()}`, ...data };
        orgs.push(row);
        return row;
      },
    },
    user: {
      findFirst: async ({ where }) => users.find((u) => {
        const { OR, ...scalarFilters } = where || {};
        const matchesScalar = Object.entries(scalarFilters).every(([key, value]) => u[key] === value);
        return matchesScalar && (!OR || OR.some((clause) => Object.entries(clause).every(([key, value]) => u[key] === value)));
      }) || null,
      findUnique: async ({ where, include }) => {
        const user = users.find((u) => u.id === where.id) || null;
        if (!user || !include?.organization) return user;
        return { ...user, organization: orgs.find((org) => org.id === user.organizationId) || null };
      },
      findMany: async ({ where }) => {
        let res = [...users];
        if (where?.organizationId) res = res.filter((u) => u.organizationId === where.organizationId);
        if (where?.email) {
          const email = typeof where.email === 'string' ? where.email : where.email.equals;
          res = res.filter((u) => u.email === email);
        }
        return res;
      },
      create: async ({ data }) => {
        const row = { id: data.id || `usr-${users.length + 1}`, ...data };
        users.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const u = users.find((item) => item.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      },
      updateMany: async ({ where, data }) => {
        const matching = users.filter((u) => (where.id && u.id === where.id) || (where.email && u.email === where.email));
        matching.forEach((u) => Object.assign(u, data));
        return { count: matching.length };
      },
    },
    userSession: {
      create: async ({ data }) => {
        sessions.push({ ...data });
        return data;
      },
      findUnique: async ({ where }) => {
        const s = sessions.find((item) => item.tokenHash === where.tokenHash);
        if (!s) return null;
        const u = users.find((item) => item.id === s.userId);
        return { ...s, user: u };
      },
      updateMany: async ({ where, data }) => {
        const matching = sessions.filter((s) => s.tokenHash === where.tokenHash);
        matching.forEach((s) => Object.assign(s, data));
        return { count: matching.length };
      },
    },
    deviceEnrollmentToken: {
      create: async ({ data }) => {
        tokens.push(data);
        return data;
      },
      findUnique: async ({ where }) => tokens.find((t) => t.token === where.token) || null,
      update: async ({ where, data }) => {
        const t = tokens.find((item) => item.token === where.token);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    device: {
      upsert: async ({ where, create, update }) => {
        let existing = devices.find((d) => d.id === where.id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created = { ...create };
        devices.push(created);
        return created;
      },
      findMany: async ({ where } = {}) => {
        let list = [...devices];
        if (where?.organizationId) list = list.filter((d) => d.organizationId === where.organizationId);
        return list;
      },
      findUnique: async ({ where }) => devices.find((d) => d.id === where.id) || null,
      update: async ({ where, data }) => {
        const d = devices.find((item) => item.id === where.id);
        if (d) Object.assign(d, data);
        return d;
      },
    },
    familyPolicy: {
      findMany: async ({ where } = {}) => {
        let list = [...policies];
        if (where?.organizationId) list = list.filter((p) => p.organizationId === where.organizationId);
        return list;
      },
      create: async ({ data }) => {
        const row = { id: `pol-${policies.length + 1}`, ...data };
        policies.push(row);
        return row;
      },
    },
    screenCaptureMetadata: {
      create: async ({ data }) => {
        captures.push(data);
        return data;
      },
      findMany: async () => captures,
    },
    activityEvent: {
      findUnique: async () => null,
      create: async ({ data }) => data,
    },
    application: {
      upsert: async ({ create }) => ({ id: 'app-1', ...create }),
    },
    website: {
      upsert: async ({ create }) => ({ id: 'web-1', ...create }),
    },
    activitySession: {
      create: async ({ data }) => data,
      findMany: async () => [],
      count: async () => 0,
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push(data);
        return data;
      },
    },
    $transaction: async (fn) => fn(createAuditTestPrisma()),
  };
}

describe('P0 Security Hardening & Multi-Tenant Audit Verification', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://security:audit@127.0.0.1:5433/audit_db',
    LOG_LEVEL: 'silent',
  });

  // Helper: sets up app with test users and sessions
  async function setupEnvironment() {
    const prisma = createAuditTestPrisma();
    const app = await buildApp({ config, prisma, logger: false });

    async function seedUser({ id, email, password, displayName, role, organizationId }) {
      const { hash, salt } = hashPassword(password);
      return prisma.user.create({
        data: {
          id,
          email,
          displayName,
          role,
          organizationId,
          employmentStatus: 'active',
          monitoringAuthorized: true,
          monitoringConsentAt: new Date('2026-01-01T00:00:00.000Z'),
          monitoringConsentRevokedAt: null,
          shiftStart: '00:00',
          shiftEnd: '23:59',
          workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          passwordHash: hash,
          passwordSalt: salt,
        },
      });
    }

    // Org A Admin
    await seedUser({
      id: 'admin-a',
      email: 'admin_a@acme.com',
      password: 'AdminPassword123!',
      displayName: 'Acme Admin',
      role: Roles.ORGANIZATION_ADMIN,
      organizationId: 'org-1111-aaaa-1111-aaaaaaaaaaaa',
    });
    const loginAdminA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin_a@acme.com', password: 'AdminPassword123!' },
    });
    const tokenAdminA = loginAdminA.headers['set-cookie'].split(';')[0].split('=')[1];

    // Org A Employee 1
    await seedUser({
      id: 'emp-a-1',
      email: 'emp1@acme.com',
      password: 'EmpPassword123!',
      displayName: 'Alice Employee',
      role: Roles.EMPLOYEE,
      organizationId: 'org-1111-aaaa-1111-aaaaaaaaaaaa',
    });
    const loginEmp1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'emp1@acme.com', password: 'EmpPassword123!' },
    });
    const tokenEmp1 = loginEmp1.headers['set-cookie'].split(';')[0].split('=')[1];
    const userEmp1Id = loginEmp1.json().user.id;

    // Org A Employee 2
    await seedUser({
      id: 'emp-a-2',
      email: 'emp2@acme.com',
      password: 'EmpPassword123!',
      displayName: 'Bob Employee',
      role: Roles.EMPLOYEE,
      organizationId: 'org-1111-aaaa-1111-aaaaaaaaaaaa',
    });
    const loginEmp2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'emp2@acme.com', password: 'EmpPassword123!' },
    });
    const tokenEmp2 = loginEmp2.headers['set-cookie'].split(';')[0].split('=')[1];
    const userEmp2Id = loginEmp2.json().user.id;

    // Org A Manager (Department: Engineering)
    await seedUser({
      id: 'mgr-a',
      email: 'mgr_eng@acme.com',
      password: 'MgrPassword123!',
      displayName: 'Engineering Manager',
      role: Roles.MANAGER,
      organizationId: 'org-1111-aaaa-1111-aaaaaaaaaaaa',
    });
    const loginMgr = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'mgr_eng@acme.com', password: 'MgrPassword123!' },
    });
    const tokenMgr = loginMgr.headers['set-cookie'].split(';')[0].split('=')[1];
    const userMgrId = loginMgr.json().user.id;

    // Assign Emp 1 to Manager, but NOT Emp 2 (Emp 2 in different department / unassigned)
    const emp1User = await prisma.user.findFirst({ where: { email: 'emp1@acme.com' } });
    if (emp1User) emp1User.managerId = userMgrId;

    // Org B Admin
    await seedUser({
      id: 'admin-b',
      email: 'admin_b@beta.com',
      password: 'BetaPassword123!',
      displayName: 'Beta Admin',
      role: Roles.ORGANIZATION_ADMIN,
      organizationId: 'org-2222-bbbb-2222-bbbbbbbbbbbb',
    });
    const loginAdminB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin_b@beta.com', password: 'BetaPassword123!' },
    });
    const tokenAdminB = loginAdminB.headers['set-cookie'].split(';')[0].split('=')[1];

    return {
      app,
      prisma,
      tokens: {
        adminA: tokenAdminA,
        adminB: tokenAdminB,
        emp1: tokenEmp1,
        emp2: tokenEmp2,
        mgr: tokenMgr,
      },
      ids: {
        emp1: userEmp1Id,
        emp2: userEmp2Id,
        mgr: userMgrId,
        orgA: 'org-1111-aaaa-1111-aaaaaaaaaaaa',
        orgB: 'org-2222-bbbb-2222-bbbbbbbbbbbb',
      },
    };
  }

  // 1. Unauthenticated API requests must return HTTP 401
  it('1. Rejects unauthenticated requests across all protected endpoints with HTTP 401', async () => {
    const { app } = await setupEnvironment();

    const protectedUrls = [
      { method: 'GET', url: '/api/v1/devices' },
      { method: 'POST', url: '/api/v1/devices/enrollment-tokens', payload: {} },
      { method: 'GET', url: '/api/v1/employees' },
      { method: 'GET', url: '/api/v1/activity/timeline' },
      { method: 'GET', url: '/api/v1/activity/apps' },
      { method: 'GET', url: '/api/v1/policies' },
      { method: 'GET', url: '/api/v1/screen/captures' },
      { method: 'GET', url: '/api/v1/notifications' },
      { method: 'GET', url: '/api/v1/analytics/daily' },
      { method: 'GET', url: '/api/v1/planner/tasks' },
    ];

    for (const route of protectedUrls) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
      });
      assert.equal(res.statusCode, 401, `Expected 401 for unauthenticated ${route.method} ${route.url}, got ${res.statusCode}`);
      const body = res.json();
      assert.equal(body.error?.code, 'UNAUTHORIZED');
    }
  });

  // 2. Employee accessing another employee's activity must return HTTP 403
  it("2. Blocks employee accessing another employee's activity with HTTP 403", async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Emp 1 attempts to query Emp 2's activity
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/activity/timeline?userId=${ids.emp2}`,
      headers: { authorization: `Bearer ${tokens.emp1}` },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error.message, /Employees may only access their own/i);
  });

  // 3. Manager accessing an unassigned employee must return HTTP 403
  it('3. Blocks manager accessing an unassigned employee with HTTP 403', async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Manager accesses assigned employee 1 -> Allowed
    const allowedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/activity/timeline?userId=${ids.emp1}`,
      headers: { authorization: `Bearer ${tokens.mgr}` },
    });
    if (allowedRes.statusCode !== 200) console.error('ALLOWED RES ERROR:', allowedRes.body);
    assert.equal(allowedRes.statusCode, 200);

    // Manager accesses unassigned employee 2 -> 403 Forbidden
    const blockedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/activity/timeline?userId=${ids.emp2}`,
      headers: { authorization: `Bearer ${tokens.mgr}` },
    });
    assert.equal(blockedRes.statusCode, 403);
    assert.match(blockedRes.json().error.message, /Managers may only access employees within their assigned scope/i);
  });

  // 4. Organization A accessing Organization B records must return HTTP 403
  it('4. Enforces strict tenant isolation: Org A cannot access Org B records (HTTP 403)', async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Admin of Org A attempts to query Org B employees
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/employees?organizationId=${ids.orgB}`,
      headers: { authorization: `Bearer ${tokens.adminA}` },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error?.code, 'CROSS_TENANT_FORBIDDEN');
  });

  // 5. Revoked device submitting events must return HTTP 403
  it('5. Rejects event ingestion from a revoked device with HTTP 403', async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Generate enrollment token as Admin A
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrollment-tokens',
      headers: { authorization: `Bearer ${tokens.adminA}` },
      payload: { organizationId: ids.orgA, userId: ids.emp1, deviceKind: 'DESKTOP_AGENT' },
    });
    if (tokenRes.statusCode !== 201) console.error('TOKEN RES ERROR:', tokenRes.body);
    assert.equal(tokenRes.statusCode, 201);
    const enrollToken = tokenRes.json().token;

    // Enroll device
    const deviceId = '33334444-5555-6666-7777-888899990000';
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enroll',
      payload: { token: enrollToken, deviceId, name: 'Workstation Alpha' },
    });
    if (enrollRes.statusCode !== 201) console.error('ENROLL RES ERROR:', enrollRes.body);
    assert.equal(enrollRes.statusCode, 201);
    const deviceSecret = enrollRes.json().deviceSecret;

    const sampleEvent = {
      schemaVersion: 1,
      eventId: '11111111-2222-3333-4444-555555555555',
      deviceId,
      source: 'desktop_agent',
      type: 'app_session',
      startedAt: '2026-11-01T10:00:00.000Z',
      endedAt: '2026-11-01T10:01:00.000Z',
      durationSeconds: 60,
      app: {
        name: 'Code',
        executable: 'code.exe',
        processId: 100,
      },
    };

    // Ingest event while active -> 200 OK
    const ingestRes1 = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/events/batch',
      headers: { 'x-device-secret': deviceSecret },
      payload: {
        device: { id: deviceId, kind: 'desktop_agent', name: 'Workstation Alpha', platform: 'windows' },
        events: [sampleEvent],
      },
    });
    if (ingestRes1.statusCode !== 200) console.error('INGEST 1 ERROR:', ingestRes1.body);
    assert.equal(ingestRes1.statusCode, 200);

    // Admin revokes device
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/revoke`,
      headers: { authorization: `Bearer ${tokens.adminA}` },
    });
    assert.equal(revokeRes.statusCode, 200);

    // Subsequent ingestion rejected with 403
    const ingestRes2 = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/events/batch',
      headers: { 'x-device-secret': deviceSecret },
      payload: {
        device: { id: deviceId, kind: 'desktop_agent', name: 'Workstation Alpha', platform: 'windows' },
        events: [sampleEvent],
      },
    });
    assert.equal(ingestRes2.statusCode, 403);
    assert.equal(ingestRes2.json().error.code, 'DEVICE_REVOKED');
  });

  // 6. Invalid device credentials must return HTTP 401
  it('6. Rejects event ingestion with invalid device credentials with HTTP 401', async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Generate enrollment token & enroll
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrollment-tokens',
      headers: { authorization: `Bearer ${tokens.adminA}` },
      payload: { organizationId: ids.orgA },
    });
    const deviceId = '44445555-6666-7777-8888-999900001111';
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enroll',
      payload: { token: tokenRes.json().token, deviceId, name: 'Test PC' },
    });

    const sampleEvent = {
      schemaVersion: 1,
      eventId: '22222222-3333-4444-5555-666666666666',
      deviceId,
      source: 'desktop_agent',
      type: 'app_session',
      startedAt: '2026-11-01T10:00:00.000Z',
      endedAt: '2026-11-01T10:01:00.000Z',
      durationSeconds: 60,
      app: {
        name: 'Code',
        executable: 'code.exe',
        processId: 100,
      },
    };

    // Ingest with wrong secret
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/events/batch',
      headers: { 'x-device-secret': 'dp_sec_wrong_invalid_secret_value_12345678' },
      payload: {
        device: { id: deviceId, kind: 'desktop_agent', name: 'Test PC', platform: 'windows' },
        events: [sampleEvent],
      },
    });

    assert.equal(res.statusCode, 401);
  });

  // 7. Device heartbeat authentication (missing, invalid, revoked, valid)
  it('7. Enforces cryptographic device authentication on heartbeat', async () => {
    const { app, tokens, ids } = await setupEnvironment();

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrollment-tokens',
      headers: { authorization: `Bearer ${tokens.adminA}` },
      payload: { organizationId: ids.orgA },
    });
    if (tokenRes.statusCode !== 201) console.error('TOKEN RES 7 ERROR:', tokenRes.body);
    assert.equal(tokenRes.statusCode, 201);

    const deviceId = '55556666-7777-8888-9999-000011112222';
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enroll',
      payload: { token: tokenRes.json().token, deviceId, name: 'Heartbeat PC' },
    });
    if (enrollRes.statusCode !== 201) console.error('ENROLL RES 7 ERROR:', enrollRes.body);
    assert.equal(enrollRes.statusCode, 201);
    const deviceSecret = enrollRes.json().deviceSecret;

    // Heartbeat missing credentials -> 401
    const noSecretRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      payload: { agentVersion: '1.0.0' },
    });
    assert.equal(noSecretRes.statusCode, 401);

    // Heartbeat invalid secret -> 401
    const badSecretRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      headers: { 'x-device-secret': 'dp_sec_incorrect' },
      payload: { agentVersion: '1.0.0' },
    });
    assert.equal(badSecretRes.statusCode, 401);

    // Heartbeat valid credentials -> 200
    const goodSecretRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      headers: { 'x-device-secret': deviceSecret },
      payload: { agentVersion: '1.0.0' },
    });
    assert.equal(goodSecretRes.statusCode, 200);

    // Revoke device
    await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/revoke`,
      headers: { authorization: `Bearer ${tokens.adminA}` },
    });

    // Heartbeat for revoked device -> 403
    const revokedBeatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      headers: { 'x-device-secret': deviceSecret },
      payload: { agentVersion: '1.0.0' },
    });
    assert.equal(revokedBeatRes.statusCode, 403);
    assert.equal(revokedBeatRes.json().error.code, 'DEVICE_REVOKED');
  });

  // 8. Unauthorized screenshot access must return HTTP 403
  it("8. Rejects unauthorized access to other employees' screenshot captures with HTTP 403", async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Emp 1 attempts to query Emp 2's captures
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/screen/captures?employeeId=${ids.emp2}`,
      headers: { authorization: `Bearer ${tokens.emp1}` },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error.message, /Employees may only access their own screenshot captures/i);
  });

  // 9. Unauthorized policy changes must return HTTP 403
  it('9. Rejects unauthorized policy updates by non-admin users with HTTP 403', async () => {
    const { app, tokens } = await setupEnvironment();

    // Employee attempts to modify enterprise policy
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/policies',
      headers: { authorization: `Bearer ${tokens.emp1}` },
      payload: {
        name: 'Employee Relaxed Policy',
        restrictedDomains: [],
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error.message, /Only administrators may configure policies/i);

    // Employee attempts to modify screenshot policy
    const screenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/policy',
      headers: { authorization: `Bearer ${tokens.emp1}` },
      payload: { captureMode: 'manual' },
    });
    assert.equal(screenRes.statusCode, 403);
  });

  // 10. Employee accessing administrative APIs must return HTTP 403
  it('10. Blocks employees from accessing administrative endpoints with HTTP 403', async () => {
    const { app, tokens, ids } = await setupEnvironment();

    // Employee attempts to generate device enrollment token -> 403
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrollment-tokens',
      headers: { authorization: `Bearer ${tokens.emp1}` },
      payload: { organizationId: ids.orgA },
    });
    assert.equal(tokenRes.statusCode, 403);
    assert.match(tokenRes.json().error.message, /not authorized to generate device enrollment tokens/i);

    // Employee attempts to revoke device -> 403
    const revokeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/any-device-id/revoke',
      headers: { authorization: `Bearer ${tokens.emp1}` },
    });
    assert.equal(revokeRes.statusCode, 403);

    // Employee attempts to invite another user -> 403
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/invitations',
      headers: { authorization: `Bearer ${tokens.emp1}` },
      payload: { email: 'newbie@acme.com', role: 'EMPLOYEE' },
    });
    assert.equal(inviteRes.statusCode, 403);
  });
});
