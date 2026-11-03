import 'dotenv/config';
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig, resolveDatabaseUrl } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';
import { AuthService, hashPassword, hashSessionToken, verifyPassword } from '../src/modules/auth/auth.service.js';

const skipReason = !process.env.TEST_DATABASE_URL
  ? 'TEST_DATABASE_URL not set (configure an isolated, migrated PostgreSQL test database)'
  : process.env.RUN_INTEGRATION_TESTS !== 'true'
    ? 'Integration tests disabled by default; set RUN_INTEGRATION_TESTS=true to use TEST_DATABASE_URL'
    : false;

const sessionCookie = (loginResponse) => loginResponse.headers['set-cookie'].split(';')[0];

function assertTestDatabaseIsIsolated() {
  const applicationDatabaseUrl = resolveDatabaseUrl(process.env);
  if (!process.env.TEST_DATABASE_URL || !applicationDatabaseUrl) return;
  const target = (value) => {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}${decodeURIComponent(url.pathname).replace(/\/+$/, '')}`;
  };
  assert.notEqual(
    target(process.env.TEST_DATABASE_URL),
    target(applicationDatabaseUrl),
    'TEST_DATABASE_URL must point to a dedicated database, not the application database',
  );
}

test('PostgreSQL invitation lifecycle persists, activates, expires, revokes, and rejects replay', { skip: skipReason }, async (t) => {
  assertTestDatabaseIsIsolated();
  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, LOG_LEVEL: 'silent' });
  const prisma = createPrismaClient(config);
  const app = await buildApp({ config, prisma, logger: false });
  let organizationId;
  const additionalOrganizationIds = [];
  const loginAttemptHashes = [];
  t.after(async () => {
    if (loginAttemptHashes.length) await prisma.loginAttempt.deleteMany({ where: { identifierHash: { in: loginAttemptHashes } } }).catch(() => {});
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } }).catch(() => {});
    for (const id of additionalOrganizationIds) await prisma.organization.delete({ where: { id } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const organization = await prisma.organization.create({
    data: { name: 'Invitation Lifecycle E2E', slug: `invite-e2e-${crypto.randomUUID()}` },
  });
  organizationId = organization.id;
  const adminEmail = `admin-${crypto.randomUUID()}@example.test`;
  const adminCredentials = hashPassword('AdminPassword123!');
  await prisma.user.create({ data: {
    organizationId,
    email: adminEmail,
    displayName: 'Invitation Test Administrator',
    role: 'ORG_ADMIN',
    passwordHash: adminCredentials.hash,
    passwordSalt: adminCredentials.salt,
    employmentStatus: 'active',
  } });
  const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: adminEmail, password: 'AdminPassword123!' } });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  const admin = { headers: { cookie: sessionCookie(adminLogin), origin: config.corsOrigins[0] } };

  app.authService.emailService = {
    configured: true,
    async sendInvitationEmail() { throw new Error('simulated email outage'); },
  };
  const employeeEmail = `employee-${crypto.randomUUID()}@example.test`;
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/invitations',
    headers: admin.headers,
    payload: {
      email: employeeEmail,
      displayName: 'E2E Employee',
      department: 'Engineering',
      role: 'EMPLOYEE',
      shiftStart: '09:00',
      shiftEnd: '17:00',
      workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      shiftTimezone: 'UTC',
    },
  });
  assert.equal(createResponse.statusCode, 201, createResponse.body);
  const created = createResponse.json();
  const token = new URLSearchParams(new URL(created.invitationUrl).hash.slice(1)).get('token');
  const persisted = await prisma.invitation.findUnique({ where: { id: created.invitation.id } });
  assert.equal(created.emailSent, false);
  assert.equal(persisted.token, null);
  assert.equal(persisted.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(persisted.role, 'EMPLOYEE');
  const validation = await app.inject({ method: 'POST', url: '/api/v1/invitations/validate', payload: { token } });
  assert.equal(validation.statusCode, 200, validation.body);
  assert.equal(validation.json().invitation.organizationName, organization.name);
  assert.equal(validation.json().invitation.department, 'Engineering');
  assert.equal(JSON.stringify(validation.json()).includes(token), false);
  const pendingDirectory = await app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers });
  assert.equal(pendingDirectory.json().invitations.find((row) => row.id === created.invitation.id).status, 'pending');

  const acceptedResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/invitations/accept',
    payload: { token, password: 'StrongPassword123!', displayName: 'E2E Employee' },
  });
  assert.equal(acceptedResponse.statusCode, 200, acceptedResponse.body);
  const accepted = acceptedResponse.json();
  const account = await prisma.user.findUnique({ where: { id: accepted.user.id } });
  assert.equal(account.email, persisted.email);
  assert.equal(account.organizationId, organizationId);
  assert.equal(account.role, 'EMPLOYEE');
  assert.equal('passwordHash' in accepted.user, false);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: employeeEmail, password: 'StrongPassword123!' } });
  assert.equal(login.statusCode, 200, login.body);
  const employeeCookie = sessionCookie(login);
  const employeeRawSessionToken = employeeCookie.slice(employeeCookie.indexOf('=') + 1);
  const persistedSession = await prisma.userSession.findUnique({ where: { tokenHash: hashSessionToken(employeeRawSessionToken) } });
  assert.ok(persistedSession);
  assert.equal(persistedSession.token, undefined);
  const productionSessionVerifier = new AuthService(prisma, app.log, { ...config, nodeEnv: 'production' });
  assert.equal((await productionSessionVerifier.validateSession(employeeRawSessionToken))?.user.email, employeeEmail);
  const employeeAdminAccess = await app.inject({ method: 'GET', url: '/api/v1/invitations', headers: { cookie: employeeCookie } });
  assert.equal(employeeAdminAccess.statusCode, 403);

  let emailedResetToken;
  const productionResetService = new AuthService(prisma, app.log, { ...config, nodeEnv: 'production' });
  productionResetService.emailService = {
    configured: true,
    async sendPasswordResetEmail({ resetToken }) { emailedResetToken = resetToken; },
  };
  const resetRequest = await productionResetService.requestPasswordReset({ email: employeeEmail });
  assert.equal('resetToken' in resetRequest, false);
  assert.ok(emailedResetToken);
  const resetHash = hashSessionToken(emailedResetToken);
  const resetRecord = await prisma.passwordResetToken.findUnique({ where: { tokenHash: resetHash } });
  assert.ok(resetRecord);
  assert.equal(resetRecord.token, undefined);
  await productionResetService.confirmPasswordReset({ email: employeeEmail, resetToken: emailedResetToken, newPassword: 'UpdatedEmployee123!' });
  const resetEmployee = await prisma.user.findUnique({ where: { id: accepted.user.id } });
  assert.equal(verifyPassword('UpdatedEmployee123!', resetEmployee.passwordHash, resetEmployee.passwordSalt), true);
  assert.ok((await prisma.passwordResetToken.findUnique({ where: { tokenHash: resetHash } })).usedAt);
  assert.equal(await productionSessionVerifier.validateSession(employeeRawSessionToken), null);
  await assert.rejects(productionResetService.confirmPasswordReset({ email: employeeEmail, resetToken: emailedResetToken, newPassword: 'AnotherEmployee123!' }), { statusCode: 400 });

  const updatedEmployeeLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: employeeEmail, password: 'UpdatedEmployee123!' } });
  assert.equal(updatedEmployeeLogin.statusCode, 200, updatedEmployeeLogin.body);
  const updatedEmployeeCookie = sessionCookie(updatedEmployeeLogin);
  const updatedEmployeeToken = updatedEmployeeCookie.slice(updatedEmployeeCookie.indexOf('=') + 1);
  assert.equal((await productionSessionVerifier.validateSession(updatedEmployeeToken))?.user.email, employeeEmail);
  const employeeLogout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: updatedEmployeeCookie, origin: config.corsOrigins[0] } });
  assert.equal(employeeLogout.statusCode, 200);
  assert.equal(await productionSessionVerifier.validateSession(updatedEmployeeToken), null);

  const acceptedDirectory = await app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers });
  assert.equal(acceptedDirectory.json().invitations.find((row) => row.id === created.invitation.id).status, 'accepted');
  const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token, password: 'AnotherPassword123!' } });
  assert.equal(replay.statusCode, 409);

  const expired = await app.authService.createInvitation({ organizationId, email: `expired-${crypto.randomUUID()}@example.test` });
  const expiredToken = new URLSearchParams(new URL(expired.invitationUrl).hash.slice(1)).get('token');
  await prisma.invitation.update({ where: { id: expired.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expiredValidation = await app.inject({ method: 'POST', url: '/api/v1/invitations/validate', payload: { token: expiredToken } });
  assert.equal(expiredValidation.statusCode, 410);
  assert.match(expiredValidation.json().error.message, /expired/i);

  const revoked = await app.authService.createInvitation({ organizationId, email: `revoked-${crypto.randomUUID()}@example.test` });
  const revokedToken = new URLSearchParams(new URL(revoked.invitationUrl).hash.slice(1)).get('token');
  const revokeResponse = await app.inject({ method: 'DELETE', url: `/api/v1/invitations/${revoked.invitation.id}`, headers: admin.headers });
  assert.equal(revokeResponse.statusCode, 200);
  const revokedRow = await prisma.invitation.findUnique({ where: { id: revoked.invitation.id } });
  assert.ok(revokedRow.tokenHash);
  const revokedValidation = await app.inject({ method: 'POST', url: '/api/v1/invitations/validate', payload: { token: revokedToken } });
  assert.equal(revokedValidation.statusCode, 410);
  assert.match(revokedValidation.json().error.message, /revoked/i);

  const pending = await app.authService.createInvitation({ organizationId, email: `resend-${crypto.randomUUID()}@example.test` });
  const oldToken = new URLSearchParams(new URL(pending.invitationUrl).hash.slice(1)).get('token');
  const resendResponse = await app.inject({ method: 'POST', url: `/api/v1/invitations/${pending.invitation.id}/resend`, headers: admin.headers });
  assert.equal(resendResponse.statusCode, 200, resendResponse.body);
  const resent = resendResponse.json();
  const newToken = new URLSearchParams(new URL(resent.invitationUrl).hash.slice(1)).get('token');
  assert.notEqual(newToken, oldToken);
  const oldTokenValidation = await app.inject({ method: 'POST', url: '/api/v1/invitations/validate', payload: { token: oldToken } });
  assert.equal(oldTokenValidation.statusCode, 404);
  const newTokenValidation = await app.inject({ method: 'POST', url: '/api/v1/invitations/validate', payload: { token: newToken } });
  assert.equal(newTokenValidation.statusCode, 200);
  assert.equal(newTokenValidation.json().invitation.email, pending.invitation.email);

  const existingEmail = `existing-${crypto.randomUUID()}@example.test`;
  const existingCredentials = hashPassword('ExistingPassword123!');
  const existingAccount = await prisma.user.create({
    data: {
      organizationId,
      email: existingEmail,
      displayName: 'Existing Employee',
      role: 'EMPLOYEE',
      passwordHash: existingCredentials.hash,
      passwordSalt: existingCredentials.salt,
      employmentStatus: 'active',
      shiftStart: '10:00',
      shiftEnd: '18:00',
      workingDays: ['Tue'],
      shiftTimezone: 'UTC',
    },
  });
  const existingInvitation = await app.authService.createInvitation({
    organizationId,
    email: existingEmail,
    shiftStart: '08:30',
    shiftEnd: '16:30',
    workingDays: ['Mon', 'Wed'],
    shiftTimezone: 'Asia/Kolkata',
  });
  const existingToken = new URLSearchParams(new URL(existingInvitation.invitationUrl).hash.slice(1)).get('token');
  const unauthenticatedExisting = await app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token: existingToken, password: 'AttemptedPassword123!', displayName: 'Changed Name' } });
  assert.equal(unauthenticatedExisting.statusCode, 409);
  assert.equal(unauthenticatedExisting.json().error.code, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
  const existingLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: existingEmail, password: 'ExistingPassword123!' } });
  assert.equal(existingLogin.statusCode, 200, existingLogin.body);
  const existingAcceptance = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/invitations/accept',
    headers: { cookie: sessionCookie(existingLogin), origin: config.corsOrigins[0] },
    payload: { token: existingToken },
  });
  assert.equal(existingAcceptance.statusCode, 200, existingAcceptance.body);
  assert.equal(existingAcceptance.json().existingAccount, true);
  assert.equal(existingAcceptance.json().user.id, existingAccount.id);
  const attachedExisting = await prisma.user.findUnique({ where: { id: existingAccount.id } });
  assert.equal(attachedExisting.passwordHash, existingCredentials.hash);
  assert.equal(attachedExisting.passwordSalt, existingCredentials.salt);
  assert.equal(attachedExisting.organizationId, organizationId);
  assert.equal(attachedExisting.role, 'EMPLOYEE');
  assert.equal(attachedExisting.displayName, 'Existing Employee');
  assert.equal(attachedExisting.shiftStart, '08:30');
  assert.deepEqual(attachedExisting.workingDays, ['Mon', 'Wed']);

  const otherOrganization = await prisma.organization.create({
    data: { name: 'Other Invitation Organization', slug: `invite-e2e-other-${crypto.randomUUID()}` },
  });
  additionalOrganizationIds.push(otherOrganization.id);
  const crossOrgEmail = `cross-org-${crypto.randomUUID()}@example.test`;
  const otherCredentials = hashPassword('OtherPassword123!');
  const otherAccount = await prisma.user.create({
    data: {
      organizationId: otherOrganization.id,
      email: crossOrgEmail,
      displayName: 'Other Organization Employee',
      role: 'EMPLOYEE',
      passwordHash: otherCredentials.hash,
      passwordSalt: otherCredentials.salt,
      employmentStatus: 'active',
    },
  });
  const crossOrgInvitation = await app.authService.createInvitation({ organizationId, email: crossOrgEmail });
  const crossOrgToken = new URLSearchParams(new URL(crossOrgInvitation.invitationUrl).hash.slice(1)).get('token');
  const otherLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: crossOrgEmail, password: 'OtherPassword123!' } });
  assert.equal(otherLogin.statusCode, 200, otherLogin.body);
  const crossOrgAcceptance = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/invitations/accept',
    headers: { cookie: sessionCookie(otherLogin), origin: config.corsOrigins[0] },
    payload: { token: crossOrgToken },
  });
  assert.equal(crossOrgAcceptance.statusCode, 409);
  assert.equal(crossOrgAcceptance.json().error.code, 'ORGANIZATION_MEMBERSHIP_UNSUPPORTED');
  assert.equal((await prisma.user.findUnique({ where: { id: otherAccount.id } })).organizationId, otherOrganization.id);

  const crossOrgRaceEmail = `cross-org-race-${crypto.randomUUID()}@example.test`;
  const [orgInvite, otherOrgInvite] = await Promise.all([
    app.authService.createInvitation({ organizationId, email: crossOrgRaceEmail }),
    app.authService.createInvitation({ organizationId: otherOrganization.id, email: crossOrgRaceEmail }),
  ]);
  const orgToken = new URLSearchParams(new URL(orgInvite.invitationUrl).hash.slice(1)).get('token');
  const otherOrgToken = new URLSearchParams(new URL(otherOrgInvite.invitationUrl).hash.slice(1)).get('token');
  const crossOrgRaceResults = await Promise.all([
    app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token: orgToken, displayName: 'One Organization Employee', password: 'StrongPassword123!' } }),
    app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: { token: otherOrgToken, displayName: 'Other Organization Employee', password: 'StrongPassword123!' } }),
  ]);
  assert.deepEqual(crossOrgRaceResults.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(crossOrgRaceResults.find((response) => response.statusCode === 409).json().error.code, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
  assert.equal(await prisma.user.count({ where: { email: { equals: crossOrgRaceEmail, mode: 'insensitive' } } }), 1);

  const concurrentEmail = `concurrent-${crypto.randomUUID()}@example.test`;
  const concurrentInvite = await app.authService.createInvitation({ organizationId, email: concurrentEmail });
  const concurrentToken = new URLSearchParams(new URL(concurrentInvite.invitationUrl).hash.slice(1)).get('token');
  const concurrentPayload = { token: concurrentToken, displayName: 'Concurrent Employee', password: 'ConcurrentPassword123!' };
  const concurrentResults = await Promise.all([
    app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: concurrentPayload }),
    app.inject({ method: 'POST', url: '/api/v1/auth/invitations/accept', payload: concurrentPayload }),
  ]);
  assert.deepEqual(concurrentResults.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(concurrentResults.find((response) => response.statusCode === 409).json().error.code, 'INVITATION_ALREADY_ACCEPTED');
  assert.equal(await prisma.user.count({ where: { organizationId, email: concurrentEmail } }), 1);

  const throttledEmail = `throttle-${crypto.randomUUID()}@example.test`;
  const throttleCredentials = hashPassword('ThrottlePassword123!');
  await prisma.user.create({ data: {
    organizationId,
    email: throttledEmail,
    displayName: 'Throttle Test Employee',
    role: 'EMPLOYEE',
    passwordHash: throttleCredentials.hash,
    passwordSalt: throttleCredentials.salt,
    employmentStatus: 'active',
  } });
  const throttleHash = hashSessionToken(throttledEmail);
  loginAttemptHashes.push(throttleHash);
  for (let count = 0; count < 5; count += 1) {
    const failedLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: throttledEmail, password: 'WrongThrottlePassword!' } });
    assert.equal(failedLogin.statusCode, 401, failedLogin.body);
  }
  const secondBackendInstance = new AuthService(prisma, app.log, config);
  await assert.rejects(secondBackendInstance.login({ email: throttledEmail, password: 'ThrottlePassword123!' }), { statusCode: 429 });
  assert.ok(await prisma.loginAttempt.findUnique({ where: { identifierHash: throttleHash } }));
});
