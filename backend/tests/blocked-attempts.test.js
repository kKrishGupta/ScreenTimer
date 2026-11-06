import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

test('blocked reports require a device secret and derive ownership from the device', async (t) => {
  const org = '11111111-1111-4111-8111-111111111111';
  const deviceId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  let saved;
  const prisma = {
    familyPolicy: { findMany: async ({ where }) => {
      assert.equal(where.organizationId, org);
      return [{ id: '44444444-4444-4444-8444-444444444444', active: true, action: 'block', restrictedDomains: ['instagram.com'] }];
    } },
    policyViolation: { create: async ({ data }) => { saved = data; return data; } },
  };
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db' }), prisma, logger: false });
  t.after(() => app.close());
  app.deviceService.validateDeviceCredentials = async () => ({ valid: true, device: { id: deviceId, organizationId: org, userId } });
  const payload = { deviceId, domain: 'www.instagram.com', eventId: '55555555-5555-4555-8555-555555555555' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/policies/blocked-attempts', payload })).statusCode, 401);
  const response = await app.inject({ method: 'POST', url: '/api/v1/policies/blocked-attempts', headers: { 'x-device-secret': 'secret' }, payload });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(saved.organizationId, org);
  assert.equal(saved.userId, userId);
  assert.equal(saved.deviceId, deviceId);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/policies/blocked-attempts', headers: { 'x-device-secret': 'secret' }, payload: { ...payload, domain: 'instagram.com.evil.example' } })).statusCode, 409);
});
