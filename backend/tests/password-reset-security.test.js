import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { AuthService, hashPassword, verifyPassword } from '../src/modules/auth/auth.service.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { createEmailService } from '../src/modules/auth/email.service.js';

function createMemoryPrisma() {
  const users = [];
  const sessions = [];
  const resetTokens = [];
  const auditLogs = [];
  const prisma = {
    user: {
      findFirst: async ({ where }) => users.find((user) => user.email === where.email) || null,
      update: async ({ where, data }) => {
        const user = users.find((item) => item.id === where.id);
        Object.assign(user, data);
        return user;
      },
    },
    userSession: {
      updateMany: async ({ where, data }) => {
        const matches = sessions.filter(
          (session) => session.userId === where.userId && session.revokedAt === where.revokedAt,
        );
        matches.forEach((session) => Object.assign(session, data));
        return { count: matches.length };
      },
    },
    passwordResetToken: {
      create: async ({ data }) => {
        const token = { id: `reset-${resetTokens.length + 1}`, usedAt: null, ...data };
        resetTokens.push(token);
        return token;
      },
      findUnique: async ({ where }) =>
        (() => {
          const token = resetTokens.find((item) => item.tokenHash === where.tokenHash);
          if (!token) return null;
          return {
            ...token,
            user: users.find((user) => user.id === token.userId) || null,
          };
        })(),
      updateMany: async ({ where, data }) => {
        const matches = resetTokens.filter(
          (token) => token.tokenHash === where.tokenHash && token.usedAt === where.usedAt
            && (!where.expiresAt?.gt || token.expiresAt > where.expiresAt.gt),
        );
        matches.forEach((token) => Object.assign(token, data));
        return { count: matches.length };
      },
    },
    auditLog: { create: async ({ data }) => { auditLogs.push(data); return data; } },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  prisma.__state = { users, sessions, resetTokens, auditLogs };
  return prisma;
}

function resetService(prisma, config = {}) {
  const service = new AuthService(prisma, { info() {}, error() {} }, { smtpUser: '', ...config });
  const delivered = [];
  service.emailService = { configured: true, async sendPasswordResetEmail(message) { delivered.push(message); } };
  return { service, delivered };
}

function addUser(prisma) {
  const { hash, salt } = hashPassword('OriginalPassword123!');
  const user = { id: 'reset-user', email: 'reset@example.test', organizationId: 'reset-org', passwordHash: hash, passwordSalt: salt };
  prisma.__state.users.push(user);
  return user;
}

const testConfig = () => loadConfig({ DATABASE_URL: 'postgresql://test:test@localhost:5433/test', SMTP_USER: '' });

describe('password reset identity binding', () => {
  it('does not allow a valid token to reset another account', async () => {
    const prisma = createMemoryPrisma();
    const attacker = { id: 'user-attacker', email: 'attacker@example.com', organizationId: 'org-a' };
    const victim = { id: 'user-victim', email: 'victim@example.com', organizationId: 'org-a' };
    for (const user of [attacker, victim]) {
      const { hash, salt } = hashPassword('OriginalPassword123!');
      user.passwordHash = hash;
      user.passwordSalt = salt;
      prisma.__state.users.push(user);
    }

    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: attacker.email });

    await assert.rejects(
      service.confirmPasswordReset({
        email: victim.email,
        resetToken: delivered[0].resetToken,
        newPassword: 'CompromisedPassword123!',
      }),
      (error) => error.statusCode === 400,
    );

    assert.equal(verifyPassword('OriginalPassword123!', victim.passwordHash, victim.passwordSalt), true);
    assert.equal(verifyPassword('CompromisedPassword123!', victim.passwordHash, victim.passwordSalt), false);
  });

  it('revokes only the target user sessions after a valid reset', async () => {
    const prisma = createMemoryPrisma();
    const user = { id: 'user-reset', email: 'reset@example.com', organizationId: 'org-a' };
    const { hash, salt } = hashPassword('OriginalPassword123!');
    user.passwordHash = hash;
    user.passwordSalt = salt;
    prisma.__state.users.push(user);
    prisma.__state.sessions.push(
      { id: 'session-target', userId: user.id, revokedAt: null },
      { id: 'session-other', userId: 'other-user', revokedAt: null },
    );

    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    await service.confirmPasswordReset({
      email: user.email,
      resetToken: delivered[0].resetToken,
      newPassword: 'NewPassword123!',
    });

    assert.ok(prisma.__state.sessions[0].revokedAt);
    assert.equal(prisma.__state.sessions[1].revokedAt, null);
    assert.equal(verifyPassword('NewPassword123!', user.passwordHash, user.passwordSalt), true);
  });
});

