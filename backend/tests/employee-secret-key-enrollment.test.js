import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceService, checkSecretKeyThrottling, recordFailedSecretKeyAttempt, clearSecretKeyThrottling } from '../src/modules/devices/devices.service.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

function fakePrisma() {
  const tokens = [];
  const devices = [];
  const auditLogs = [];
  const users = [
    { id: 'emp-user-1', organizationId: 'org-1', email: 'emp1@corp.test', role: 'EMPLOYEE' },
    { id: 'emp-user-3', organizationId: 'org-1', email: 'emp3@corp.test', role: 'EMPLOYEE' },
    { id: 'emp-user-2', organizationId: 'org-2', email: 'emp2@other.test', role: 'EMPLOYEE' },
    { id: 'admin-user-1', organizationId: 'org-1', email: 'admin1@corp.test', role: 'ADMIN' },
  ];

  const client = {
    __state: { tokens, devices, auditLogs, users },
    user: {
      findFirst: async ({ where }) => users.find((u) => u.id === where.id && (!where.organizationId || u.organizationId === where.organizationId)) || null,
      findUnique: async ({ where }) => users.find((u) => u.id === where.id) || null,
      updateMany: async () => ({ count: 1 }),
    },
    deviceEnrollmentToken: {
      create: async ({ data }) => {
        tokens.push({ ...data, usedAt: null, revokedAt: null, createdAt: new Date() });
        return data;
      },
      findUnique: async ({ where }) => tokens.find((t) => t.tokenHash === where.tokenHash) || null,
      findFirst: async ({ where }) => tokens.find((t) => t.id === where.id && (!where.organizationId || t.organizationId === where.organizationId)) || null,
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const t of tokens) {
          const matchId = !where.id || t.id === where.id;
          const matchHash = !where.tokenHash || t.tokenHash === where.tokenHash;
          const matchUsed = where.usedAt === null ? t.usedAt === null : true;
          const matchRevoked = where.revokedAt === null ? t.revokedAt === null : true;
          const matchExpires = where.expiresAt?.gt ? t.expiresAt > where.expiresAt.gt : true;
          if (matchId && matchHash && matchUsed && matchRevoked && matchExpires) {
            Object.assign(t, data);
            count++;
          }
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const t = tokens.find((tok) => tok.tokenHash === where.tokenHash || tok.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    device: {
      create: async ({ data }) => {
        devices.push({ ...data, createdAt: new Date() });
        return data;
      },
      findUnique: async ({ where }) => devices.find((d) => d.id === where.id) || null,
      update: async ({ where, data }) => {
        const d = devices.find((dev) => dev.id === where.id);
        if (d) Object.assign(d, data);
        return d;
      },
      findMany: async () => devices,
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push({ ...data, createdAt: new Date() });
        return data;
      },
    },
    $transaction: async (fn) => (typeof fn === 'function' ? fn(client) : Promise.all(fn)),
  };
  return client;
}

describe('Mandatory Employee Secret Key & Brute-Force Rate Limiting', () => {
  it('issues an employee secret key securely bound to employee and organization', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1',
      userId: 'emp-user-1',
      deviceKind: 'DESKTOP_AGENT',
      expiresInHours: 24,
      createdByUserId: 'admin-user-1',
    });

    assert.ok(issued.secretKey, 'Issued key contains secretKey field');
    assert.ok(issued.secretKey.startsWith('dp_enroll_'), 'Secret key has standard prefix');
    assert.equal(issued.tokenId, prisma.__state.tokens[0].id);
    assert.equal(prisma.__state.tokens[0].userId, 'emp-user-1');
    assert.equal(prisma.__state.tokens[0].organizationId, 'org-1');
    // Ensure raw key is NOT stored in token record; only tokenHash
    assert.ok(prisma.__state.tokens[0].tokenHash);
    assert.equal(prisma.__state.tokens[0].token, undefined);
  });

  it('rejects enrollment if secret key is missing', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    await assert.rejects(
      service.enrollDevice({ deviceId: 'dev-1' }),
      { statusCode: 400, message: /secret key is required/i },
    );
  });

  it('rejects invalid or unknown employee secret key', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    await assert.rejects(
      service.enrollDevice({ secretKey: 'invalid-secret-key-12345', deviceId: 'dev-1' }),
      { statusCode: 401, message: /invalid or unknown/i },
    );
  });

  it('rejects revoked employee secret key', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1',
      userId: 'emp-user-1',
      createdByUserId: 'admin-user-1',
    });

    await service.revokeEnrollmentToken(issued.tokenId, 'org-1');

    await assert.rejects(
      service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'dev-1' }),
      { statusCode: 403, message: /revoked/i },
    );
  });

  it('rejects expired employee secret key', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1',
      userId: 'emp-user-1',
      expiresInHours: 1,
      createdByUserId: 'admin-user-1',
    });

    // Artificially expire the token
    prisma.__state.tokens[0].expiresAt = new Date(Date.now() - 5000);

    await assert.rejects(
      service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'dev-1' }),
      { statusCode: 410, message: /expired/i },
    );
  });

  it('rejects already consumed employee secret key', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1',
      userId: 'emp-user-1',
      createdByUserId: 'admin-user-1',
    });

    const enrolled = await service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'dev-1' });
    assert.equal(enrolled.success, true);
    assert.equal(enrolled.assignedUserId, 'emp-user-1');

    // Replay attempt must be rejected
    await assert.rejects(
      service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'dev-2' }),
      { statusCode: 409, message: /already been consumed/i },
    );
  });

  it('enforces brute-force lockout after 5 failed secret key attempts (HTTP 429)', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const testIp = '192.0.2.42';

    clearSecretKeyThrottling(testIp);

    // 4 failed attempts should fail with 401
    for (let i = 1; i <= 4; i++) {
      await assert.rejects(
        service.enrollDevice({ secretKey: `wrong-key-${i}`, deviceId: 'dev-brute', clientIp: testIp }),
        { statusCode: 401 },
      );
    }

    // 5th failed attempt should also fail with 401 and trigger lockout
    await assert.rejects(
      service.enrollDevice({ secretKey: 'wrong-key-5', deviceId: 'dev-brute', clientIp: testIp }),
      { statusCode: 401 },
    );

    // 6th attempt (even with valid key) must now be locked out with HTTP 429
    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1',
      userId: 'emp-user-1',
      createdByUserId: 'admin-user-1',
    });

    await assert.rejects(
      service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'dev-brute', clientIp: testIp }),
      { statusCode: 429, message: /too many failed enrollment attempts/i },
    );

    // Clearing throttling restores access
    clearSecretKeyThrottling(testIp);
    const successful = await service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'dev-brute', clientIp: testIp });
    assert.equal(successful.success, true);
    assert.equal(successful.assignedUserId, 'emp-user-1');
  });

  it('successfully binds device to employee and organization upon valid enrollment', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);

    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1',
      userId: 'emp-user-1',
      createdByUserId: 'admin-user-1',
    });

    const enrolled = await service.enrollDevice({
      secretKey: issued.secretKey,
      deviceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Employee Laptop',
      platform: 'Windows 11',
    });

    assert.equal(enrolled.success, true);
    assert.equal(enrolled.organizationId, 'org-1');
    assert.equal(enrolled.assignedUserId, 'emp-user-1');
    assert.ok(enrolled.deviceSecret.startsWith('dp_sec_'));

    const storedDevice = prisma.__state.devices[0];
    assert.equal(storedDevice.id, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.equal(storedDevice.userId, 'emp-user-1');
    assert.equal(storedDevice.organizationId, 'org-1');
    assert.ok(storedDevice.secretHash, 'Secret hash exists');
    assert.ok(storedDevice.secretSalt, 'Secret salt exists');
    // Verify plaintext secret is NOT stored in the database
    assert.notEqual(storedDevice.secretHash, enrolled.deviceSecret);
  });

  it('atomically rejects a key issued to another employee or organization', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const sameOrgOtherEmployee = await service.issueEmployeeSecretKey({
      organizationId: 'org-1', userId: 'emp-user-3', createdByUserId: 'admin-user-1',
    });
    await assert.rejects(service.enrollDevice({
      secretKey: sameOrgOtherEmployee.secretKey,
      deviceId: 'identity-mismatch-1',
      authenticatedUserId: 'emp-user-1',
      authenticatedOrganizationId: 'org-1',
    }), { statusCode: 403, code: 'SECRET_KEY_IDENTITY_MISMATCH' });
    assert.equal(prisma.__state.tokens[0].usedAt, null);
    assert.equal(prisma.__state.devices.length, 0);

    const otherOrganization = await service.issueEmployeeSecretKey({
      organizationId: 'org-2', userId: 'emp-user-2', createdByUserId: 'admin-user-1',
    });
    await assert.rejects(service.enrollDevice({
      secretKey: otherOrganization.secretKey,
      deviceId: 'identity-mismatch-2',
      authenticatedUserId: 'emp-user-1',
      authenticatedOrganizationId: 'org-1',
    }), { statusCode: 403, code: 'SECRET_KEY_IDENTITY_MISMATCH' });
    assert.equal(prisma.__state.tokens[1].usedAt, null);
    assert.equal(prisma.__state.devices.length, 0);
  });

  it('allows only one concurrent authenticated enrollment with a one-time key', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1', userId: 'emp-user-1', createdByUserId: 'admin-user-1',
    });
    const attempts = await Promise.allSettled([
      service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'concurrent-1', authenticatedUserId: 'emp-user-1', authenticatedOrganizationId: 'org-1' }),
      service.enrollDevice({ secretKey: issued.secretKey, deviceId: 'concurrent-2', authenticatedUserId: 'emp-user-1', authenticatedOrganizationId: 'org-1' }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    assert.equal(prisma.__state.devices.length, 1);
  });

  it('verifies subsequent sign-in against employee assignment and live revocation state', async () => {
    const prisma = fakePrisma();
    const service = new DeviceService(prisma);
    const issued = await service.issueEmployeeSecretKey({
      organizationId: 'org-1', userId: 'emp-user-1', createdByUserId: 'admin-user-1',
    });
    const enrolled = await service.enrollDevice({
      secretKey: issued.secretKey,
      deviceId: 'existing-device',
      authenticatedUserId: 'emp-user-1',
      authenticatedOrganizationId: 'org-1',
    });
    const verified = await service.verifyEmployeeDevice({
      deviceId: 'existing-device', deviceSecret: enrolled.deviceSecret, userId: 'emp-user-1', organizationId: 'org-1',
    });
    assert.equal(verified.success, true);
    assert.equal(verified.monitoringStarted, false);
    await assert.rejects(service.verifyEmployeeDevice({
      deviceId: 'existing-device', deviceSecret: enrolled.deviceSecret, userId: 'emp-user-3', organizationId: 'org-1',
    }), { statusCode: 403, code: 'DEVICE_ASSIGNMENT_MISMATCH' });
    prisma.__state.devices[0].isRevoked = true;
    await assert.rejects(service.verifyEmployeeDevice({
      deviceId: 'existing-device', deviceSecret: enrolled.deviceSecret, userId: 'emp-user-1', organizationId: 'org-1',
    }), { statusCode: 403, code: 'DEVICE_REVOKED' });
  });

  it('HTTP route: issues secret key via POST /api/v1/devices/issue-secret-key and enrolls via POST /api/v1/devices/enroll', async () => {
    const prisma = fakePrisma();
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' }),
      prisma,
      logger: false,
    });

    const adminSession = await app.authService.createTestSession({
      role: 'ADMIN',
      organizationId: 'org-1',
    });
    const employeeSession = await app.authService.createTestSession({
      userId: 'emp-user-1',
      email: 'emp1@corp.test',
      role: 'EMPLOYEE',
      organizationId: 'org-1',
    });

    // Employee cannot issue secret keys (403 Forbidden)
    const empRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/issue-secret-key',
      headers: employeeSession.headers,
      payload: { userId: 'emp-user-1' },
    });
    assert.equal(empRes.statusCode, 403);

    // Admin issues secret key for emp-user-1
    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/issue-secret-key',
      headers: adminSession.headers,
      payload: { userId: 'emp-user-1', expiresInHours: 12 },
    });
    assert.equal(adminRes.statusCode, 201);
    const body = adminRes.json();
    assert.equal(body.success, true);
    assert.ok(body.secretKey);
    assert.ok(body.tokenId);

    // Device enrolls using secretKey
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enroll',
      payload: {
        secretKey: body.secretKey,
        deviceId: '55555555-5555-4000-8000-555555555555',
        name: 'Windows Desktop Client',
      },
    });
    assert.equal(enrollRes.statusCode, 201);
    const enrollBody = enrollRes.json();
    assert.equal(enrollBody.success, true);
    assert.equal(enrollBody.assignedUserId, 'emp-user-1');
    assert.equal(enrollBody.organizationId, 'org-1');
    assert.ok(enrollBody.deviceSecret);

    // Authenticated combined flow binds the key to the session employee, then
    // validates the same live device without requiring another one-time key.
    const combinedKeyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/issue-secret-key',
      headers: adminSession.headers,
      payload: { userId: 'emp-user-1', expiresInHours: 12 },
    });
    const combinedKey = combinedKeyRes.json().secretKey;
    const combinedEnroll = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/employee-sign-in',
      headers: employeeSession.headers,
      payload: { secretKey: combinedKey, deviceId: 'employee-combined-device', name: 'Employee PC' },
    });
    assert.equal(combinedEnroll.statusCode, 201);
    assert.equal(combinedEnroll.json().assignedUserId, 'emp-user-1');
    assert.equal(combinedEnroll.json().monitoringStarted, false);
    const subsequent = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/employee-sign-in',
      headers: employeeSession.headers,
      payload: { deviceId: 'employee-combined-device', deviceSecret: combinedEnroll.json().deviceSecret },
    });
    assert.equal(subsequent.statusCode, 200);
    assert.equal(subsequent.json().success, true);
    assert.equal(subsequent.json().monitoringStarted, false);

    await app.close();
  });
});
