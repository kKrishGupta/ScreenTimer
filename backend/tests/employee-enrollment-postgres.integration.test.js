import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig, resolveDatabaseUrl } from '../src/shared/config.js';
import { createPrismaClient } from '../src/database/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

const skip = !process.env.TEST_DATABASE_URL
  ? 'TEST_DATABASE_URL not set: enrollment lifecycle requires a separate migrated PostgreSQL database'
  : process.env.RUN_INTEGRATION_TESTS !== 'true' ? 'Set RUN_INTEGRATION_TESTS=true to run the isolated PostgreSQL lifecycle' : false;

test('PostgreSQL self-enrollment persists identity, consumes tokens once, gates monitoring, and enforces revocation', { skip }, async (t) => {
  const target = (value) => {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}${decodeURIComponent(url.pathname).replace(/\/+$/, '')}`;
  };
  const appUrl = resolveDatabaseUrl(process.env);
  if (appUrl) assert.notEqual(target(process.env.TEST_DATABASE_URL), target(appUrl), 'Use a separate test database, never the application database');
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, LOG_LEVEL: 'silent' });
  const prisma = createPrismaClient(config);
  const app = await buildApp({ config, prisma, logger: false });
  let orgId;
  t.after(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
    await app.close();
    await prisma.$disconnect();
  });
  const org = await prisma.organization.create({ data: { name: 'Enrollment integration', slug: `enroll-it-${crypto.randomUUID()}`, timezone: 'UTC' } });
  orgId = org.id;
  const password = 'OnlyAnIsolatedTestPassword123!';
  const credential = hashPassword(password);
  const owner = await prisma.user.create({ data: {
    organizationId: orgId, email: `employee-${crypto.randomUUID()}@example.test`, displayName: 'Enrollment Test Employee', role: 'EMPLOYEE',
    passwordHash: credential.hash, passwordSalt: credential.salt, monitoringAuthorized: false,
    shiftStart: '00:00', shiftEnd: '23:59', workingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
  } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: owner.email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { cookie: login.headers['set-cookie'].split(';')[0], origin: config.corsOrigins[0] };
  const createToken = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/devices/my-enrollment-token', headers,
      payload: { deviceKind: 'BROWSER_EXTENSION', organizationId: crypto.randomUUID(), userId: crypto.randomUUID() } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const issued = await createToken();
  const tokenHash = crypto.createHash('sha256').update(issued.token).digest('hex');
  const row = await prisma.deviceEnrollmentToken.findUnique({ where: { tokenHash } });
  assert.equal(row.userId, owner.id);
  assert.equal(row.organizationId, orgId);
  assert.equal(row.token, null);
  assert.ok(Math.abs(row.expiresAt.getTime() - Date.now() - 4 * 3600000) < 15000);
  const deviceId = crypto.randomUUID();
  const enroll = () => app.inject({ method: 'POST', url: '/api/v1/devices/enroll', payload: { token: issued.token, deviceId, name: 'Chrome integration', browser: 'chrome' } });
  const responses = await Promise.all([enroll(), enroll()]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  const secret = responses.find((response) => response.statusCode === 201).json().deviceSecret;
  assert.equal(await prisma.device.count({ where: { id: deviceId } }), 1);
  assert.equal((await prisma.device.findUnique({ where: { id: deviceId } })).lastSeenAt, null);
  const heartbeat = () => app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/heartbeat`, headers: { 'x-device-secret': secret }, payload: {} });
  const connected = await heartbeat();
  assert.equal(connected.statusCode, 200);
  assert.equal(connected.json().monitoring.allowed, false);
  assert.ok((await prisma.device.findUnique({ where: { id: deviceId } })).lastSeenAt);
  const consent = await app.inject({ method: 'POST', url: '/api/v1/devices/my-monitoring-consent', headers, payload: { consent: true } });
  assert.equal(consent.statusCode, 200);
  assert.equal((await heartbeat()).json().monitoring.reason, 'ADMIN_AUTHORIZATION_REQUIRED');
  const directory = await app.inject({ method: 'GET', url: '/api/v1/devices', headers });
  assert.equal(directory.statusCode, 200);
  assert.equal(directory.json().devices[0].status, 'online');
  assert.doesNotMatch(directory.body, /dp_sec_|secretHash|secretSalt|tokenHash/);
  await prisma.device.update({ where: { id: deviceId }, data: { isRevoked: true, revokedAt: new Date() } });
  assert.equal((await heartbeat()).statusCode, 403);
  const expired = await createToken();
  await prisma.deviceEnrollmentToken.update({ where: { tokenHash: crypto.createHash('sha256').update(expired.token).digest('hex') }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const reject = await app.inject({ method: 'POST', url: '/api/v1/devices/enroll', payload: { token: expired.token, deviceId: crypto.randomUUID() } });
  assert.equal(reject.statusCode, 410);
});