describe('password reset token confidentiality and lifecycle', () => {
  it('delivers tokens only through email and stores only a hash with configured expiry', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const { service, delivered } = resetService(prisma, { passwordResetTtlMinutes: 10 });
    const before = Date.now();
    const result = await service.requestPasswordReset({ email: user.email });
    const { resetToken, expiresInMinutes } = delivered[0];
    assert.match(resetToken, /^[a-f0-9]{64}$/);
    assert.equal(expiresInMinutes, 10);
    assert.equal(result.resetToken, undefined);
    const stored = prisma.__state.resetTokens[0];
    assert.equal(stored.tokenHash, createHash('sha256').update(resetToken).digest('hex'));
    assert.ok(stored.expiresAt.getTime() >= before + 10 * 60 * 1000);
    assert.ok(stored.expiresAt.getTime() <= Date.now() + 10 * 60 * 1000);
    assert.equal(JSON.stringify(prisma.__state).includes(resetToken), false);
    assert.deepEqual(await service.requestPasswordReset({ email: 'unknown@example.test' }), result);
    assert.equal(delivered.length, 1);
  });

  it('never exposes a development token when SMTP is unavailable', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const service = new AuthService(prisma, {}, { smtpUser: '' });
    for (const email of [user.email, 'unknown@example.test']) {
      await assert.rejects(service.requestPasswordReset({ email }), {
        statusCode: 503, message: 'Password reset is temporarily unavailable',
      });
    }
    assert.equal(prisma.__state.resetTokens.length, 0);
  });

  it('consumes a valid token once and rejects replay after a service restart', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    const details = { email: user.email, resetToken: delivered[0].resetToken, newPassword: 'NewPassword123!' };
    await service.confirmPasswordReset(details);
    assert.ok(prisma.__state.resetTokens[0].usedAt);
    assert.equal(verifyPassword(details.newPassword, user.passwordHash, user.passwordSalt), true);
    const { service: restarted } = resetService(prisma);
    await assert.rejects(restarted.confirmPasswordReset(details), { code: 'RESET_LINK_INVALID' });
  });

  it('rejects invalid, malformed, missing, and expired tokens without changing a password', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    prisma.__state.resetTokens[0].expiresAt = new Date(0);
    for (const resetToken of [delivered[0].resetToken, randomBytes(32).toString('hex'), '', undefined, {}]) {
      await assert.rejects(service.confirmPasswordReset({ email: user.email, resetToken, newPassword: 'NewPassword123!' }), { code: 'RESET_LINK_INVALID' });
    }
    assert.equal(verifyPassword('OriginalPassword123!', user.passwordHash, user.passwordSalt), true);
    assert.equal(prisma.__state.resetTokens[0].usedAt, null);
  });

  it('enforces password length without consuming the token', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    const details = { resetToken: delivered[0].resetToken, email: user.email };
    await assert.rejects(service.confirmPasswordReset({ ...details, newPassword: 'short' }), { code: 'PASSWORD_TOO_SHORT' });
    assert.equal(prisma.__state.resetTokens[0].usedAt, null);
    await service.confirmPasswordReset({ ...details, newPassword: 'NewPassword123!' });
  });

  it('rejects concurrent reuse and rechecks expiry when claiming a persistent token', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    const details = { resetToken: delivered[0].resetToken, newPassword: 'NewPassword123!' };
    const results = await Promise.allSettled([service.confirmPasswordReset(details), service.confirmPasswordReset(details)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'RESET_LINK_INVALID');

    await service.requestPasswordReset({ email: user.email });
    const updateMany = prisma.passwordResetToken.updateMany;
    prisma.passwordResetToken.updateMany = async (args) => {
      prisma.__state.resetTokens[1].expiresAt = new Date(0);
      assert.ok(args.where.expiresAt.gt instanceof Date);
      return updateMany(args);
    };
    await assert.rejects(service.confirmPasswordReset({ ...details, resetToken: delivered[1].resetToken }), { code: 'RESET_LINK_INVALID' });
  });

  it('consumes development fallback tokens once, even for concurrent submissions', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    delete prisma.passwordResetToken;
    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    const details = { resetToken: delivered[0].resetToken, newPassword: 'NewPassword123!' };
    const results = await Promise.allSettled([service.confirmPasswordReset(details), service.confirmPasswordReset(details)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    await assert.rejects(service.confirmPasswordReset(details), { code: 'RESET_LINK_INVALID' });
  });

  it('fails closed when a persisted token cannot be consumed transactionally', async () => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const { service, delivered } = resetService(prisma);
    await service.requestPasswordReset({ email: user.email });
    delete prisma.$transaction;
    await assert.rejects(service.confirmPasswordReset({ resetToken: delivered[0].resetToken, newPassword: 'NewPassword123!' }), { statusCode: 503 });
    assert.equal(verifyPassword('OriginalPassword123!', user.passwordHash, user.passwordSalt), true);
  });
});

