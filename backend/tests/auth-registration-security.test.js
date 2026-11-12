import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { Roles } from '../src/modules/auth/auth.service.js';

function createPrisma() {
  const users = [];
  const organizations = [];
  const invitations = [];
  const departments = [];
  const emailLocks = new Map();
  let userSequence = 0;
  let organizationSequence = 0;

  const prisma = {
    $executeRaw: async () => 1,
    organization: {
      create: async ({ data }) => {
        const organization = { id: `org-${++organizationSequence}`, ...data };
        organizations.push(organization);
        return organization;
      },
    },
    department: {
      findFirst: async ({ where }) => {
        const match = departments.find((department) => department.organizationId === where.organizationId && (where.id ? department.id === where.id : department.name === where.name));
        return match ? (where.id ? { id: match.id, name: match.name } : match) : null;
      },
      create: async ({ data }) => {
        const department = { id: `dept-${departments.length + 1}`, ...data };
        departments.push(department);
        return department;
      },
    },
    user: {
      findFirst: async ({ where }) => users.find((user) => user.email.toLowerCase() === String(where.email?.equals || where.email).toLowerCase()) || null,
      findMany: async ({ where }) => {
        const expectedEmail = String(where.email?.equals || where.email).toLowerCase();
        return users.filter((user) => user.email.toLowerCase() === expectedEmail);
      },
      create: async ({ data }) => {
        if (users.some((user) => user.email.toLowerCase() === data.email.toLowerCase() && user.organizationId === data.organizationId)) {
          const error = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
        const user = { id: data.id || `user-${++userSequence}`, ...data };
        users.push(user);
        return user;
      },
      update: async ({ where, data }) => {
        const user = users.find((candidate) => candidate.id === where.id);
        if (!user) throw new Error('User not found');
        Object.assign(user, data);
        return user;
      },
    },
    invitation: {
      create: async ({ data }) => {
        const invitation = { id: `inv-${invitations.length + 1}`, ...data };
        invitations.push(invitation);
        return invitation;
      },
      findUnique: async ({ where }) => invitations.find((item) => item.token === where.token) || null,
      findFirst: async ({ where }) => invitations.find((item) => {
        if (where.id) return item.id === where.id && item.organizationId === where.organizationId && !item.acceptedAt && !item.revokedAt;
        if (where.tokenHash) return item.tokenHash === where.tokenHash;
        if (where.email) return item.email === where.email && item.organizationId === where.organizationId && !item.acceptedAt && !item.revokedAt && new Date(item.expiresAt) > new Date();
        return item.tokenHash === where.OR?.[0]?.tokenHash;
      }) || null,
      updateMany: async ({ where, data }) => {
        const invitation = invitations.find(
          (item) =>
            (where.id ? item.id === where.id : item.token === where.token) &&
            (!('acceptedAt' in where) || (where.acceptedAt === null ? item.acceptedAt == null : item.acceptedAt === where.acceptedAt)) &&
            (!('revokedAt' in where) || (where.revokedAt === null ? item.revokedAt == null : item.revokedAt === where.revokedAt)),
        );
        if (!invitation) return { count: 0 };
        Object.assign(invitation, data);
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        const invitation = invitations.find((item) => item.token === where.token);
        if (invitation) Object.assign(invitation, data);
        return invitation;
      },
    },
    auditLog: {
      create: async ({ data }) => data,
    },
  };
  prisma.$transaction = async (callback) => {
    const releases = [];
    const tx = Object.create(prisma);
    tx.$executeRaw = async (_strings, ...values) => {
      const key = values.join(':');
      const previous = emailLocks.get(key) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      emailLocks.set(key, previous.then(() => current));
      await previous;
      releases.push(release);
      return 1;
    };
    try {
      return await callback(tx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
  prisma.__state = { users, organizations, invitations, departments };
  return prisma;
}

function testConfig() {
  return loadConfig({ DATABASE_URL: 'postgresql://localhost:5433/digitalpulse_test' });
}

describe('registration privilege-escalation protection', () => {
  it('registers the canonical protected invitation route', async () => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    const invitationResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      payload: { email: 'employee@example.com', role: Roles.EMPLOYEE },
    });

    assert.notEqual(invitationResponse.statusCode, 404);
    assert.equal(invitationResponse.statusCode, 401);
  });

  it('creates invitations through the authorized organization endpoint and scopes departments', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const session = await app.authService.createTestSession({ organizationId: 'trusted-org' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: session.headers,
      payload: {
        displayName: 'Jamie Employee', email: 'jamie@example.com', role: 'EMPLOYEE', department: 'Engineering',
        shiftStart: '09:00', shiftEnd: '17:00', workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], shiftTimezone: 'UTC',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const created = response.json();
    assert.equal(created.invitation.email, 'jamie@example.com');
    assert.equal(new URLSearchParams(new URL(created.invitationUrl).hash.slice(1)).has('token'), true);
    assert.equal(prisma.__state.invitations[0].organizationId, 'trusted-org');
    assert.equal(prisma.__state.invitations[0].token, null);
    assert.equal(prisma.__state.invitations[0].tokenHash.length, 64);

    prisma.__state.departments.push({ id: 'foreign-department', organizationId: 'other-org', name: 'Foreign' });
    const foreignDepartment = await app.inject({
      method: 'POST', url: '/api/v1/invitations', headers: session.headers,
      payload: { displayName: 'Wrong Tenant', email: 'wrong@example.com', departmentId: 'foreign-department', shiftStart: '09:00', shiftEnd: '17:00', workingDays: ['Mon'], shiftTimezone: 'UTC' },
    });
    assert.equal(foreignDepartment.statusCode, 400);
    const elevatedRole = await app.inject({
      method: 'POST', url: '/api/v1/invitations', headers: session.headers,
      payload: { displayName: 'Wrong Role', email: 'role@example.com', role: 'ORGANIZATION_ADMIN', department: 'Engineering', shiftStart: '09:00', shiftEnd: '17:00', workingDays: ['Mon'], shiftTimezone: 'UTC' },
    });
    assert.equal(elevatedRole.statusCode, 400);
  });

  it('ignores public role, tenant, permissions, and identity fields', async () => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });

    for (const [index, role] of [
      Roles.SUPER_ADMIN,
      Roles.ADMIN,
      'MANAGER',
      Roles.EMPLOYEE,
    ].entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/organization/register',
        payload: {
          email: `attacker-${index}@example.com`,
          password: 'StrongPassword123!',
          displayName: 'Attacker',
          role,
          organizationId: 'victim-org',
          tenantId: 'victim-org',
          userId: 'victim-user',
          permissions: ['platform:admin'],
          organizationName: 'Attacker Organization',
        },
      });

      assert.equal(response.statusCode, 201);
      const created = prisma.__state.users[index];
      assert.equal(created.role, 'ADMIN');
      assert.notEqual(created.organizationId, 'victim-org');
    }

    assert.equal(prisma.__state.organizations.length, 4);
    assert.equal(prisma.__state.users.length, 4);
  });

  it('accepts an invitation using stored identity and rejects replay', async () => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    const invitation = await app.authService.createInvitation({
      organizationId: 'trusted-org',
      email: 'employee@example.com',
      role: Roles.EMPLOYEE,
      invitedBy: 'admin@example.com',
    });

    const invitationToken = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('token');
    assert.equal(prisma.__state.invitations[0].token, null);
    assert.equal(prisma.__state.invitations[0].tokenHash.length, 64);
    assert.notEqual(prisma.__state.invitations[0].tokenHash, invitationToken);

    const validation = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/validate',
      payload: { token: invitationToken },
    });
    assert.equal(validation.statusCode, 200, JSON.stringify(validation.json()));
    assert.equal(validation.json().invitation.email, 'employee@example.com');
    assert.equal(JSON.stringify(validation.json()).includes(invitationToken), false);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: {
        token: invitationToken,
        password: 'StrongPassword123!',
        displayName: 'Employee',
        email: 'attacker@example.com',
        role: Roles.SUPER_ADMIN,
        organizationId: 'attacker-org',
      },
    });

    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().user.email, 'employee@example.com');
    assert.equal(prisma.__state.users[0].organizationId, 'trusted-org');
    assert.equal(prisma.__state.users[0].role, Roles.EMPLOYEE);
    assert.equal('passwordHash' in accepted.json().user, false);
    assert.equal('passwordSalt' in accepted.json().user, false);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token: invitationToken, password: 'AnotherPassword123!' },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(prisma.__state.users.length, 1);
  });

  it('requires sign-in and attaches an existing same-organization employee without changing credentials or role', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const originalHash = 'existing-password-hash';
    const originalSalt = 'existing-password-salt';
    const account = await prisma.user.create({ data: {
      organizationId: 'trusted-org', email: 'existing@example.com', displayName: 'Existing Person',
      role: Roles.EMPLOYEE, passwordHash: originalHash, passwordSalt: originalSalt,
      employmentStatus: 'active', shiftStart: '10:00', shiftEnd: '18:00', workingDays: ['Tue'], shiftTimezone: 'UTC',
    } });
    const invitation = await app.authService.createInvitation({
      organizationId: 'trusted-org', email: account.email, displayName: 'Invited Person',
      shiftStart: '08:30', shiftEnd: '16:30', workingDays: ['Mon', 'Wed'], shiftTimezone: 'Asia/Kolkata',
    });
    const token = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('token');

    const publicAttempt = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token, displayName: 'Existing Person', password: 'StrongPassword123!' } });
    assert.equal(publicAttempt.statusCode, 409);
    assert.equal(publicAttempt.json().error.code, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
    assert.equal(prisma.__state.users.length, 1);
    assert.equal(prisma.__state.invitations[0].acceptedAt, undefined);

    const wrongSession = await app.authService.createTestSession({ userId: 'some-other-user', email: 'someone-else@example.com', role: Roles.EMPLOYEE, organizationId: 'trusted-org' });
    const wrongAccountAttempt = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', headers: wrongSession.headers, payload: { token } });
    assert.equal(wrongAccountAttempt.statusCode, 403);
    assert.equal(wrongAccountAttempt.json().error.code, 'INVITATION_ACCOUNT_MISMATCH');
    assert.equal(prisma.__state.invitations[0].acceptedAt, undefined);

    const session = await app.authService.createTestSession({ userId: account.id, email: account.email, displayName: account.displayName, role: Roles.EMPLOYEE, organizationId: 'trusted-org' });
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', headers: session.headers, payload: { token } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().existingAccount, true);
    assert.equal(accepted.json().user.id, account.id);
    assert.equal(prisma.__state.users.length, 1);
    assert.equal(account.passwordHash, originalHash);
    assert.equal(account.passwordSalt, originalSalt);
    assert.equal(account.role, Roles.EMPLOYEE);
    assert.equal(account.organizationId, 'trusted-org');
    assert.equal(account.displayName, 'Existing Person');
    assert.equal(account.shiftStart, '08:30');
    assert.deepEqual(account.workingDays, ['Mon', 'Wed']);

    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', headers: session.headers, payload: { token } });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'INVITATION_ALREADY_ACCEPTED');
    assert.equal(prisma.__state.users.length, 1);
  });

  it('returns an actionable conflict for an existing account in another organization without changing it', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const account = await prisma.user.create({ data: {
      organizationId: 'other-org', email: 'cross-org@example.com', displayName: 'Cross Organization',
      role: Roles.EMPLOYEE, passwordHash: 'keep-this-hash', passwordSalt: 'keep-this-salt', employmentStatus: 'active',
    } });
    const invitation = await app.authService.createInvitation({ organizationId: 'trusted-org', email: account.email });
    const token = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('token');

    const unverified = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token, password: 'StrongPassword123!', displayName: 'Cross Organization' } });
    assert.equal(unverified.statusCode, 409);
    assert.equal(unverified.json().error.code, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
    const session = await app.authService.createTestSession({ userId: account.id, email: account.email, role: Roles.EMPLOYEE, organizationId: 'other-org' });
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', headers: session.headers, payload: { token } });
    assert.equal(verified.statusCode, 409);
    assert.equal(verified.json().error.code, 'ORGANIZATION_MEMBERSHIP_UNSUPPORTED');
    assert.match(verified.json().error.message, /administrator/i);
    assert.equal(prisma.__state.users.length, 1);
    assert.equal(account.organizationId, 'other-org');
    assert.equal(account.role, Roles.EMPLOYEE);
    assert.equal(account.passwordHash, 'keep-this-hash');
    assert.equal(prisma.__state.invitations[0].acceptedAt, undefined);
  });

  it('does not overwrite an existing role when it differs from the invitation role', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const account = await prisma.user.create({ data: {
      organizationId: 'trusted-org', email: 'manager@example.com', displayName: 'Department Manager',
      role: Roles.ADMIN, passwordHash: 'manager-hash', passwordSalt: 'manager-salt', employmentStatus: 'active',
    } });
    const invitation = await app.authService.createInvitation({ organizationId: 'trusted-org', email: account.email, role: Roles.EMPLOYEE });
    const token = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('token');
    const session = await app.authService.createTestSession({ userId: account.id, email: account.email, role: Roles.ADMIN, organizationId: 'trusted-org' });

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', headers: session.headers, payload: { token } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'INVITATION_ROLE_CONFLICT');
    assert.equal(account.role, Roles.ADMIN);
    assert.equal(prisma.__state.invitations[0].acceptedAt, undefined);
  });

  it('rejects email-like names and serializes concurrent acceptance to one account', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const invalid = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'name-check@example.com' });
    const invalidToken = new URLSearchParams(new URL(invalid.invitationUrl).hash.slice(1)).get('token');
    const invalidResponse = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token: invalidToken, displayName: 'name-check@example.com', password: 'StrongPassword123!' } });
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(invalidResponse.json().error.code, 'INVALID_DISPLAY_NAME');
    assert.equal(prisma.__state.users.length, 0);
    assert.equal(prisma.__state.invitations[0].acceptedAt, undefined);

    const invitation = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'parallel@example.com' });
    const token = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('token');
    const payload = { token, displayName: 'Parallel Employee', password: 'StrongPassword123!' };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload }),
      app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload }),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(responses.find((response) => response.statusCode === 409).json().error.code, 'INVITATION_ALREADY_ACCEPTED');
    assert.equal(prisma.__state.users.length, 1);
    assert.equal(prisma.__state.invitations[1].acceptedAt instanceof Date, true);
  });

  it('serializes concurrent invitations for the same email across organizations', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const email = 'cross-org-race@example.com';
    const firstInvitation = await app.authService.createInvitation({ organizationId: 'trusted-org', email });
    const secondInvitation = await app.authService.createInvitation({ organizationId: 'other-org', email });
    const firstToken = new URLSearchParams(new URL(firstInvitation.invitationUrl).hash.slice(1)).get('token');
    const secondToken = new URLSearchParams(new URL(secondInvitation.invitationUrl).hash.slice(1)).get('token');
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token: firstToken, displayName: 'First Employee', password: 'StrongPassword123!' } }),
      app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token: secondToken, displayName: 'Second Employee', password: 'StrongPassword123!' } }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(responses.find((response) => response.statusCode === 409).json().error.code, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
    assert.equal(prisma.__state.users.length, 1);
    assert.equal(prisma.__state.users[0].email, email);
    assert.equal(prisma.__state.invitations.filter((row) => row.acceptedAt).length, 1);
  });

  it('returns a safe error when the acceptance transaction fails', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const invitation = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'storage-error@example.com' });
    const token = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('token');
    prisma.$transaction = async () => {
      const error = new Error('password_hash column is missing and raw database details must stay private');
      error.code = 'P2022';
      throw error;
    };

    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token, displayName: 'Storage Error Employee', password: 'StrongPassword123!' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'INVITATION_ACCEPTANCE_UNAVAILABLE');
    assert.equal(response.body.includes('password_hash'), false);
  });

  it('keeps a saved hash-only invitation active when email delivery fails', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    app.authService.emailService = { configured: true, sendInvitationEmail: async () => { throw new Error('SMTP rejected message'); } };

    const result = await app.authService.createInvitation({
      organizationId: 'trusted-org',
      email: 'saved@example.com',
      displayName: 'Saved Employee',
      role: Roles.EMPLOYEE,
      shiftStart: '09:00', shiftEnd: '17:00', workingDays: ['Mon', 'Tue'], shiftTimezone: 'UTC',
    });
    const token = new URLSearchParams(new URL(result.invitationUrl).hash.slice(1)).get('token');
    const saved = prisma.__state.invitations[0];
    assert.equal(result.emailSent, false);
    assert.equal(result.deliveryStatus, 'failed');
    assert.equal(result.invitationUrl.includes('?token='), false);
    assert.equal(saved.token, null);
    assert.equal(saved.tokenHash.length, 64);
    assert.notEqual(saved.tokenHash, token);
    assert.equal(saved.role, Roles.EMPLOYEE);
    assert.equal(new Date(saved.expiresAt).getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000, true);
    assert.equal((await app.authService.getInvitationDetails(token)).invitation.email, 'saved@example.com');
  });

  it('returns the creator link even when email delivery succeeds', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    let deliveredUrl;
    app.authService.emailService = {
      configured: true,
      async sendInvitationEmail({ token, invitationUrl }) {
        const delivered = new URL(invitationUrl);
        delivered.hash = new URLSearchParams({ token }).toString();
        deliveredUrl = delivered.toString();
      },
    };
    const result = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'delivered@example.com' });
    assert.equal(result.emailSent, true);
    assert.equal(result.deliveryStatus, 'accepted_by_smtp');
    assert.equal(result.invitationUrl, deliveredUrl);
    assert.equal(prisma.__state.invitations[0].token, null);
    assert.equal(new URLSearchParams(new URL(result.invitationUrl).hash.slice(1)).has('token'), true);
  });

  it('explains expired and revoked links and rotates tokens on resend', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const expired = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'expired@example.com' });
    const expiredToken = new URLSearchParams(new URL(expired.invitationUrl).hash.slice(1)).get('token');
    prisma.__state.invitations[0].expiresAt = new Date(Date.now() - 1000);
    await assert.rejects(() => app.authService.getInvitationDetails(expiredToken), { statusCode: 410, message: /expired/i });
    await assert.rejects(() => app.authService.acceptInvitation({ token: expiredToken, password: 'StrongPassword123!', displayName: 'Expired Employee' }), { statusCode: 410, code: 'INVITATION_EXPIRED' });

    const revoked = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'revoked@example.com' });
    const revokedToken = new URLSearchParams(new URL(revoked.invitationUrl).hash.slice(1)).get('token');
    await app.authService.revokeInvitation({ organizationId: 'trusted-org', invitationId: revoked.invitation.id });
    await assert.rejects(() => app.authService.getInvitationDetails(revokedToken), { statusCode: 410, message: /revoked/i });

    const pending = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'resend@example.com' });
    const oldToken = new URLSearchParams(new URL(pending.invitationUrl).hash.slice(1)).get('token');
    const resent = await app.authService.resendInvitation({ organizationId: 'trusted-org', invitationId: pending.invitation.id, invitedBy: 'admin@example.com' });
    const newToken = new URLSearchParams(new URL(resent.invitationUrl).hash.slice(1)).get('token');
    assert.equal(resent.invitation.id, pending.invitation.id);
    assert.notEqual(newToken, oldToken);
    assert.equal(prisma.__state.invitations[2].token, null);
    assert.notEqual(prisma.__state.invitations[2].tokenHash, oldToken);
    await assert.rejects(() => app.authService.getInvitationDetails(oldToken), { statusCode: 404 });
    assert.equal((await app.authService.getInvitationDetails(newToken)).invitation.email, 'resend@example.com');
  });

  it('returns one fresh link after an SMTP timeout without repeating token rotation', async (t) => {
    const prisma = createPrisma();
    const app = await buildApp({ config: testConfig(), prisma, logger: false });
    t.after(() => app.close());
    const pending = await app.authService.createInvitation({ organizationId: 'trusted-org', email: 'timeout@example.com' });
    const previousHash = prisma.__state.invitations[0].tokenHash;
    const originalUpdateMany = prisma.invitation.updateMany;
    let rotations = 0;
    prisma.invitation.updateMany = async (args) => {
      rotations += 1;
      return originalUpdateMany(args);
    };
    app.authService.emailService = {
      configured: true,
      async sendInvitationEmail() {
        const error = new Error('simulated timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      },
    };

    const result = await app.authService.resendInvitation({ organizationId: 'trusted-org', invitationId: pending.invitation.id });
    assert.equal(result.success, true);
    assert.equal(result.deliveryStatus, 'failed');
    assert.equal(result.emailError.code, 'ETIMEDOUT');
    assert.equal(rotations, 1);
    assert.notEqual(prisma.__state.invitations[0].tokenHash, previousHash);
    assert.match(result.invitationUrl, /#token=/);
  });
});
