import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

function fakePrisma() {
  const devices = [];
  const tokens = [];
  const auditLogs = [];

  return {
    deviceEnrollmentToken: {
      create: async ({ data }) => {
        tokens.push(data);
        return data;
      },
      findUnique: async ({ where }) => tokens.find((t) => t.token === where.token) || null,
      update: async ({ where, data }) => {
        const t = tokens.find((item) => item.token === where.token);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    device: {
      upsert: async ({ where, create, update }) => {
        let existing = devices.find((d) => d.id === where.id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created = { ...create };
        devices.push(created);
        return created;
      },
      findMany: async () => devices,
      findUnique: async ({ where }) => devices.find((d) => d.id === where.id) || null,
      update: async ({ where, data }) => {
        const d = devices.find((item) => item.id === where.id);
        if (d) Object.assign(d, data);
        return d;
      },
    },
    organization: {
      findUnique: async () => ({ id: '00000000-0000-0000-0000-000000000000', slug: 'local-dev' }),
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push(data);
        return data;
      },
    },
  };
}

describe('Secure Device Enrollment & Management (Milestone 3)', () => {
  it('generates an enrollment token and successfully enrolls a new Windows desktop agent', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });

    // 1. Family owner generates enrollment token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrollment-tokens',
      payload: {
        organizationId: 'org-family-alpha',
        deviceKind: 'DESKTOP_AGENT',
        expiresInHours: 24,
      },
    });
    assert.equal(tokenRes.statusCode, 201);
    const { token, expiresAt } = tokenRes.json();
    assert.ok(token.startsWith('dp_enroll_'));
    assert.ok(expiresAt);

    // 2. Desktop agent consumes the token to enroll
    const deviceId = '11112222-3333-4444-5555-666677778888';
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enroll',
      payload: {
        token,
        deviceId,
        name: "Alice's Living Room PC",
        platform: 'Windows 11 Pro',
        agentVersion: '0.2.0',
      },
    });
    assert.equal(enrollRes.statusCode, 201);
    const enrollData = enrollRes.json();
    assert.equal(enrollData.success, true);
    assert.equal(enrollData.deviceId, deviceId);
    assert.ok(enrollData.deviceSecret.startsWith('dp_sec_'));

    // 3. Re-using the same token fails (one-time consumption)
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enroll',
      payload: {
        token,
        deviceId: '99998888-7777-6666-5555-444433332222',
        name: 'Intruder PC',
      },
    });
    assert.equal(reuseRes.statusCode, 409);
  });

  it('records device heartbeats and enforces revocation', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });

    const deviceId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    // 1. Send heartbeat
    const beatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      payload: { agentVersion: '0.2.0', metrics: { ramMb: 6.54, cpuPercent: 0.26 } },
    });
    assert.equal(beatRes.statusCode, 200);
    assert.equal(beatRes.json().status, 'healthy');

    // 2. Family owner revokes the device
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/revoke`,
    });
    assert.equal(revokeRes.statusCode, 200);
    assert.equal(revokeRes.json().status, 'revoked');

    // 3. Subsequent heartbeat is rejected with 403 Forbidden
    const blockedBeat = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      payload: { agentVersion: '0.2.0' },
    });
    assert.equal(blockedBeat.statusCode, 403);
    assert.match(blockedBeat.json().error.message, /revoked/i);
  });
});
