import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import familyRoutes from '../src/modules/family/family.routes.js';

test('legacy family device enrichment is tenant scoped and hides deleted devices', async () => {
  const calls = [];
  const prisma = {
    device: {
      findMany: async (query) => {
        calls.push(query);
        if (query.where.organizationId !== 'org-a') return [];
        return [{ id: 'org-a-visible', name: 'Visible device', kind: 'DESKTOP_AGENT' }];
      },
    },
  };
  let sessionUser = { id: 'admin-a', role: 'ORGANIZATION_ADMIN', organizationId: 'org-a' };
  const app = Fastify({ logger: false });
  app.decorate('prisma', prisma);
  app.addHook('preHandler', async (request) => { request.user = sessionUser; });
  await app.register(familyRoutes, { prefix: '/api/v1' });

  const orgA = await app.inject({ method: 'GET', url: '/api/v1/family/members' });
  assert.equal(orgA.statusCode, 200, orgA.body);
  assert.deepEqual(calls[0].where, { organizationId: 'org-a', deletedAt: null });
  assert.equal(orgA.json().members.flatMap((member) => member.devices).some((device) => device.id === 'org-a-visible'), true);

  sessionUser = { id: 'admin-b', role: 'ORGANIZATION_ADMIN', organizationId: 'org-b' };
  const orgB = await app.inject({ method: 'GET', url: '/api/v1/family/members' });
  assert.equal(orgB.statusCode, 200, orgB.body);
  assert.deepEqual(calls[1].where, { organizationId: 'org-b', deletedAt: null });
  assert.deepEqual(orgB.json().members.flatMap((member) => member.devices), []);

  sessionUser = { id: 'root', role: 'SUPER_ADMIN', organizationId: null };
  const unscoped = await app.inject({ method: 'GET', url: '/api/v1/family/members' });
  assert.equal(unscoped.statusCode, 400, unscoped.body);
  assert.equal(unscoped.json().error.code, 'ORGANIZATION_SCOPE_REQUIRED');

  await app.close();
});
