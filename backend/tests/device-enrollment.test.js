import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { DeviceService } from '../src/modules/devices/devices.service.js';

function fakePrisma() {
  const devices = [];
  const tokens = [];
  const auditLogs = [];

  const prisma = {
    deviceEnrollmentToken: {
      create: async ({ data }) => {
        tokens.push(data);
        return data;
      },
      findUnique: async ({ where }) => tokens.find((t) => t.tokenHash === where.tokenHash) || null,
      updateMany: async ({ where, data }) => {
        const token = tokens.find((item) => item.tokenHash === where.tokenHash && !item.usedAt && !item.revokedAt && item.expiresAt > where.expiresAt.gt);
        if (token) Object.assign(token, data);
        return { count: token ? 1 : 0 };
      },
      update: async ({ where, data }) => {
        const t = tokens.find((item) => item.token === where.token);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    device: {
      create: async ({ data }) => {
        if (devices.some((device) => device.id === data.id)) throw new Error('duplicate device identity');
        const created = { ...data };
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
  prisma.$transaction = async (callback) => callback(prisma);
  prisma.__state = { devices, tokens, auditLogs };
  return prisma;
}

describe('Secure Device Enrollment & Management (Milestone 3)', () => {
  it('never uses in-memory device credentials as a production fallback', async () => {
    const localService = new DeviceService({});
    const testDevice = await localService.createTestDevice({ deviceId: `memory-only-${Date.now()}`, organizationId: 'org-memory-test' });
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const unavailable = await new DeviceService({ device: { findUnique: async () => { throw new Error('database unavailable'); } } })
        .validateDeviceCredentials(testDevice.deviceId, testDevice.deviceSecret);
      assert.equal(unavailable.valid, false);
      assert.equal(unavailable.code, 'STORAGE_UNAVAILABLE');

      const missing = await new DeviceService({ device: { findUnique: async () => null } })
        .validateDeviceCredentials(testDevice.deviceId, testDevice.deviceSecret);
      assert.equal(missing.valid, false);
      assert.equal(missing.code, 'DEVICE_NOT_FOUND');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('lets an authenticated employee create a four-hour token only for their own organization and records connection after heartbeat', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });
    const employee = await app.authService.createTestSession({
      userId: 'employee-setup-1', role: 'EMPLOYEE', organizationId: 'org-employee-one',
    });
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/my-enrollment-token',
      headers: employee.headers,
      payload: { deviceKind: 'DESKTOP_AGENT', userId: 'another-user', expiresInHours: 999 },
    });
    assert.equal(tokenResponse.statusCode, 201, JSON.stringify(tokenResponse.json()));
    const { token, expiresAt } = tokenResponse.json();
    assert.ok(token.startsWith('dp_enroll_'));
    assert.ok(new Date(expiresAt).getTime() - Date.now() <= 4 * 60 * 60 * 1000);
    assert.equal(prisma.__state.tokens[0].userId, 'employee-setup-1');
    assert.equal(prisma.__state.tokens[0].organizationId, 'org-employee-one');
    assert.equal(prisma.__state.tokens[0].token, undefined);

    const deniedKind = await app.inject({
      method: 'POST', url: '/api/v1/devices/my-enrollment-token', headers: employee.headers,
      payload: { deviceKind: 'ADMIN' },
    });
    assert.equal(deniedKind.statusCode, 400);

    const deviceId = '11112222-3333-4444-5555-666677778889';
    const enrolled = await app.inject({ method: 'POST', url: '/api/v1/devices/enroll', payload: { token, deviceId } });
    assert.equal(enrolled.statusCode, 201);
    assert.equal(enrolled.json().deviceSecret.startsWith('dp_sec_'), true);
    assert.equal(prisma.__state.devices[0].lastSeenAt, null, 'registration is not a heartbeat');
    assert.equal(prisma.__state.devices[0].secretHash.includes(enrolled.json().deviceSecret), false);

    const beforeHeartbeat = await app.deviceService.listDevices('org-employee-one', 'employee-setup-1');
    assert.equal(beforeHeartbeat[0].status, 'offline');
    const heartbeat = await app.inject({
      method: 'POST', url: `/api/v1/devices/${deviceId}/heartbeat`,
      headers: { 'x-device-secret': enrolled.json().deviceSecret }, payload: { agentVersion: '0.1.0' },
    });
    assert.equal(heartbeat.statusCode, 200);
    assert.equal(heartbeat.json().status, 'healthy');
    const afterHeartbeat = await app.deviceService.listDevices('org-employee-one', 'employee-setup-1');
    assert.equal(afterHeartbeat[0].status, 'online');

    const manager = await app.authService.createTestSession({ role: 'MANAGER', organizationId: 'org-employee-one' });
    const deniedManager = await app.inject({
      method: 'POST', url: '/api/v1/devices/my-enrollment-token', headers: manager.headers,
      payload: { deviceKind: 'DESKTOP_AGENT' },
    });
    assert.equal(deniedManager.statusCode, 403);

    const superAdmin = await app.authService.createTestSession({ role: 'SUPER_ADMIN', organizationId: 'org-employee-one' });
    const deniedSuperAdmin = await app.inject({
      method: 'POST', url: '/api/v1/devices/my-enrollment-token', headers: superAdmin.headers,
      payload: { deviceKind: 'DESKTOP_AGENT' },
    });
    assert.equal(deniedSuperAdmin.statusCode, 403);
    await app.close();
  });

  it('generates an enrollment token and successfully enrolls a new Windows desktop agent', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const prisma = fakePrisma();
    const app = await buildApp({ config, prisma, logger: false });
    const auth = await app.authService.createTestSession({ organizationId: 'org-family-alpha' });

    // 1. Family owner generates enrollment token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrollment-tokens',
      headers: auth.headers,
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
    assert.equal(prisma.__state.tokens[0].token, undefined, 'raw enrollment token must not be persisted');
    assert.match(prisma.__state.tokens[0].tokenHash, /^[a-f0-9]{64}$/);

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
    assert.equal(enrollRes.statusCode, 201, JSON.stringify(enrollRes.json()));
    const enrollData = enrollRes.json();
    assert.equal(enrollData.success, true);
    assert.equal(enrollData.deviceId, deviceId);
    assert.ok(enrollData.deviceSecret.startsWith('dp_sec_'));
    assert.ok(prisma.__state.tokens[0].usedAt);
    assert.equal(prisma.__state.devices.length, 1);

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
    const auth = await app.authService.createTestSession({ organizationId: 'org-family-alpha' });

    const deviceId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const testDev = await app.deviceService.createTestDevice({ deviceId, organizationId: 'org-family-alpha' });

    // 1. Send heartbeat
    const beatRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      headers: testDev.headers,
      payload: { agentVersion: '0.2.0', metrics: { ramMb: 6.54, cpuPercent: 0.26 } },
    });
    assert.equal(beatRes.statusCode, 200);
    assert.equal(beatRes.json().status, 'healthy');

    // 2. Family owner revokes the device
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/revoke`,
      headers: auth.headers,
    });
    assert.equal(revokeRes.statusCode, 200);
    assert.equal(revokeRes.json().status, 'revoked');

    // 3. Subsequent heartbeat is rejected with 403 Forbidden
    const blockedBeat = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${deviceId}/heartbeat`,
      headers: testDev.headers,
      payload: { agentVersion: '0.2.0' },
    });
    assert.equal(blockedBeat.statusCode, 403);
    assert.match(blockedBeat.json().error.message, /revoked/i);
  });
});

