import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { AuthService, hashPassword, hashSessionToken, verifyPassword, Roles } from '../src/modules/auth/auth.service.js';
import { serializeSessionCookie } from '../src/modules/auth/session-cookie.js';

function fakePrisma() {
  const users = [];
  const sessions = [];
  const auditLogs = [];

  return {
    __sessions: sessions,
    __users: users,
    user: {
      findFirst: async ({ where }) => users.find((u) => u.email === where.email) || null,
      findMany: async ({ where, take }) => users.filter((u) => u.email === where.email).slice(0, take),
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
        const row = { revokedAt: null, ...data };
        sessions.push(row);
        return row;
      },
      findUnique: async ({ where }) => {
        const s = sessions.find((item) => item.tokenHash === where.tokenHash);
        if (!s) return null;
        const u = users.find((item) => item.id === s.userId);
        return { ...s, user: u };
      },
      updateMany: async ({ where, data }) => {
        const matching = sessions.filter((s) => Object.entries(where).every(([key, value]) => s[key] === value));
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

  it('disables public administrator creation and verifies production sessions and reset-token handling', async (t) => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x:y@db.example.test:5432/dp?sslmode=require',
      PUBLIC_APP_URL: 'https://digitalpulse.example.test',
      CORS_ORIGINS: 'https://digitalpulse.example.test',
    });
    const prisma = fakePrisma();
    const loginAttempts = new Map();
    const resetTokens = [];
    prisma.loginAttempt = {
      findUnique: async ({ where }) => loginAttempts.get(where.identifierHash) || null,
      create: async ({ data }) => { loginAttempts.set(data.identifierHash, { ...data }); return data; },
      update: async ({ where, data }) => Object.assign(loginAttempts.get(where.identifierHash), data),
      deleteMany: async ({ where }) => ({ count: Number(loginAttempts.delete(where.identifierHash)) }),
    };
    prisma.passwordResetToken = {
      create: async ({ data }) => { const row = { id: `reset-${resetTokens.length + 1}`, usedAt: null, ...data }; resetTokens.push(row); return row; },
      findUnique: async ({ where }) => {
        const row = resetTokens.find((item) => item.tokenHash === where.tokenHash);
        return row ? { ...row, user: prisma.__users.find((user) => user.id === row.userId) || null } : null;
      },
      updateMany: async ({ where, data }) => {
        const matches = resetTokens.filter((item) => item.tokenHash === where.tokenHash && item.usedAt === where.usedAt);
        matches.forEach((item) => Object.assign(item, data));
        return { count: matches.length };
      },
    };
    prisma.$executeRaw = async () => 1;
    prisma.$transaction = async (callback) => callback(prisma);
    const app = await buildApp({ config, prisma, logger: false });
    t.after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'public@example.test', password: 'StrongPassword123!', displayName: 'Public User', organizationName: 'Public Org' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'PUBLIC_REGISTRATION_DISABLED');

    const unknownLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'unknown-production@example.test', password: 'SomePassword123!' },
    });
    assert.equal(unknownLogin.statusCode, 401);
    assert.equal(unknownLogin.json().error.message, 'Invalid email or password');

    const credentials = hashPassword('ProductionPassword123!');
    const account = await prisma.user.create({ data: {
      organizationId: 'org-prod-test', email: 'production-admin@example.test', displayName: 'Production Admin',
      role: 'ORG_ADMIN', passwordHash: credentials.hash, passwordSalt: credentials.salt,
    } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: account.email, password: 'ProductionPassword123!' } });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal('token' in login.json(), false);
    assert.match(login.headers['set-cookie'], /HttpOnly/);
    assert.match(login.headers['set-cookie'], /Secure/);
    assert.match(login.headers['set-cookie'], /SameSite=Lax/);
    const loginCookie = login.headers['set-cookie'].split(';')[0];
    const rawSessionToken = loginCookie.slice(loginCookie.indexOf('=') + 1);
    const sessionRow = prisma.__sessions.find((session) => session.tokenHash === hashSessionToken(rawSessionToken));
    assert.ok(sessionRow);
    assert.equal(sessionRow.token, undefined);

    const independentService = new AuthService(prisma, { warn() {} }, config);
    assert.equal((await independentService.validateSession(rawSessionToken))?.user.id, account.id);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: loginCookie } });
    assert.equal(me.statusCode, 200);

    let emailedResetToken;
    app.authService.emailService = { configured: true, async sendPasswordResetEmail({ resetToken }) { emailedResetToken = resetToken; } };
    const resetRequest = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-request', payload: { email: account.email } });
    assert.equal(resetRequest.statusCode, 200);
    assert.equal('resetToken' in resetRequest.json(), false);
    assert.ok(emailedResetToken);
    const resetHash = hashSessionToken(emailedResetToken);
    const storedReset = resetTokens.find((item) => item.tokenHash === resetHash);
    assert.ok(storedReset);
    assert.equal('resetToken' in storedReset, false);
    const confirm = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-confirm', payload: {
      email: account.email, resetToken: emailedResetToken, newPassword: 'UpdatedPassword123!',
    } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.ok(storedReset.usedAt);
    assert.equal(verifyPassword('UpdatedPassword123!', account.passwordHash, account.passwordSalt), true);
    assert.equal(await independentService.validateSession(rawSessionToken), null);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-confirm', payload: {
      email: account.email, resetToken: emailedResetToken, newPassword: 'AnotherPassword123!',
    } });
    assert.equal(replay.statusCode, 400);

    const newLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: account.email, password: 'UpdatedPassword123!' } });
    assert.equal(newLogin.statusCode, 200, newLogin.body);
    const newCookie = newLogin.headers['set-cookie'].split(';')[0];
    const newRawToken = newCookie.slice(newCookie.indexOf('=') + 1);
    assert.equal((await independentService.validateSession(newRawToken))?.user.id, account.id);
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: newCookie, origin: 'https://digitalpulse.example.test' } });
    assert.equal(logout.statusCode, 200);
    assert.equal(await independentService.validateSession(newRawToken), null);

    const duplicateEmail = 'duplicate-production@example.test';
    const duplicateCredentials = hashPassword('DuplicatePassword123!');
    await prisma.user.create({ data: {
      organizationId: 'org-prod-a', email: duplicateEmail, displayName: 'Duplicate A', role: 'EMPLOYEE',
      passwordHash: duplicateCredentials.hash, passwordSalt: duplicateCredentials.salt,
    } });
    await prisma.user.create({ data: {
      organizationId: 'org-prod-b', email: duplicateEmail, displayName: 'Duplicate B', role: 'EMPLOYEE',
      passwordHash: duplicateCredentials.hash, passwordSalt: duplicateCredentials.salt,
    } });
    const ambiguousLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: duplicateEmail, password: 'DuplicatePassword123!' },
    });
    assert.equal(ambiguousLogin.statusCode, 401);
    assert.equal(ambiguousLogin.json().error.message, 'Invalid email or password');
    assert.equal(ambiguousLogin.headers['set-cookie'], undefined);

    const manualCookie = serializeSessionCookie('a'.repeat(64), { secure: true, maxAgeSeconds: 600 });
    assert.match(manualCookie, /HttpOnly/);
    assert.match(manualCookie, /Secure/);
    assert.match(manualCookie, /SameSite=Lax/);
    assert.match(manualCookie, /Max-Age=600/);
  });

  it('registers a new organization administrator and rejects duplicates', async () => {
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
        role: Roles.ORGANIZATION_ADMIN,
        organizationName: 'The Miller Family',
      },
    });
    assert.equal(res1.statusCode, 201);
    const body1 = res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.user.email, 'alice@family.local');
    assert.equal(body1.user.role, Roles.ORGANIZATION_ADMIN);

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
      payload: { email: 'bob@family.local', password: 'SecretPassword987!', rememberMe: false },
    });
    assert.equal(loginRes.statusCode, 200);
    const { user } = loginRes.json();
    assert.equal('token' in loginRes.json(), false);
    assert.equal(loginRes.json().rememberMe, false);
    const cookie = loginRes.headers['set-cookie'].split(';')[0];
    assert.match(loginRes.headers['set-cookie'], /HttpOnly/);
    assert.match(loginRes.headers['set-cookie'], /SameSite=Lax/);
    const rawSessionToken = cookie.slice(cookie.indexOf('=') + 1);
    const storedSession = prisma.__sessions[0];
    assert.equal(storedSession.token, undefined);
    assert.match(storedSession.tokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(storedSession.tokenHash, rawSessionToken);
    assert.equal(loginRes.headers['set-cookie'].includes('Max-Age='), false);
    assert.equal(user.email, 'bob@family.local');

    // 3. Access /auth/me with the HttpOnly session cookie
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().user.email, 'bob@family.local');

    const rejectedCrossSiteLogout = await app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { cookie, origin: 'https://attacker.example.test' },
    });
    assert.equal(rejectedCrossSiteLogout.statusCode, 403);
    const sessionAfterRejectedLogout = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    assert.equal(sessionAfterRejectedLogout.statusCode, 200);

    // 4. Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, origin: 'http://localhost:5173' },
    });
    assert.equal(logoutRes.statusCode, 200);

    // 5. Subsequent access is unauthorized
    const meAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    assert.equal(meAfterLogout.statusCode, 401);
  });

  it('does not choose an arbitrary organization when duplicate email identities exist', async (t) => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const credentials = hashPassword('SharedPassword123!');
    const email = 'shared-identity@example.test';
    prisma.__users.push(
      { id: 'shared-user-a', organizationId: 'org-a', email, displayName: 'Member A', role: 'EMPLOYEE', passwordHash: credentials.hash, passwordSalt: credentials.salt },
      { id: 'shared-user-b', organizationId: 'org-b', email, displayName: 'Member B', role: 'EMPLOYEE', passwordHash: credentials.hash, passwordSalt: credentials.salt },
    );
    const app = await buildApp({ config, prisma, logger: false });
    t.after(() => app.close());

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'SharedPassword123!' } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.message, 'Invalid email or password');
    assert.equal(response.headers['set-cookie'], undefined);
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

