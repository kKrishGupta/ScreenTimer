import crypto from 'node:crypto';
import { Roles, normalizeRole } from '../auth/auth.service.js';
import { getMonitoringAuthorization } from '../devices/monitoring-authorization.js';
import { createScreenshotStore, createViewToken, screenshotObjectKey, verifyViewToken } from './screen-storage.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SETTING = Object.freeze({ enabled: false, captureIntervalSeconds: 300, retentionDays: 30, workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], shiftStart: '09:00', shiftEnd: '18:00', excludedApplications: [] });

function adminOrganization(request, reply) {
  const role = normalizeRole(request.user?.role);
  if (![Roles.ADMIN, Roles.SUPER_ADMIN].includes(role)) {
    reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Organization administrator access is required' } });
    return null;
  }
  const organizationId = role === Roles.SUPER_ADMIN ? request.query?.organizationId || request.body?.organizationId : request.user.organizationId;
  if (!organizationId) {
    reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization' } });
    return null;
  }
  return organizationId;
}

async function readSetting(prisma, organizationId) {
  const stored = await prisma.screenMonitoringSetting?.findUnique?.({ where: { organizationId } });
  return { ...DEFAULT_SETTING, ...(stored || {}), organizationId };
}

function localScheduleState(setting, timezone, at = new Date()) {
  if (!timezone) return { allowed: false, reason: 'ORGANIZATION_TIMEZONE_REQUIRED' };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = value.weekday;
  const time = `${value.hour}:${value.minute}`;
  const overnight = setting.shiftStart > setting.shiftEnd;
  const previousDay = DAYS[(DAYS.indexOf(day) + 6) % 7];
  const allowed = overnight
    ? (setting.workingDays.includes(day) && time >= setting.shiftStart) || (setting.workingDays.includes(previousDay) && time < setting.shiftEnd)
    : setting.workingDays.includes(day) && time >= setting.shiftStart && time < setting.shiftEnd;
  return { allowed, reason: allowed ? null : 'OUTSIDE_SCREEN_MONITORING_SCHEDULE' };
}

async function evaluateDevicePolicy(prisma, device, at = new Date()) {
  if (!device || device.isRevoked || device.kind !== 'DESKTOP_AGENT') return { allowed: false, reason: 'DEVICE_NOT_ELIGIBLE' };
  if (!device.screenCaptureEnabled) return { allowed: false, reason: 'DEVICE_NOT_SELECTED' };
  if (!device.userId) return { allowed: false, reason: 'DEVICE_OWNER_REQUIRED' };
  const owner = await prisma.user.findUnique({ where: { id: device.userId }, include: { organization: { select: { timezone: true } } } });
  if (!owner || owner.organizationId !== device.organizationId) return { allowed: false, reason: 'DEVICE_OWNER_REQUIRED' };
  const setting = await readSetting(prisma, device.organizationId);
  if (!setting.enabled) return { allowed: false, reason: 'SCREEN_MONITORING_DISABLED', setting, owner };
  if (!owner.screenMonitoringAcknowledgedAt) return { allowed: false, reason: 'SCREEN_NOTICE_NOT_ACKNOWLEDGED', setting, owner };
  const activity = getMonitoringAuthorization(owner, at);
  if (!activity.allowed) return { allowed: false, reason: activity.reason, setting, owner };
  const schedule = localScheduleState(setting, owner.organization?.timezone, at);
  if (!schedule.allowed) return { ...schedule, setting, owner };
  return { allowed: true, reason: null, intervalSeconds: setting.captureIntervalSeconds, retentionDays: setting.retentionDays, excludedApplications: setting.excludedApplications, visibleIndicator: true, allowedUntil: activity.allowedUntil, setting, owner };
}

function validImage(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_IMAGE_BYTES) return false;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  return false;
}

async function audit(prisma, organizationId, action, actor, details) {
  if (prisma.auditLog?.create) await prisma.auditLog.create({ data: { organizationId, action, actor, details } });
}

function mapCapture(row, request) {
  const expires = Date.now() + 5 * 60 * 1000;
  const token = createViewToken(row.id, request.user.id, expires);
  return {
    id: row.id, captureKey: row.captureKey, employeeId: row.employeeId,
    employeeName: row.employee?.displayName || row.device?.user?.displayName || null,
    deviceId: row.deviceId, deviceName: row.device?.name || null, applicationName: row.applicationName,
    mimeType: row.mimeType, sizeBytes: row.sizeBytes, width: row.width, height: row.height,
    status: row.captureStatus, failureCode: row.failureCode, capturedAt: row.capturedAt,
    timestamp: row.capturedAt, expiresAt: row.expiresAt,
    imageUrl: row.captureStatus === 'stored' ? `/api/v1/screen-monitoring/captures/${row.id}/image?expires=${expires}&token=${encodeURIComponent(token)}` : null,
  };
}