describe('password reset HTTP protections', () => {
  it('keeps recovery available when background traffic exhausts the general request limit', async (t) => {
    const app = await buildApp({ config: testConfig(), prisma: createMemoryPrisma(), logger: false });
    t.after(() => app.close());
    app.authService.emailService = { configured: true, async sendPasswordResetEmail() {} };
    let background;
    for (let i = 0; i < 201; i++) background = await app.inject({ method: 'GET', url: '/api/v1/devices' });
    assert.equal(background.statusCode, 429);
    const recovery = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-request', payload: { email: 'unknown@example.test' } });
    assert.equal(recovery.statusCode, 200);
    assert.equal(Number(recovery.headers['x-ratelimit-limit']), 5);
    const confirm = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-confirm', payload: { resetToken: randomBytes(32).toString('hex'), newPassword: 'NewPassword123!' } });
    assert.equal(confirm.statusCode, 400);
    assert.equal(Number(confirm.headers['x-ratelimit-limit']), 10);
  });

  it('rate limits reset requests and confirmations separately by IP', async (t) => {
    const app = await buildApp({ config: testConfig(), prisma: createMemoryPrisma(), logger: false });
    t.after(() => app.close());
    for (const [path, limit, payload] of [
      ['request', 5, { email: 'unknown@example.test' }],
      ['confirm', 10, { resetToken: randomBytes(32).toString('hex'), newPassword: 'NewPassword123!' }],
    ]) {
      for (let i = 0; i < limit; i++) {
        const response = await app.inject({ method: 'POST', url: `/api/v1/auth/reset-password-${path}`, payload });
        assert.notEqual(response.statusCode, 429);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['referrer-policy'], 'no-referrer');
        assert.equal(response.json().resetToken, undefined);
      }
      const blocked = await app.inject({ method: 'POST', url: `/api/v1/auth/reset-password-${path}`, payload });
      assert.equal(blocked.statusCode, 429);
      assert.ok(Number(blocked.headers['retry-after']) > 0);
      assert.equal(blocked.headers['cache-control'], 'no-store');
      const otherIp = await app.inject({ method: 'POST', url: `/api/v1/auth/reset-password-${path}`, payload, remoteAddress: '127.0.0.2' });
      assert.notEqual(otherIp.statusCode, 429);
    }
  });

  it('does not log or return tokens from queries, SMTP errors, parser errors, or unexpected errors', async (t) => {
    const prisma = createMemoryPrisma();
    const user = addUser(prisma);
    const logs = [];
    const app = await buildApp({ config: testConfig(), prisma, logger: { level: 'info', stream: { write(chunk) { logs.push(chunk.toString()); } } } });
    t.after(() => app.close());
    let emailedToken;
    app.authService.emailService = {
      configured: true,
      async sendPasswordResetEmail({ resetToken }) { emailedToken = resetToken; throw new Error(`SMTP refused email containing ${resetToken}`); },
    };
    const mailFailure = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-request', payload: { email: user.email } });
    assert.equal(mailFailure.statusCode, 503);
    assert.equal(mailFailure.body.includes(emailedToken), false);
    const requestToken = randomBytes(32).toString('hex');
    app.authService.confirmPasswordReset = async () => { throw new Error(`Unexpected failure with ${requestToken}`); };
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/auth/reset-password-confirm?token=${requestToken}`, payload: { resetToken: requestToken, newPassword: 'NewPassword123!' } });
    assert.equal(confirm.statusCode, 503);
    assert.equal(confirm.body.includes(requestToken), false);
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password-confirm', headers: { 'content-type': 'application/json' }, payload: `{"resetToken":"${requestToken}"` });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.body.includes(requestToken), false);
    const output = logs.join('');
    assert.match(output, /Password reset email delivery failed/);
    assert.equal(output.includes(emailedToken), false);
    assert.equal(output.includes(requestToken), false);
    assert.equal(JSON.stringify(prisma.__state.auditLogs).includes(emailedToken), false);
  });

  it('adds no-referrer to emailed reset links and uses the configured expiry', async (t) => {
    let mail;
    t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (message) => { mail = message; } }));
    const service = createEmailService({ smtpUser: 'mailer@example.test', smtpPassword: 'test-only-password' });
    const resetToken = randomBytes(32).toString('hex');
    await service.sendPasswordResetEmail({ to: 'user@example.test', resetToken, resetUrl: 'https://app.example.test/reset-password', expiresInMinutes: 10 });
    assert.match(mail.html, /referrerpolicy="no-referrer"/);
    assert.match(mail.html, /rel="noreferrer"/);
    assert.match(mail.text, /expires in 10 minutes/);
    const url = new URL(mail.text.match(/https:\/\/\S+/)[0]);
    assert.equal(url.searchParams.get('token'), resetToken);
    assert.equal(url.searchParams.get('email'), 'user@example.test');
  });
});
