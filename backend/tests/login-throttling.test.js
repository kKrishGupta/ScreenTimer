import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, hashPassword, Roles } from '../src/modules/auth/auth.service.js';

function createPersistentPrisma(email, password) {
  const credentials = hashPassword(password);
  const attempts = new Map();
  const users = [{
    id: 'throttle-user',
    organizationId: 'throttle-org',
    email,
    displayName: 'Throttle Test User',
    role: Roles.EMPLOYEE,
    employmentStatus: 'active',
    ...credentials,
  }];
  const locks = new Map();

  const loginAttempt = {
    findUnique: async ({ where }) => attempts.get(where.identifierHash) || null,
    create: async ({ data }) => {
      attempts.set(data.identifierHash, { ...data });
      return attempts.get(data.identifierHash);
    },
    update: async ({ where, data }) => {
      const row = attempts.get(where.identifierHash);
      if (!row) throw new Error('Login throttle record not found');
      Object.assign(row, data);
      return row;
    },
    deleteMany: async ({ where }) => {
      if (where.identifierHash) return { count: Number(attempts.delete(where.identifierHash)) };
      const expired = [...attempts.values()].filter((row) => row.updatedAt < where.updatedAt.lt);
      expired.forEach((row) => attempts.delete(row.identifierHash));
      return { count: expired.length };
    },
  };

  const prisma = {
    loginAttempt,
    user: {
      findFirst: async ({ where }) => users.find((user) => user.email === where.email) || null,
      findMany: async ({ where }) => users.filter((user) => user.email === where.email),
    },
    auditLog: { create: async ({ data }) => data },
    $executeRaw: async () => 1,
    $transaction: async (callback) => {
      const tx = Object.create(prisma);
      const releases = [];
      tx.$executeRaw = async (_strings, ...values) => {
        const key = values.join(':');
        const previous = locks.get(key) || Promise.resolve();
        let release;
        const next = new Promise((resolve) => { release = resolve; });
        locks.set(key, previous.then(() => next));
        await previous;
        releases.push(release);
        return 1;
      };
      try {
        return await callback(tx);
      } finally {
        releases.reverse().forEach((release) => release());
      }
    },
    __state: { attempts, users },
  };

  return prisma;
}

describe('shared persistent login throttling', () => {
  it('shares failed-login lockouts between AuthService instances without storing raw email', async () => {
    const email = 'persistent-throttle@example.test';
    const prisma = createPersistentPrisma(email, 'CorrectPassword123!');
    const firstInstance = new AuthService(prisma, { warn() {} }, { nodeEnv: 'development' });
    const secondInstance = new AuthService(prisma, { warn() {} }, { nodeEnv: 'development' });

    for (let count = 0; count < 4; count += 1) {
      await assert.rejects(firstInstance.login({ email, password: 'WrongPassword123!' }), { statusCode: 401 });
    }
    await assert.rejects(secondInstance.login({ email, password: 'WrongPassword123!' }), { statusCode: 401 });
    await assert.rejects(firstInstance.login({ email, password: 'CorrectPassword123!' }), { statusCode: 429 });

    assert.equal(prisma.__state.attempts.size, 1);
    const [identifierHash, record] = [...prisma.__state.attempts.entries()][0];
    assert.notEqual(identifierHash, email);
    assert.equal(record.failureCount, 5);
    assert.ok(record.lockedUntil > new Date());
  });

  it('fails closed in production if persistent throttle storage is missing', async () => {
    const service = new AuthService({
      user: { findFirst: async () => null },
      userSession: { create: async () => null },
    }, { warn() {} }, { nodeEnv: 'production' });

    await assert.rejects(
      service.login({ email: 'production@example.test', password: 'AnyPassword123!' }),
      { statusCode: 503, code: 'AUTHENTICATION_STORAGE_UNAVAILABLE' },
    );
  });
});
