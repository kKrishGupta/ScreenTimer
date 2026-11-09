import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

test('grace grants use authenticated tenant context without a local-dev lookup', async () => {
  const calls = [];
  const prisma = {
    $connect: async () => {},
    $disconnect: async () => {},
    $queryRaw: async () => [{ ok: 1 }],
    organization: {
      findFirst: async () => { throw new Error('hardcoded organization lookup must not run'); },
    },
    graceGrant: {
      findMany: async (query) => { calls.push(query); return []; },
    },
  };
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5433/test',
    HOST: '127.0.0.1',
    PORT: '3001',
  });
  const app = await buildApp({ config, prisma, logger: false });
  const organizationId = '11111111-1111-1111-1111-111111111111';
  const auth = await app.authService.createTestSession({ organizationId });

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/policies/grace',
    headers: auth.headers,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { grants: [], count: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.organizationId, organizationId);

  const missingDomainVisit = await app.inject({
    method: 'POST',
    url: '/api/v1/policies/grace/visit',
    headers: auth.headers,
    payload: {},
  });
  assert.equal(missingDomainVisit.statusCode, 400);

  const unauthenticated = await app.inject({
    method: 'GET',
    url: '/api/v1/policies/grace',
  });
  assert.equal(unauthenticated.statusCode, 401);

  await app.close();
});
