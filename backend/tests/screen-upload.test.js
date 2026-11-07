import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { hashDeviceSecret } from '../src/modules/devices/devices.service.js';
import { createScreenshotStore, resetScreenshotStoreForTests } from '../src/modules/screen/screen-storage.js';

test('authenticated screenshot upload persists, deduplicates, enforces revocation and serves private images', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dp-screen-upload-'));
  const envKeys = ['SCREENSHOT_STORAGE_PROVIDER', 'SCREENSHOT_STORAGE_DIR', 'SCREENSHOT_ENCRYPTION_KEY'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.SCREENSHOT_STORAGE_PROVIDER = 'local';
  process.env.SCREENSHOT_STORAGE_DIR = directory;
  process.env.SCREENSHOT_ENCRYPTION_KEY = 'test-only-screenshot-key-at-least-32-characters';
  resetScreenshotStoreForTests();
  t.after(async () => {
    resetScreenshotStoreForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const secret = 'dp_sec_test_upload_secret_123456789';
  const credentials = hashDeviceSecret(secret);
  const device = { id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-test', userId: 'employee-test', kind: 'DESKTOP_AGENT', isRevoked: false, screenCaptureEnabled: true, secretHash: credentials.hash, secretSalt: credentials.salt };
  const owner = { id: device.userId, organizationId: device.organizationId, employmentStatus: 'active', monitoringAuthorized: true, monitoringConsentAt: new Date('2020-01-01'), screenMonitoringAcknowledgedAt: new Date('2020-01-01'), workingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], shiftStart: '00:00', shiftEnd: '23:59', organization: { timezone: 'UTC' } };
  const setting = { enabled: true, captureIntervalSeconds: 300, retentionDays: 30, workingDays: owner.workingDays, shiftStart: '00:00', shiftEnd: '23:59', excludedApplications: ['private.exe'] };
  const rows = [];
  const prisma = {
    device: { findUnique: async ({ where }) => where.id === device.id ? device : null,
      updateMany: async () => { throw new Error('Injected status-cache failure'); } },
    user: { findUnique: async () => owner },
    screenMonitoringSetting: { findUnique: async () => setting },
    screenCaptureMetadata: {
      findUnique: async ({ where }) => rows.find(row => row.captureKey === where.deviceId_captureKey.captureKey) || null,
      create: async ({ data }) => { rows.push(data); return data; },
      findFirst: async ({ where }) => rows.find(row => row.id === where.id && row.organizationId === where.organizationId) || null,
      findMany: async () => rows, count: async () => rows.length,
    },
    auditLog: { create: async ({ data }) => data },
  };
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: 'postgresql://test:test@localhost:5433/test' }), prisma, logger: false });
  t.after(() => app.close());
  // Test fixture bytes exercise transport/storage; not a captured employee image.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==', 'base64');
  const headers = { 'content-type': 'image/jpeg', 'x-device-secret': secret, 'x-capture-key': 'test_capture_123456789', 'x-captured-at': new Date().toISOString(), 'x-image-width': '1', 'x-image-height': '1', 'x-application-name': 'Code.exe' };
  const upload = (extraHeaders = {}, payload = jpeg) => app.inject({ method: 'POST', url: `/api/v1/screen-monitoring/captures?deviceId=${device.id}`, headers: { ...headers, ...extraHeaders }, payload });
  const saved = await upload();
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(rows.length, 1);
  assert.deepEqual(await createScreenshotStore().get(rows[0].storageKey), jpeg, 'status update failure must not delete saved image');
  assert.equal((await upload()).json().deduplicated, true);
  assert.equal(rows.length, 1);
  assert.equal((await upload({ 'x-capture-key': 'test_capture_invalid_123' }, Buffer.from('invalid'))).statusCode, 400);
  assert.equal((await upload({ 'x-image-width': '1920' })).statusCode, 400);
  assert.equal((await upload({}, Buffer.alloc(5 * 1024 * 1024 + 1))).statusCode, 413);
  assert.equal((await upload({ 'x-device-secret': 'wrong' })).statusCode, 401);
  assert.equal((await upload({ 'x-capture-key': 'test_capture_excluded_123', 'x-application-name': 'private.exe' })).statusCode, 403);
  owner.monitoringConsentRevokedAt = new Date();
  assert.equal((await upload()).statusCode, 403, 'even duplicate uploads must revalidate current consent');
  owner.monitoringConsentRevokedAt = null;
  device.isRevoked = true;
  assert.equal((await upload()).statusCode, 403);
  device.isRevoked = false;
  const admin = await app.authService.createTestSession({ userId: 'admin-test', organizationId: device.organizationId, role: 'ADMIN', email: 'admin@example.test' });
  const gallery = await app.inject({ method: 'GET', url: '/api/v1/screen-monitoring/captures', headers: admin.headers });
  assert.equal(gallery.statusCode, 200, gallery.body);
  const imageUrl = gallery.json().captures[0].imageUrl;
  assert.equal((await app.inject({ method: 'GET', url: imageUrl })).statusCode, 401);
  const image = await app.inject({ method: 'GET', url: imageUrl, headers: admin.headers });
  assert.equal(image.statusCode, 200, image.body);
  assert.deepEqual(image.rawPayload, jpeg);
});
