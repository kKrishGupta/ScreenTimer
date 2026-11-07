import test from 'node:test';
import assert from 'node:assert/strict';
import plannerRoutes from '../src/modules/planner/planner.routes.js';
import privacyRoutes from '../src/modules/privacy/privacy.routes.js';
import screenRoutes from '../src/modules/screen/screen.routes.js';

async function routes(plugin, prisma = {}) {
  const handlers = new Map();
  const app = { prisma, addHook() {}, addContentTypeParser() {}, log: { error() {} } };
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (path, ...args) => handlers.set(`${method} ${path}`, args.at(-1));
  }
  await plugin(app);
  return handlers;
}
function reply() {
  return { statusCode: 200, code(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return body; } };
}

test('screen device status uses stored capture metadata and exposes policy denial', async () => {
  const capturedAt = new Date('2026-11-06T10:00:00Z');
  const handlers = await routes(screenRoutes, {
    device: { findMany: async ({ where }) => {
      assert.equal(where.organizationId, 'scope-a');
      return [{ id: 'device', kind: 'DESKTOP_AGENT', organizationId: 'scope-a', userId: 'employee', screenCaptureEnabled: false, lastScreenCaptureAt: new Date('2026-11-06T11:00:00Z') }];
    } },
    screenCaptureMetadata: { findMany: async ({ where }) => {
      assert.equal(where.organizationId, 'scope-a');
      return [{ id: 'capture', deviceId: 'device', capturedAt }];
    } },
  });
  const result = await handlers.get('get /screen-monitoring/employees')({ user: { role: 'ADMIN', organizationId: 'scope-a' } }, reply());
  assert.equal(result.employees[0].lastCaptureAt, capturedAt);
  assert.equal(result.employees[0].captureStatusMismatch, true);
  assert.equal(result.employees[0].policyReason, 'DEVICE_NOT_SELECTED');
});

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

test('screen monitoring is admin-only and all capture queries are organization-scoped', async () => {
  let where;
  const handlers = await routes(screenRoutes, {
    screenCaptureMetadata: {
      findMany: async (args) => { where = args.where; return []; },
      count: async () => 0,
    },
  });

  const employeeReply = reply();
  await handlers.get('get /screen-monitoring/captures')({ user: { id: 'alice', role: 'EMPLOYEE', organizationId: 'scope-a' }, query: {} }, employeeReply);
  assert.equal(employeeReply.statusCode, 403);

  await handlers.get('get /screen-monitoring/captures')({ user: { id: 'admin', email: 'admin@example.test', role: 'ADMIN', organizationId: 'scope-a' }, query: {} }, reply());
  assert.equal(where.organizationId, 'scope-a');
  assert.ok(where.expiresAt?.gt instanceof Date);

  const superUser = { id: 'super', role: 'SUPER_ADMIN', organizationId: 'scope-a' };
  const missing = reply();
  await handlers.get('get /screen-monitoring/captures')({ user: superUser, query: {} }, missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error.code, 'ORGANIZATION_SCOPE_REQUIRED');

  await handlers.get('get /screen-monitoring/captures')({ user: superUser, query: { organizationId: 'scope-b' } }, reply());
  assert.equal(where.organizationId, 'scope-b');
  assert.ok(where.expiresAt?.gt instanceof Date);
});