export async function runScreenshotRetentionCleanup(prisma, store, log = console) {
  if (!prisma.screenCaptureMetadata?.findMany) return { deleted: 0, failed: 0 };
  const expired = await prisma.screenCaptureMetadata.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true, organizationId: true, storageKey: true }, take: 200 });
  let deleted = 0;
  let failed = 0;
  for (const capture of expired) {
    try {
      if (capture.storageKey) await store.delete(capture.storageKey);
      await prisma.screenCaptureMetadata.delete({ where: { id: capture.id } });
      deleted += 1;
    } catch (error) {
      failed += 1;
      log.error?.({ err: error, captureId: capture.id, organizationId: capture.organizationId }, 'Screenshot retention cleanup failed');
    }
  }
  return { deleted, failed };
}

export default async function screenRoutes(fastify) {
  const prisma = fastify.prisma;
  let store;
  const getStore = () => { store ||= createScreenshotStore(); return store; };
  fastify.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));

  fastify.get('/screen-monitoring/settings', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (organizationId) return { settings: await readSetting(prisma, organizationId) };
  });

  fastify.patch('/screen-monitoring/settings', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const body = request.body || {};
    const interval = Number(body.captureIntervalSeconds);
    const retention = Number(body.retentionDays);
    if (typeof body.enabled !== 'boolean' || !Number.isInteger(interval) || interval < 300 || interval > 3600 || !Number.isInteger(retention) || retention < 1 || retention > 365 || !TIME_RE.test(body.shiftStart || '') || !TIME_RE.test(body.shiftEnd || '') || body.shiftStart === body.shiftEnd || !Array.isArray(body.workingDays) || body.workingDays.length === 0 || body.workingDays.some((day) => !DAYS.includes(day)) || !Array.isArray(body.excludedApplications) || body.excludedApplications.some((name) => typeof name !== 'string' || name.length > 128)) {
      return reply.code(400).send({ error: { code: 'INVALID_SCREEN_POLICY', message: 'Provide a valid interval, retention period, schedule, and exclusion list' } });
    }
    const data = { enabled: body.enabled, captureIntervalSeconds: interval, retentionDays: retention, workingDays: [...new Set(body.workingDays)], shiftStart: body.shiftStart, shiftEnd: body.shiftEnd, excludedApplications: [...new Set(body.excludedApplications.map((value) => value.trim().toLowerCase()).filter(Boolean))], updatedBy: request.user.email };
    const settings = await prisma.screenMonitoringSetting.upsert({ where: { organizationId }, update: data, create: { organizationId, ...data } });
    await audit(prisma, organizationId, 'SCREEN_MONITORING_POLICY_UPDATED', request.user.email, { ...data, excludedApplications: data.excludedApplications.length });
    return { success: true, settings };
  });

  fastify.get('/screen-monitoring/employees', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const devices = await prisma.device.findMany({ where: { organizationId, kind: 'DESKTOP_AGENT', isRevoked: false }, include: { user: { select: { id: true, displayName: true, email: true, screenMonitoringAcknowledgedAt: true } } }, orderBy: { name: 'asc' } });
    const now = Date.now();
    return { employees: devices.map((device) => ({ employeeId: device.user?.id || null, employeeName: device.user?.displayName || 'Unassigned device', email: device.user?.email || null, acknowledgedAt: device.user?.screenMonitoringAcknowledgedAt || null, deviceId: device.id, deviceName: device.name, selected: device.screenCaptureEnabled, connectivity: device.lastSeenAt && now - new Date(device.lastSeenAt).getTime() < 5 * 60 * 1000 ? 'online' : 'offline', lastSeenAt: device.lastSeenAt, lastCaptureAt: device.lastScreenCaptureAt, lastFailureAt: device.lastScreenCaptureFailureAt, lastFailure: device.lastScreenCaptureError })) };
  });

  fastify.patch('/screen-monitoring/devices/:deviceId', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    if (typeof request.body?.enabled !== 'boolean') return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'enabled must be boolean' } });
    const updated = await prisma.device.updateMany({ where: { id: request.params.deviceId, organizationId, kind: 'DESKTOP_AGENT', isRevoked: false, userId: { not: null } }, data: { screenCaptureEnabled: request.body.enabled } });
    if (updated.count !== 1) return reply.code(404).send({ error: { code: 'DEVICE_NOT_FOUND', message: 'Eligible organization device not found' } });
    await audit(prisma, organizationId, 'SCREEN_MONITORING_DEVICE_UPDATED', request.user.email, { deviceId: request.params.deviceId, enabled: request.body.enabled });
    return { success: true };
  });

  fastify.get('/screen-monitoring/me', async (request) => {
    const owner = await prisma.user.findUnique({ where: { id: request.user.id } });
    const setting = await readSetting(prisma, request.user.organizationId);
    return { acknowledgedAt: owner?.screenMonitoringAcknowledgedAt || null, noticeVersion: 'screen-monitoring-v1', organizationEnabled: setting.enabled, captureIntervalSeconds: setting.captureIntervalSeconds, retentionDays: setting.retentionDays, workingDays: setting.workingDays, shiftStart: setting.shiftStart, shiftEnd: setting.shiftEnd, explanation: 'DigitalPulse captures the active Windows work screen only on selected enrolled work devices during authorized hours. Captures are private, access-audited, and automatically deleted after the retention period.' };
  });

  fastify.post('/screen-monitoring/acknowledgement', async (request, reply) => {
    if (![Roles.EMPLOYEE, Roles.ADMIN].includes(normalizeRole(request.user.role))) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'A personal organization account is required' } });
    if (request.body?.acknowledged !== true) return reply.code(400).send({ error: { code: 'ACKNOWLEDGEMENT_REQUIRED', message: 'Explicit acknowledgement is required' } });
    const acknowledgedAt = new Date();
    await prisma.user.updateMany({ where: { id: request.user.id, organizationId: request.user.organizationId }, data: { screenMonitoringAcknowledgedAt: acknowledgedAt } });
    await audit(prisma, request.user.organizationId, 'SCREEN_MONITORING_NOTICE_ACKNOWLEDGED', request.user.email, { version: 'screen-monitoring-v1' });
    return { success: true, acknowledgedAt };
  });

  fastify.get('/screen-monitoring/device-policy', async (request, reply) => {
    if (!request.device || request.device.id !== request.query?.deviceId) return reply.code(403).send({ error: { code: 'DEVICE_SCOPE_MISMATCH', message: 'Device policy may only be read by that device' } });
    const policy = await evaluateDevicePolicy(prisma, request.device);
    return { policy: { allowed: policy.allowed, reason: policy.reason, intervalSeconds: policy.intervalSeconds || DEFAULT_SETTING.captureIntervalSeconds, excludedApplications: policy.excludedApplications || [], visibleIndicator: true, allowedUntil: policy.allowedUntil || null } };
  });

  fastify.post('/screen-monitoring/captures', async (request, reply) => {
    const device = request.device;
    if (!device || device.id !== request.query?.deviceId) return reply.code(403).send({ error: { code: 'DEVICE_SCOPE_MISMATCH', message: 'Capture device does not match authenticated device' } });
    const captureKey = String(request.headers['x-capture-key'] || '');
    const capturedAt = new Date(String(request.headers['x-captured-at'] || ''));
    const width = Number(request.headers['x-image-width']);
    const height = Number(request.headers['x-image-height']);
    const applicationName = String(request.headers['x-application-name'] || 'Active Windows desktop').slice(0, 128);
    const mimeType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(captureKey) || !Number.isFinite(capturedAt.getTime()) || Math.abs(Date.now() - capturedAt.getTime()) > 10 * 60 * 1000 || !Number.isInteger(width) || width < 1 || width > 10000 || !Number.isInteger(height) || height < 1 || height > 10000 || !validImage(request.body, mimeType)) return reply.code(400).send({ error: { code: 'INVALID_CAPTURE', message: 'Screenshot metadata or image payload is invalid' } });
    const existing = await prisma.screenCaptureMetadata.findUnique({ where: { deviceId_captureKey: { deviceId: device.id, captureKey } } });
    if (existing) return { success: true, deduplicated: true, captureId: existing.id };
    const policy = await evaluateDevicePolicy(prisma, device, capturedAt);
    if (!policy.allowed) return reply.code(403).send({ error: { code: policy.reason, message: 'Screenshot capture is not currently authorized' } });
    if (policy.excludedApplications.some((value) => applicationName.toLowerCase().includes(value))) return reply.code(403).send({ error: { code: 'SENSITIVE_APPLICATION_EXCLUDED', message: 'The active application is excluded from screenshot monitoring' } });
    const captureId = crypto.randomUUID();
    const storageKey = screenshotObjectKey({ organizationId: device.organizationId, deviceId: device.id, captureId, extension: mimeType === 'image/png' ? 'png' : 'jpg' });
    await getStore().put(storageKey, request.body);
    const expiresAt = new Date(capturedAt.getTime() + policy.retentionDays * 86400_000);
    try {
      const capture = await prisma.screenCaptureMetadata.create({ data: { id: captureId, organizationId: device.organizationId, employeeId: device.userId, deviceId: device.id, captureKey, storageKey, applicationName, mimeType, sizeBytes: request.body.length, width, height, captureStatus: 'stored', capturedAt, expiresAt } });
      await prisma.device.update({ where: { id: device.id }, data: { lastScreenCaptureAt: capturedAt, lastScreenCaptureError: null } });
      return reply.code(201).send({ success: true, captureId: capture.id, capturedAt: capture.capturedAt });
    } catch (error) {
      await getStore().delete(storageKey).catch(() => {});
      throw error;
    }
  });

  fastify.post('/screen-monitoring/failures', async (request, reply) => {
    const device = request.device;
    if (!device || device.id !== request.body?.deviceId) return reply.code(403).send({ error: { code: 'DEVICE_SCOPE_MISMATCH', message: 'Failure device does not match authenticated device' } });
    const failureCode = String(request.body?.failureCode || 'CAPTURE_FAILED').replace(/[^A-Z0-9_]/g, '').slice(0, 128);
    await prisma.device.update({ where: { id: device.id }, data: { lastScreenCaptureFailureAt: new Date(), lastScreenCaptureError: failureCode } });
    return { success: true };
  });

  fastify.get('/screen-monitoring/captures', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const page = Math.max(1, Number.parseInt(request.query?.page || '1', 10));
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.query?.pageSize || '24', 10)));
    const where = { organizationId };
    if (request.query?.employeeId) where.employeeId = request.query.employeeId;
    if (request.query?.deviceId) where.deviceId = request.query.deviceId;
    if (request.query?.from || request.query?.to) where.capturedAt = { ...(request.query.from ? { gte: new Date(request.query.from) } : {}), ...(request.query.to ? { lte: new Date(request.query.to) } : {}) };
    const [rows, total] = await Promise.all([
      prisma.screenCaptureMetadata.findMany({ where, include: { employee: { select: { displayName: true } }, device: { select: { name: true } } }, orderBy: { capturedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.screenCaptureMetadata.count({ where }),
    ]);
    return { captures: rows.map((row) => mapCapture(row, request)), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  });

  fastify.get('/screen-monitoring/employees/:employeeId/captures', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const rows = await prisma.screenCaptureMetadata.findMany({ where: { organizationId, employeeId: request.params.employeeId }, include: { employee: true, device: true }, orderBy: { capturedAt: 'desc' }, take: 100 });
    return { captures: rows.map((row) => mapCapture(row, request)) };
  });

  fastify.get('/screen-monitoring/captures/:captureId', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const row = await prisma.screenCaptureMetadata.findFirst({ where: { id: request.params.captureId, organizationId }, include: { employee: true, device: true } });
    if (!row) return reply.code(404).send({ error: { code: 'CAPTURE_NOT_FOUND', message: 'Screenshot not found' } });
    await audit(prisma, organizationId, 'SCREENSHOT_METADATA_VIEWED', request.user.email, { captureId: row.id });
    return { capture: mapCapture(row, request) };
  });

  fastify.get('/screen-monitoring/captures/:captureId/image', async (request, reply) => {
    const role = normalizeRole(request.user?.role);
    if (![Roles.ADMIN, Roles.SUPER_ADMIN].includes(role)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Screenshot access requires administrator permission' } });
    if (!verifyViewToken(request.query?.token, request.params.captureId, request.user.id)) return reply.code(403).send({ error: { code: 'VIEW_URL_EXPIRED', message: 'This screenshot link is invalid or expired' } });
    const organizationId = request.user.organizationId;
    const row = await prisma.screenCaptureMetadata.findFirst({ where: { id: request.params.captureId, organizationId, captureStatus: 'stored' } });
    if (!row?.storageKey) return reply.code(404).send({ error: { code: 'CAPTURE_NOT_FOUND', message: 'Screenshot not found' } });
    const bytes = await getStore().get(row.storageKey);
    await audit(prisma, organizationId, 'SCREENSHOT_VIEWED', request.user.email, { captureId: row.id });
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('Content-Disposition', `inline; filename="digitalpulse-${row.id}.${row.mimeType === 'image/png' ? 'png' : 'jpg'}"`);
    return reply.type(row.mimeType).send(bytes);
  });

  fastify.delete('/screen-monitoring/captures/:captureId', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const row = await prisma.screenCaptureMetadata.findFirst({ where: { id: request.params.captureId, organizationId } });
    if (!row) return reply.code(404).send({ error: { code: 'CAPTURE_NOT_FOUND', message: 'Screenshot not found' } });
    if (row.storageKey) await getStore().delete(row.storageKey);
    await prisma.screenCaptureMetadata.delete({ where: { id: row.id } });
    await audit(prisma, organizationId, 'SCREENSHOT_DELETED', request.user.email, { captureId: row.id });
    return { success: true };
  });

  let cleanupTimer;
  fastify.addHook('onReady', async () => {
    cleanupTimer = setInterval(() => { void runScreenshotRetentionCleanup(prisma, getStore(), fastify.log); }, 60 * 60 * 1000);
    cleanupTimer.unref?.();
  });
  fastify.addHook('onClose', async () => { if (cleanupTimer) clearInterval(cleanupTimer); });
}
