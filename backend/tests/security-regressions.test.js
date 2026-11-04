import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = '33333333-3333-4333-8333-333333333333';
const ADMIN_B = '44444444-4444-4444-8444-444444444444';
const EMPLOYEE_A = '55555555-5555-4555-8555-555555555555';
const EMPLOYEE_B = '66666666-6666-4666-8666-666666666666';

function securityPrisma() {
  const policies = [];
  const mutations = [];
  return {
    policies,
    mutations,
    familyPolicy: {
      findMany: async ({ where }) => policies.filter((policy) => policy.organizationId === where.organizationId),
      create: async ({ data }) => { policies.push({ ...data }); return data; },
      update: async ({ where, data }) => {
        mutations.push({ type: 'update', where, data });
        const policy = policies.find((item) => item.id === where.id);
        if (policy) Object.assign(policy, data);
        return policy;
      },
      delete: async ({ where }) => {
        mutations.push({ type: 'delete', where });
        const index = policies.findIndex((item) => item.id === where.id);
        if (index >= 0) return policies.splice(index, 1)[0];
        throw new Error('not found');
      },
    },
    user: {
      findFirst: async ({ where }) => {
        const employees = [
          { id: EMPLOYEE_A, organizationId: ORG_A },
          { id: EMPLOYEE_B, organizationId: ORG_A },
        ];
        return employees.find((employee) => employee.id === where.id && employee.organizationId === where.organizationId) || null;
      },
    },
    activitySession: { findMany: async () => [] },
  };
}

async function createSecurityApp() {
  const prisma = securityPrisma();
  const config = loadConfig({ DATABASE_URL: 'postgresql://audit:audit@127.0.0.1:5433/audit', LOG_LEVEL: 'silent' });
  const app = await buildApp({ config, prisma, logger: false });
  const identities = {
    adminA: { id: ADMIN_A, organizationId: ORG_A, role: 'ORG_ADMIN' },
    adminB: { id: ADMIN_B, organizationId: ORG_B, role: 'ORG_ADMIN' },
    employeeA: { id: EMPLOYEE_A, organizationId: ORG_A, role: 'EMPLOYEE' },
    employeeB: { id: EMPLOYEE_B, organizationId: ORG_A, role: 'EMPLOYEE' },
  };
  app.authService.validateSession = async (token) => identities[token] ? { user: identities[token] } : null;
  const inject = (method, url, token, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  return { app, prisma, inject };
}

test('screen routes are disabled and never reveal consent, captures, or live sessions', async (t) => {
  const { app, inject } = await createSecurityApp();
  t.after(() => app.close());
  for (const [method, path] of [
    ['GET', '/api/v1/screen/config'],
    ['POST', '/api/v1/screen/consent'],
    ['GET', '/api/v1/screen/captures'],
    ['DELETE', '/api/v1/screen/captures/00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/v1/screen/live-session/start'],
  ]) {
    const response = await inject(method, path, 'employeeA', { consent: true });
    assert.equal(response.statusCode, 410, `${method} ${path}`);
    assert.equal(response.json().error.code, 'SCREEN_MONITORING_DISABLED');
  }
});

test('policy mutations are tenant-scoped and employees cannot mutate policies', async (t) => {
  const { app, prisma, inject } = await createSecurityApp();
  t.after(() => app.close());
  const created = await inject('POST', '/api/v1/policies', 'adminA', { name: 'Tenant A policy', action: 'block', restrictedDomains: ['blocked.example'] });
  assert.equal(created.statusCode, 200);
  const policyId = created.json().policy.id;

  const crossTenantPatch = await inject('PATCH', `/api/v1/policies/${policyId}`, 'adminB', { name: 'stolen' });
  assert.equal(crossTenantPatch.statusCode, 404);
  assert.equal(prisma.mutations.length, 0, 'cross-tenant mutation must not reach storage');

  const crossTenantDelete = await inject('DELETE', `/api/v1/policies/${policyId}`, 'adminB');
  assert.equal(crossTenantDelete.statusCode, 404);
  assert.equal(prisma.mutations.length, 0, 'cross-tenant delete must not reach storage');

  const employeePatch = await inject('PATCH', `/api/v1/policies/${policyId}`, 'employeeA', { name: 'also stolen' });
  assert.equal(employeePatch.statusCode, 403);
  assert.equal(prisma.mutations.length, 0, 'employee mutation must not reach storage');

  const ownerPatch = await inject('PATCH', `/api/v1/policies/${policyId}`, 'adminA', { name: 'Updated safely' });
  assert.equal(ownerPatch.statusCode, 200);
  assert.equal(prisma.mutations.length, 1);
});

test('weekly analytics ignores client-supplied role and cannot escape employee scope', async (t) => {
  const { app, inject } = await createSecurityApp();
  t.after(() => app.close());
  const response = await inject('GET', `/api/v1/analytics/weekly?role=ORG_ADMIN&employeeId=${EMPLOYEE_B}&range=today`, 'employeeA');
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error.message, /Employees can only view their own reports/i);
});
