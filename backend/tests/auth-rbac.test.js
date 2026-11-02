import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { hashPassword, verifyPassword, Roles } from '../src/modules/auth/auth.service.js';

function fakePrisma() {
  const users = [];
  const sessions = [];
  const auditLogs = [];

  return {
    user: {
      findFirst: async ({ where }) => users.find((u) => u.email === where.email) || null,
      findUnique: async ({ where }) => users.find((u) => u.id === where.id) || null,
      create: async ({ data }) => {
        const row = { id: `user-${users.length + 1}`, ...data };
        users.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const u = users.find((item) => item.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      },
      updateMany: async ({ where, data }) => {
        const matching = users.filter((u) => u.email === where.email);
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
        const s = sessions.find((item) => item.token === where.token);
        if (!s) return null;
        const u = users.find((item) => item.id === s.userId);
        return { ...s, user: u };
      },
      updateMany: async ({ where, data }) => {
        const matching = sessions.filter((s) => s.token === where.token);
        matching.forEach((s) => Object.assign(s, data));
        return { count: matching.length };
      },
    },
    organization: {
      create: async ({ data }) => ({
        id: 'org-test-1111-2222',
        ...data,
      }),
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push({ id: `audit-${auditLogs.length + 1}`, ...data });
        return data;
      },
    },
  };
}

describe('Authentication & Family RBAC (Milestone 2)', () => {
  it('hashes passwords with secure salt and verifies using timing-safe comparison', () => {
    const pwd = 'CorrectHorseBatteryStaple123!';
    const { hash, salt } = hashPassword(pwd);
    assert.ok(hash && hash.length === 128);
    assert.ok(salt && salt.length === 32);

    // Verify correct
    assert.equal(verifyPassword(pwd, hash, salt), true);
    // Verify wrong
    assert.equal(verifyPassword('WrongPassword123!', hash, salt), false);
  });

  it('registers a new family owner and rejects duplicates', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });

    // 1. Successful registration
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'alice@family.local',
        password: 'Password123!',
        displayName: 'Alice (Parent)',
        role: Roles.FAMILY_OWNER,
        organizationName: 'The Miller Family',
      },
    });
    assert.equal(res1.statusCode, 201);
    const body1 = res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.user.email, 'alice@family.local');
    assert.equal(body1.user.role, Roles.FAMILY_OWNER);

    // 2. Duplicate registration rejected
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'alice@family.local',
        password: 'AnotherPassword123!',
      },
    });
    assert.equal(res2.statusCode, 409);
  });

  it('authenticates valid credentials, logs in, accesses /me, and logs out', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });

    // Register user
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'bob@family.local',
        password: 'SecretPassword987!',
        displayName: 'Bob',
      },
    });

    // 1. Invalid password
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'bob@family.local', password: 'BadPassword!' },
    });
    assert.equal(failRes.statusCode, 401);

    // 2. Valid login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'bob@family.local', password: 'SecretPassword987!' },
    });
    assert.equal(loginRes.statusCode, 200);
    const { token, user } = loginRes.json();
    assert.ok(token);
    assert.equal(user.email, 'bob@family.local');

    // 3. Access /auth/me with Bearer token
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().user.email, 'bob@family.local');

    // 4. Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(logoutRes.statusCode, 200);

    // 5. Subsequent access is unauthorized
    const meAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(meAfterLogout.statusCode, 401);
  });

  it('throttles excessive consecutive failed login attempts', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'charlie@family.local', password: 'StrongPassword456!' },
    });

    // Fire 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'charlie@family.local', password: 'Wrong' },
      });
    }

    // 6th attempt should be rate limited with 429
    const lockedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'charlie@family.local', password: 'StrongPassword456!' },
    });
    assert.equal(lockedRes.statusCode, 429);
    assert.match(lockedRes.json().error.message, /temporarily locked/i);
  });

  it('supports password reset workflow in local development', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dan@family.local', password: 'OldPassword123!' },
    });

    // 1. Request reset
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password-request',
      payload: { email: 'dan@family.local' },
    });
    assert.equal(reqRes.statusCode, 200);
    const { resetToken } = reqRes.json();
    assert.ok(resetToken);

    // 2. Confirm reset
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password-confirm',
      payload: {
        email: 'dan@family.local',
        resetToken,
        newPassword: 'BrandNewPassword123!',
      },
    });
    assert.equal(confirmRes.statusCode, 200);

    // 3. Login with new password succeeds
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'dan@family.local', password: 'BrandNewPassword123!' },
    });
    assert.equal(newLogin.statusCode, 200);
  });
});
