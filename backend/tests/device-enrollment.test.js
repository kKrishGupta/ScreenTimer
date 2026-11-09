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
      findFirst: async ({ where }) => tokens.find((t) => t.id === where.id && t.organizationId === where.organizationId) || null,
      updateMany: async ({ where, data }) => {
        const token = tokens.find((item) => {
          if (where.id) return item.id === where.id && item.expiryRecordedAt == null;
          return item.tokenHash === where.tokenHash && !item.usedAt && !item.revokedAt && item.expiresAt > where.expiresAt.gt;
        });
        if (token) Object.assign(token, data);
        return { count: token ? 1 : 0 };
      },
      update: async ({ where, data }) => {
        const t = tokens.find((item) => (where.id && item.id === where.id) || (where.tokenHash && item.tokenHash === where.tokenHash) || (where.token && item.token === where.token));
        if (t) Object.assign(t, data);
        return t;
      },
      findMany: async ({ where }) => tokens.filter((item) => (
        item.organizationId === where.organizationId &&
        (!where.userId || item.userId === where.userId) &&
        !item.usedAt && !item.revokedAt && item.expiresAt > where.expiresAt.gt
      )),
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
    const managerEnrollment = await app.inject({
      method: 'POST', url: '/api/v1/devices/my-enrollment-token', headers: manager.headers,
      payload: { deviceKind: 'DESKTOP_AGENT' },
    });
    assert.equal(managerEnrollment.statusCode, 201, managerEnrollment.body);

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

  it('rejects using a Windows-agent token in a browser extension', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const issued = await service.createEnrollmentToken({ organizationId: 'org-kind-check', deviceKind: 'DESKTOP_AGENT' });
    await assert.rejects(
      service.enrollDevice({ token: issued.token, deviceId: '11112222-3333-4444-5555-666677778800', browser: 'chrome' }),
      /token is for a Windows agent/i,
    );
    assert.equal(Boolean(prisma.__state.tokens[0].usedAt), false);
    assert.equal(prisma.__state.devices.length, 0);
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

  it('records token accountability and rejects revoked and expired enrollment tokens', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const issued = await service.createEnrollmentToken({
      organizationId: 'org-token-lifecycle',
      deviceKind: 'DESKTOP_AGENT',
      expiresInHours: 2,
      createdByUserId: 'admin-token-creator',
    });
    assert.equal(prisma.__state.tokens[0].createdByUserId, 'admin-token-creator');
    assert.equal(prisma.__state.tokens[0].maxUses, 1);
    assert.equal(prisma.__state.tokens[0].useCount, 0);
    assert.equal(prisma.__state.auditLogs[0].action, 'ENROLLMENT_TOKEN_CREATED');

    await service.revokeEnrollmentToken(issued.tokenId, 'org-token-lifecycle', 'admin@example.test', 'admin-token-creator');
    await assert.rejects(
      service.enrollDevice({ token: issued.token, deviceId: '10000000-0000-4000-8000-000000000001' }),
      /revoked/i,
    );
    assert.equal(prisma.__state.auditLogs.at(-1).action, 'ENROLLMENT_TOKEN_REVOKED');

    const expired = await service.createEnrollmentToken({ organizationId: 'org-token-lifecycle', expiresInHours: 1 });
    prisma.__state.tokens.at(-1).expiresAt = new Date(Date.now() - 1000);
    await assert.rejects(
      service.enrollDevice({ token: expired.token, deviceId: '10000000-0000-4000-8000-000000000002' }),
      /expired/i,
    );
    assert.equal(prisma.__state.auditLogs.at(-1).action, 'ENROLLMENT_TOKEN_EXPIRED');
  });

  it('reconnects the same stable identity without creating a duplicate and rotates only that credential', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const identity = {
      organizationId: 'org-stable-identity',
      userId: 'employee-stable-identity',
      deviceKind: 'BROWSER_EXTENSION',
      expiresInHours: 4,
    };
    const deviceId = '20000000-0000-4000-8000-000000000001';
    const firstToken = await service.createEnrollmentToken(identity);
    const first = await service.enrollDevice({ token: firstToken.token, deviceId, browser: 'chrome', name: 'Work Chrome' });
    const secondToken = await service.createEnrollmentToken(identity);
    const second = await service.enrollDevice({ token: secondToken.token, deviceId, browser: 'chrome', name: 'Renamed Work Chrome' });

    assert.equal(second.reconnected, true);
    assert.equal(prisma.__state.devices.length, 1);
    assert.equal(prisma.__state.devices[0].name, 'Renamed Work Chrome');
    assert.equal((await service.validateDeviceCredentials(deviceId, first.deviceSecret)).valid, false);
    assert.equal((await service.validateDeviceCredentials(deviceId, second.deviceSecret)).valid, true);
    assert.ok(prisma.__state.auditLogs.some((entry) => entry.action === 'DEVICE_RECONNECTED'));
    assert.ok(prisma.__state.auditLogs.some((entry) => entry.action === 'DEVICE_SECRET_ROTATED'));
  });

  it('enforces tenant-scoped archival, restoration and permanent revocation without deleting history', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const deviceId = '30000000-0000-4000-8000-000000000001';
    const issued = await service.createEnrollmentToken({ organizationId: 'org-lifecycle-a', expiresInHours: 4 });
    const enrolled = await service.enrollDevice({ token: issued.token, deviceId, name: 'Lifecycle PC' });

    await assert.rejects(service.archiveDevice(deviceId, 'org-lifecycle-b'), /another organization/i);
    await service.archiveDevice(deviceId, 'org-lifecycle-a', 'admin@example.test', 'Old device', 'admin-a');
    assert.equal((await service.validateDeviceCredentials(deviceId, enrolled.deviceSecret)).code, 'DEVICE_ARCHIVED');
    assert.equal((await service.listDevices('org-lifecycle-a')).length, 0);
    assert.equal((await service.listDevices('org-lifecycle-a', null, { includeArchived: true }))[0].lifecycleStatus, 'ARCHIVED');

    await service.restoreDevice(deviceId, 'org-lifecycle-a', 'admin@example.test', 'admin-a');
    assert.equal((await service.validateDeviceCredentials(deviceId, enrolled.deviceSecret)).valid, true, 'restoring an archived device preserves its existing credential');
    await service.revokeDevice(deviceId, 'org-lifecycle-a', 'admin@example.test', 'Employee offboarded', 'admin-a');
    assert.equal(prisma.__state.devices.length, 1, 'lifecycle actions preserve the device and its historical relationships');
    assert.equal(prisma.__state.devices[0].secretHash, null);
    assert.equal((await service.validateDeviceCredentials(deviceId, enrolled.deviceSecret)).code, 'DEVICE_REVOKED');
    await assert.rejects(service.restoreDevice(deviceId, 'org-lifecycle-a'), /revoked credential cannot be restored/i);
    assert.ok(prisma.__state.auditLogs.some((entry) => entry.action === 'DEVICE_ARCHIVED'));
    assert.ok(prisma.__state.auditLogs.some((entry) => entry.action === 'DEVICE_RESTORED'));
    assert.ok(prisma.__state.auditLogs.some((entry) => entry.action === 'DEVICE_REVOKED' && entry.details.reason === 'Employee offboarded'));
  });

  it('enforces administrator RBAC and organization scope on lifecycle HTTP endpoints', async () => {
    const prisma = fakePrisma();
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }), prisma, logger: false });
    const deviceId = '40000000-0000-4000-8000-000000000001';
    const issued = await app.deviceService.createEnrollmentToken({ organizationId: 'org-http-a', expiresInHours: 4 });
    const enrolled = await app.deviceService.enrollDevice({ token: issued.token, deviceId });
    const employee = await app.authService.createTestSession({ role: 'EMPLOYEE', organizationId: 'org-http-a' });
    const otherAdmin = await app.authService.createTestSession({ role: 'ADMIN', organizationId: 'org-http-b' });
    const admin = await app.authService.createTestSession({ role: 'ADMIN', organizationId: 'org-http-a' });

    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/archive`, headers: employee.headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/archive`, headers: otherAdmin.headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/archive`, headers: admin.headers, payload: { reason: 'Replacement device' } })).statusCode, 200);

    const normalList = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: admin.headers });
    assert.equal(normalList.json().devices.length, 0);
    const archivedList = await app.inject({ method: 'GET', url: '/api/v1/devices?includeArchived=true', headers: admin.headers });
    assert.equal(archivedList.json().devices[0].lifecycleStatus, 'ARCHIVED');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/restore`, headers: admin.headers })).statusCode, 200);

    const revoked = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/revoke`, headers: admin.headers, payload: { reason: 'Employee offboarded' } });
    assert.equal(revoked.statusCode, 200, revoked.body);
    const heartbeat = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/heartbeat`, headers: { 'x-device-secret': enrolled.deviceSecret } });
    assert.equal(heartbeat.statusCode, 403);

    const pending = await app.deviceService.createEnrollmentToken({ organizationId: 'org-http-a', expiresInHours: 4 });
    const tokenRevocation = await app.inject({ method: 'POST', url: `/api/v1/devices/enrollment-tokens/${pending.tokenId}/revoke`, headers: admin.headers });
    assert.equal(tokenRevocation.statusCode, 200, tokenRevocation.body);
    await assert.rejects(app.deviceService.enrollDevice({ token: pending.token, deviceId: '40000000-0000-4000-8000-000000000002' }), /revoked/i);
    await app.close();
  });
});

