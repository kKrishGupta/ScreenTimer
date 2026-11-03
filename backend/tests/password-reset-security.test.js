import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, hashPassword, verifyPassword } from '../src/modules/auth/auth.service.js';

function createMemoryPrisma() {
  const users = [];
  const sessions = [];
  const resetTokens = [];
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
          (token) => token.tokenHash === where.tokenHash && token.usedAt === where.usedAt,
        );
        matches.forEach((token) => Object.assign(token, data));
        return { count: matches.length };
      },
    },
    auditLog: { create: async ({ data }) => data },
  };
  prisma.$transaction = async (callback) => callback(prisma);
  prisma.__state = { users, sessions, resetTokens };
  return prisma;
}

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

    const service = new AuthService(prisma, { info() {}, error() {} });
    const requested = await service.requestPasswordReset({ email: attacker.email });

    await assert.rejects(
      service.confirmPasswordReset({
        email: victim.email,
        resetToken: requested.resetToken,
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

    const service = new AuthService(prisma, { info() {}, error() {} });
    const requested = await service.requestPasswordReset({ email: user.email });
    await service.confirmPasswordReset({
      email: user.email,
      resetToken: requested.resetToken,
      newPassword: 'NewPassword123!',
    });

    assert.ok(prisma.__state.sessions[0].revokedAt);
    assert.equal(prisma.__state.sessions[1].revokedAt, null);
    assert.equal(verifyPassword('NewPassword123!', user.passwordHash, user.passwordSalt), true);
  });
});
