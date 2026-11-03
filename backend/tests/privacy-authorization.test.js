import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { Roles } from '../src/modules/auth/auth.service.js';

function createPrivacyTestPrisma() {
  const orgs = [
    { id: '11111111-1111-1111-1111-111111111111', name: 'Tenant Alpha', slug: 'alpha' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Tenant Beta', slug: 'beta' },
  ];

  const users = [
    {
      id: 'aaaa0001-0000-0000-0000-000000000001',
      organizationId: '11111111-1111-1111-1111-111111111111',
      email: 'alice@alpha.corp',
      displayName: 'Alice Employee',
      role: Roles.EMPLOYEE,
      employmentStatus: 'active',
      isRevoked: false,
    },
    {
      id: 'aaaa0002-0000-0000-0000-000000000002',
      organizationId: '11111111-1111-1111-1111-111111111111',
      email: 'bob@alpha.corp',
      displayName: 'Bob Employee',
      role: Roles.EMPLOYEE,
      employmentStatus: 'active',
      isRevoked: false,
    },
    {
      id: 'aaaa0003-0000-0000-0000-000000000003',
      organizationId: '11111111-1111-1111-1111-111111111111',
      email: 'revoked.user@alpha.corp',
      displayName: 'Revoked Employee',
      role: Roles.EMPLOYEE,
      employmentStatus: 'terminated',
      isRevoked: true,
      revokedAt: new Date(),
    },
    {
      id: 'bbbb0001-0000-0000-0000-000000000001',
      organizationId: '22222222-2222-2222-2222-222222222222',
      email: 'charlie@beta.corp',
      displayName: 'Charlie Beta',
      role: Roles.EMPLOYEE,
      employmentStatus: 'active',
      isRevoked: false,
    },
  ];

  const devices = [
    {
      id: 'da010000-0000-0000-0000-000000000001',
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: 'aaaa0001-0000-0000-0000-000000000001', // Alice's device
      name: "Alice's Workstation",
      platform: 'windows_11',
      kind: 'desktop_agent',
      isRevoked: false,
    },
    {
      id: 'da020000-0000-0000-0000-000000000002',
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: 'aaaa0002-0000-0000-0000-000000000002', // Bob's device
      name: "Bob's Laptop",
      platform: 'windows_11',
      kind: 'desktop_agent',
      isRevoked: false,
    },
    {
      id: 'db010000-0000-0000-0000-000000000001',
      organizationId: '22222222-2222-2222-2222-222222222222',
      userId: 'bbbb0001-0000-0000-0000-000000000001', // Charlie's device in Beta
      name: "Charlie's Beta Laptop",
      platform: 'windows_11',
      kind: 'desktop_agent',
      isRevoked: false,
    },
  ];

  let sessions = [
    { id: 'sess-a1', organizationId: '11111111-1111-1111-1111-111111111111', deviceId: 'da010000-0000-0000-0000-000000000001' },
    { id: 'sess-b1', organizationId: '11111111-1111-1111-1111-111111111111', deviceId: 'da020000-0000-0000-0000-000000000002' },
    { id: 'sess-c1', organizationId: '22222222-2222-2222-2222-222222222222', deviceId: 'db010000-0000-0000-0000-000000000001' },
  ];

  let events = [
    { id: 'ev-a1', organizationId: '11111111-1111-1111-1111-111111111111', deviceId: 'da010000-0000-0000-0000-000000000001' },
    { id: 'ev-b1', organizationId: '11111111-1111-1111-1111-111111111111', deviceId: 'da020000-0000-0000-0000-000000000002' },
    { id: 'ev-c1', organizationId: '22222222-2222-2222-2222-222222222222', deviceId: 'db010000-0000-0000-0000-000000000001' },
  ];

  const auditLogs = [];
  const userSessions = [];

  const fakePrisma = {
    organization: {
      findUnique: async ({ where }) => orgs.find((o) => o.id === where.id || o.slug === where.slug) || null,
    },
    user: {
      findUnique: async ({ where }) => users.find((u) => u.id === where.id || u.email === where.email) || null,
      findMany: async ({ where }) => {
        let res = [...users];
        if (where?.organizationId) res = res.filter((u) => u.organizationId === where.organizationId);
        return res;
      },
    },
    userSession: {
      create: async ({ data }) => {
        userSessions.push({ ...data });
        return data;
      },
      findUnique: async ({ where }) => {
        const s = userSessions.find((item) => item.tokenHash === where.tokenHash);
        if (!s) return null;
        const u = users.find((item) => item.id === s.userId);
        return { ...s, user: u };
      },
      updateMany: async ({ where, data }) => {
        const matching = userSessions.filter((s) => s.tokenHash === where.tokenHash);
        matching.forEach((s) => Object.assign(s, data));
        return { count: matching.length };
      },
    },
    device: {
      findUnique: async ({ where }) => {
        const d = devices.find((item) => item.id === where.id);
        if (!d) return null;
        const owner = users.find((u) => u.id === d.userId);
        return { ...d, user: owner };
      },
      findMany: async ({ where }) => {
        let res = [...devices];
        if (where?.organizationId) res = res.filter((d) => d.organizationId === where.organizationId);
        if (where?.userId) res = res.filter((d) => d.userId === where.userId);
        return res;
      },
    },
    activitySession: {
      deleteMany: async ({ where }) => {
        const remaining = sessions.filter((s) => {
          let match = true;
          if (where.organizationId && s.organizationId !== where.organizationId) match = false;
          if (where.deviceId) {
            if (where.deviceId.in && !where.deviceId.in.includes(s.deviceId)) match = false;
            else if (typeof where.deviceId === 'string' && s.deviceId !== where.deviceId) match = false;
          }
          return !match;
        });
        const count = sessions.length - remaining.length;
        sessions.length = 0;
        sessions.push(...remaining);
        return { count };
      },
    },
    activityEvent: {
      deleteMany: async ({ where }) => {
        const remaining = events.filter((e) => {
          let match = true;
          if (where.organizationId && e.organizationId !== where.organizationId) match = false;
          if (where.deviceId) {
            if (where.deviceId.in && !where.deviceId.in.includes(e.deviceId)) match = false;
            else if (typeof where.deviceId === 'string' && e.deviceId !== where.deviceId) match = false;
          }
          return !match;
        });
        const count = events.length - remaining.length;
        events.length = 0;
        events.push(...remaining);
        return { count };
      },
    },
    screenCaptureMetadata: {
      deleteMany: async () => ({ count: 0 }),
    },
    dailySummary: {
      deleteMany: async () => ({ count: 0 }),
    },
    auditLog: {
      create: async ({ data }) => {
        const row = { id: `audit-${Date.now()}`, ...data };
        auditLogs.push(row);
        return row;
      },
    },
    $transaction: async (operations) => {
      const results = [];
      for (const op of operations) {
        results.push(await op);
      }
      return results;
    },
  };

  return {
    prisma: fakePrisma,
    state: { orgs, users, devices, sessions, events, auditLogs },
  };
}

describe('Priority 1: Privacy Deletion Authorization & Multi-Tenant Scoping', () => {
  it('1. User successfully deletes own authorized device activity data (200 OK)', async () => {
    const { prisma, state } = createPrivacyTestPrisma();
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://mock:mock@localhost:5432/mock' });
    const app = await buildApp({ config, prisma });

    const alice = state.users[0];
    const auth = await app.authService.createTestSession({
      userId: alice.id,
      email: alice.email,
      displayName: alice.displayName,
      role: alice.role,
      organizationId: alice.organizationId,
    });

    const initialAliceSessions = state.sessions.filter((s) => s.deviceId === 'da010000-0000-0000-0000-000000000001').length;
    assert.strictEqual(initialAliceSessions, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
      payload: {
        confirmDelete: true,
        deviceId: 'da010000-0000-0000-0000-000000000001', // Alice's device
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.deletedSessionsCount, 1);

    // Verify records deleted
    const remainingAliceSessions = state.sessions.filter((s) => s.deviceId === 'da010000-0000-0000-0000-000000000001').length;
    assert.strictEqual(remainingAliceSessions, 0);

    // Verify Bob and Charlie's data was unaffected
    const bobSessions = state.sessions.filter((s) => s.deviceId === 'da020000-0000-0000-0000-000000000002').length;
    assert.strictEqual(bobSessions, 1);
    const charlieSessions = state.sessions.filter((s) => s.deviceId === 'db010000-0000-0000-0000-000000000001').length;
    assert.strictEqual(charlieSessions, 1);

    await app.close();
  });

  it("2. User attempts deletion using another tenant's deviceId (Rejection: HTTP 403)", async () => {
    const { prisma, state } = createPrivacyTestPrisma();
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://mock:mock@localhost:5432/mock' });
    const app = await buildApp({ config, prisma });

    const alice = state.users[0]; // Tenant Alpha
    const auth = await app.authService.createTestSession({
      userId: alice.id,
      email: alice.email,
      role: alice.role,
      organizationId: alice.organizationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
      payload: {
        confirmDelete: true,
        deviceId: 'db010000-0000-0000-0000-000000000001', // Charlie's device in Tenant Beta!
      },
    });

    assert.strictEqual(res.statusCode, 403);
    const body = res.json();
    assert.strictEqual(body.error.code, 'CROSS_TENANT_FORBIDDEN');

    // Verify zero records deleted in Tenant Beta
    const charlieSessions = state.sessions.filter((s) => s.deviceId === 'db010000-0000-0000-0000-000000000001').length;
    assert.strictEqual(charlieSessions, 1);

    await app.close();
  });

  it("3. User attempts deletion using another employee's deviceId in same tenant (Rejection: HTTP 403)", async () => {
    const { prisma, state } = createPrivacyTestPrisma();
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://mock:mock@localhost:5432/mock' });
    const app = await buildApp({ config, prisma });

    const alice = state.users[0]; // Alice
    const auth = await app.authService.createTestSession({
      userId: alice.id,
      email: alice.email,
      role: alice.role,
      organizationId: alice.organizationId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
      payload: {
        confirmDelete: true,
        deviceId: 'da020000-0000-0000-0000-000000000002', // Bob's device!
      },
    });

    assert.strictEqual(res.statusCode, 403);
    const body = res.json();
    assert.strictEqual(body.error.code, 'FORBIDDEN');
    assert.match(body.error.message, /Employees may access and delete only their own authorized records/i);

    // Verify Bob's data was not deleted
    const bobSessions = state.sessions.filter((s) => s.deviceId === 'da020000-0000-0000-0000-000000000002').length;
    assert.strictEqual(bobSessions, 1);

    await app.close();
  });

  it('4. Employee attempts unauthorized administrative wildcard deletion (Safely restricted to own devices or 403)', async () => {
    const { prisma, state } = createPrivacyTestPrisma();
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://mock:mock@localhost:5432/mock' });
    const app = await buildApp({ config, prisma });

    const alice = state.users[0]; // Employee
    const auth = await app.authService.createTestSession({
      userId: alice.id,
      email: alice.email,
      role: alice.role,
      organizationId: alice.organizationId,
    });

    // Attempting bulk deletion with no deviceId specified (trying to wipe all org records)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
      payload: {
        confirmDelete: true,
        // no deviceId provided!
      },
    });

    // Should only delete Alice's own device records, leaving Bob's intact
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.deletedSessionsCount, 1); // Only Alice's 1 session deleted

    // Verify Bob's record remains 100% intact
    const bobSessions = state.sessions.filter((s) => s.deviceId === 'da020000-0000-0000-0000-000000000002').length;
    assert.strictEqual(bobSessions, 1);

    await app.close();
  });

  it('5. Revoked user attempts deletion (Rejection: HTTP 403)', async () => {
    const { prisma, state } = createPrivacyTestPrisma();
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://mock:mock@localhost:5432/mock' });
    const app = await buildApp({ config, prisma });

    const revokedUser = state.users[2]; // Terminated / revoked
    const auth = await app.authService.createTestSession({
      userId: revokedUser.id,
      email: revokedUser.email,
      role: revokedUser.role,
      organizationId: revokedUser.organizationId,
      isRevoked: true,
      revokedAt: new Date(),
      employmentStatus: 'terminated',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers: {
        authorization: `Bearer ${auth.token}`,
      },
      payload: {
        confirmDelete: true,
        deviceId: 'da010000-0000-0000-0000-000000000001',
      },
    });

    assert.strictEqual(res.statusCode, 403);
    const body = res.json();
    assert.strictEqual(body.error.code, 'USER_REVOKED');

    await app.close();
  });
});
