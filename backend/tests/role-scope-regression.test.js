import test from 'node:test';
import assert from 'node:assert/strict';
import plannerRoutes from '../src/modules/planner/planner.routes.js';
import privacyRoutes from '../src/modules/privacy/privacy.routes.js';
import screenRoutes from '../src/modules/screen/screen.routes.js';

async function routes(plugin, prisma = {}) {
  const handlers = new Map();
  const app = { prisma, addHook() {} };
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (path, handler) => handlers.set(`${method} ${path}`, handler);
  }
  await plugin(app);
  return handlers;
}
function reply() {
  return { statusCode: 200, code(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return body; } };
}

test('planner memory tasks respect employee ownership and selected organization', async () => {
  const handlers = await routes(plannerRoutes);
  const create = handlers.get('post /planner/tasks');
  const list = handlers.get('get /planner/tasks');
  for (const [id, organizationId] of [['alice', 'scope-a'], ['bob', 'scope-a'], ['eve', 'scope-b']]) {
    await create({ method: 'POST', user: { id, organizationId, role: 'EMPLOYEE' }, body: { title: id, userId: 'spoofed' } }, reply());
  }
  const employee = await list({ method: 'GET', user: { id: 'alice', organizationId: 'scope-a', role: 'EMPLOYEE' } }, reply());
  assert.deepEqual(employee.tasks.map(t => t.userId), ['alice']);
  const admin = await list({ method: 'GET', user: { id: 'admin', organizationId: 'scope-a', role: 'ADMIN' } }, reply());
  assert.equal(admin.totalCount, 2);
  const superUser = { id: 'super', role: 'SUPER_ADMIN', organizationId: 'scope-a' };
  const denied = reply();
  await list({ method: 'GET', user: superUser }, denied);
  assert.equal(denied.statusCode, 400);
  const selected = await list({ method: 'GET', user: superUser, query: { organizationId: 'scope-b' } }, reply());
  assert.deepEqual(selected.tasks.map(t => t.userId), ['eve']);
});

test('planner database query includes both employee and organization', async () => {
  let where;
  const handlers = await routes(plannerRoutes, { plannerTask: { findMany: async args => { where = args.where; return []; } } });
  await handlers.get('get /planner/tasks')({ method: 'GET', user: { id: 'alice', role: 'EMPLOYEE', organizationId: 'scope-a' } }, reply());
  assert.deepEqual(where, { organizationId: 'scope-a', userId: 'alice' });
});

test('privacy super admin requires explicit organization and rejects a device outside it', async () => {
  const handlers = await routes(privacyRoutes, {
    device: { findUnique: async () => ({ id: 'device', organizationId: 'scope-b' }) },
    $transaction: () => { throw new Error('Deletion must never be reached'); },
  });
  const handler = handlers.get('post /privacy/delete-data');
  const user = { id: 'super', role: 'SUPER_ADMIN', organizationId: 'scope-a' };
  const missing = reply();
  await handler({ user, body: { confirmDelete: true } }, missing);
  assert.equal(missing.statusCode, 400);
  const crossTenant = reply();
  await handler({ user, body: { confirmDelete: true, organizationId: 'scope-a', deviceId: 'device' } }, crossTenant);
  assert.equal(crossTenant.statusCode, 403);
});

test('screen list scopes database ownership and detail denies another device owner', async () => {
  let where;
  const handlers = await routes(screenRoutes, {
    screenCaptureMetadata: {
      findMany: async args => {
        where = args.where;
        return [{ id: 'capture', organizationId: 'scope-a', deviceId: 'device', device: { userId: 'alice' } }];
      },
      findUnique: async () => ({ id: 'capture', organizationId: 'scope-a', deviceId: 'device', device: { userId: 'bob' } }),
    },
  });
  const user = { id: 'alice', role: 'EMPLOYEE', organizationId: 'scope-a' };
  const result = await handlers.get('get /screen/captures')({ user, query: {} }, reply());
  assert.deepEqual(where, { organizationId: 'scope-a', device: { userId: 'alice' } });
  assert.equal(result.totalCount, 1);
  const denied = reply();
  await handlers.get('get /screen/captures/:id')({ user, params: { id: 'capture' } }, denied);
  assert.equal(denied.statusCode, 403);
  const memoryHandlers = await routes(screenRoutes);
  const memory = await memoryHandlers.get('get /screen/captures')({ user, query: {} }, reply());
  assert.ok(memory.captures.every(c => c.organizationId === 'scope-a' && c.employeeId === 'alice'));
  const superUser = { id: 'super', role: 'SUPER_ADMIN', organizationId: 'scope-a' };
  for (const registered of [handlers, memoryHandlers]) {
    const missing = reply();
    await registered.get('get /screen/captures')({ user: superUser, query: {} }, missing);
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.error.code, 'ORGANIZATION_REQUIRED');
  }
  await handlers.get('get /screen/captures')({ user: superUser, query: { organizationId: 'scope-a' } }, reply());
  assert.deepEqual(where, { organizationId: 'scope-a' });
  for (const query of [{}, { organizationId: 'scope-b' }]) {
    const deniedScope = reply();
    await handlers.get('get /screen/captures/:id')({ user: superUser, params: { id: 'capture' }, query }, deniedScope);
    assert.equal(deniedScope.statusCode, 403);
  }
  const allowed = await handlers.get('get /screen/captures/:id')({ user: superUser, params: { id: 'capture' }, query: { organizationId: 'scope-a' } }, reply());
  assert.equal(allowed.success, true);
});
