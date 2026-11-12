import crypto from 'node:crypto';
import { Roles, normalizeRole } from '../auth/auth.service.js';
import { evaluateSchedulePolicy, getMonitoringAuthorization } from '../devices/monitoring-authorization.js';
import { createScreenshotStore, createViewToken, screenshotObjectKey, verifyViewToken } from './screen-storage.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SCREEN_CAPTURE_DEVICE_KINDS = ['DESKTOP_AGENT', 'BROWSER_EXTENSION'];

function isScreenCaptureDevice(device) {
  if (!device || device.isRevoked || device.archivedAt) return false;

  if (device.kind === 'DESKTOP_AGENT') return true;

  return (
    device.kind === 'BROWSER_EXTENSION' &&
    device.platform?.toLowerCase() === 'windows' &&
    ['chrome', 'edge'].includes(device.browser?.toLowerCase())
  );
}

const DEFAULT_SETTING = Object.freeze({
  enabled: false,
  captureIntervalSeconds: 300,
  retentionDays: 30,
  workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  shiftStart: '09:00',
  shiftEnd: '18:00',
  excludedApplications: []
});

export function localScheduleState(setting, timezone, at = new Date()) {
  return evaluateSchedulePolicy({ ...setting, timezone }, at);
}

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

export async function evaluateDevicePolicy(prisma, device, at = new Date(), preloaded = {}) {
  if (!isScreenCaptureDevice(device)) {
    return { allowed: false, reason: 'DEVICE_NOT_ELIGIBLE' };
  }

  if (!device.screenCaptureEnabled) {
    return { allowed: false, reason: 'DEVICE_NOT_SELECTED' };
  }

  if (!device.userId) {
    return { allowed: false, reason: 'DEVICE_OWNER_REQUIRED' };
  }

  const owner =
    preloaded.owner && preloaded.owner.id === device.userId && preloaded.owner.organization
      ? preloaded.owner
      : await prisma.user.findUnique({
          where: { id: device.userId },
          include: {
            organization: {
              select: { timezone: true }
            }
          }
        });

  if (!owner || owner.organizationId !== device.organizationId) {
    return { allowed: false, reason: 'DEVICE_OWNER_REQUIRED' };
  }

  const setting = preloaded.setting || (await readSetting(prisma, device.organizationId));

  if (!setting.enabled) {
    return { allowed: false, reason: 'SCREEN_MONITORING_DISABLED', setting, owner };
  }

  if (!owner.screenMonitoringAcknowledgedAt) {
    return { allowed: false, reason: 'SCREEN_NOTICE_NOT_ACKNOWLEDGED', setting, owner };
  }

  // The employee's existing schedule is the ONLY schedule gate.
  const authorization = getMonitoringAuthorization(owner, at);

  if (!authorization.allowed) {
    return {
      allowed: false,
      reason: authorization.reason,
      nextCheckAt: authorization.nextCheckAt,
      setting,
      owner
    };
  }

  const organizationSchedule = evaluateSchedulePolicy({
    workingDays: setting.workingDays,
    shiftStart: setting.shiftStart,
    shiftEnd: setting.shiftEnd,
    timezone: owner.organization.timezone,
  }, at);
  if (!organizationSchedule.allowed) {
    return { allowed: false, reason: organizationSchedule.reason, nextCheckAt: organizationSchedule.nextCheckAt, setting, owner };
  }

  return {
    allowed: true,
    reason: null,
    intervalSeconds: setting.captureIntervalSeconds,
    retentionDays: setting.retentionDays,
    excludedApplications: setting.excludedApplications,
    visibleIndicator: true,
    allowedUntil: new Date(Math.min(new Date(authorization.allowedUntil).getTime(), organizationSchedule.allowedUntil.getTime())).toISOString(),
    setting,
    owner
  };
}

function validImage(bytes, mimeType, width, height) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_IMAGE_BYTES) return false;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height;
  if (mimeType === 'image/jpeg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
    let dimensionsMatch = false;
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) return false;
        dimensionsMatch = bytes.readUInt16BE(offset + 3) === height && bytes.readUInt16BE(offset + 5) === width;
      }
      if (marker === 0xda) return dimensionsMatch;
      offset += length;
    }
  }
  return false;
}

async function audit(prisma, organizationId, action, actor, details) {
  if (prisma.auditLog?.create) await prisma.auditLog.create({ data: { organizationId, action, actor, details } });
}

function mapCapture(row, request) {
  const bucketMs = 5 * 60 * 1000;
  const expires = Math.ceil((Date.now() + 60 * 1000) / bucketMs) * bucketMs;
  const token = createViewToken(row.id, request.user.id, expires);
  return {
    id: row.id, captureKey: row.captureKey, employeeId: row.employeeId,
    employeeName: row.employee?.displayName || row.device?.user?.displayName || null,
    deviceId: row.deviceId, deviceName: row.device?.name || null, collectorKind: row.device?.kind || null, browser: row.device?.browser || null, applicationName: row.applicationName,
    mimeType: row.mimeType, sizeBytes: row.sizeBytes, width: row.width, height: row.height,
    status: row.captureStatus, failureCode: row.failureCode, capturedAt: row.capturedAt,
    timestamp: row.capturedAt, expiresAt: row.expiresAt,
    imageUrl: row.captureStatus === 'stored' ? `/api/v1/screen-monitoring/captures/${row.id}/image?organizationId=${encodeURIComponent(row.organizationId)}&expires=${expires}&token=${encodeURIComponent(token)}` : null,
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
    const existing = await readSetting(prisma, organizationId);
    const interval = Number(body.captureIntervalSeconds ?? existing.captureIntervalSeconds);
    const retention = Number(body.retentionDays ?? existing.retentionDays);
    const workingDays = body.workingDays ?? existing.workingDays;
    const shiftStart = body.shiftStart ?? existing.shiftStart;
    const shiftEnd = body.shiftEnd ?? existing.shiftEnd;
    const excludedApplications = body.excludedApplications ?? existing.excludedApplications;
    if (
      typeof body.enabled !== 'boolean' ||
      !Number.isInteger(interval) ||
      interval < 60 ||
      interval > 3600 ||
      !Number.isInteger(retention) ||
      retention < 1 ||
      retention > 365 ||
      !Array.isArray(workingDays) ||
      workingDays.length === 0 ||
      workingDays.some((day) => !['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(day)) ||
      new Set(workingDays).size !== workingDays.length ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(shiftStart) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(shiftEnd) ||
      shiftStart === shiftEnd ||
      !Array.isArray(excludedApplications) ||
      excludedApplications.some(
        (name) => typeof name !== 'string' || name.length > 128
      )
    ) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_SCREEN_POLICY',
          message: 'Provide a valid capture interval, retention period, and exclusion list'
        }
      });
    }
    const data = {
      enabled: body.enabled,
      captureIntervalSeconds: interval,
      retentionDays: retention,
      workingDays,
      shiftStart,
      shiftEnd,
      excludedApplications: [
        ...new Set(
          excludedApplications
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
        )
      ],
      updatedBy: request.user.email
    };
    const settings = await prisma.screenMonitoringSetting.upsert({ where: { organizationId }, update: data, create: { organizationId, ...data } });
    await audit(prisma, organizationId, 'SCREEN_MONITORING_POLICY_UPDATED', request.user.email, { ...data, excludedApplications: data.excludedApplications.length });
    return { success: true, settings };
  });

  fastify.get('/screen-monitoring/employees', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const devices = await prisma.device.findMany({
      where: {
        organizationId,
        archivedAt: null,
        deletedAt: null,
        OR: [
          { kind: 'DESKTOP_AGENT' },
          {
            kind: 'BROWSER_EXTENSION',
            platform: 'windows',
            browser: { in: ['chrome', 'edge'] },
          },
        ],
      },
      include: { user: { select: { id: true, displayName: true, email: true, screenMonitoringAcknowledgedAt: true } } },
      orderBy: { name: 'asc' },
    });
    const setting = await readSetting(prisma, organizationId);
    const policies = new Map(await Promise.all(devices.map(async (device) => [device.id, await evaluateDevicePolicy(prisma, device, new Date(), { setting })])));
    const latestCaptures = devices.length ? await prisma.screenCaptureMetadata.findMany({
      where: { organizationId, deviceId: { in: devices.map((device) => device.id) }, captureStatus: 'stored', expiresAt: { gt: new Date() } },
      select: { id: true, deviceId: true, capturedAt: true },
      orderBy: { capturedAt: 'desc' },
      distinct: ['deviceId'],
    }) : [];
    const latestCaptureByDevice = new Map(latestCaptures.map((capture) => [capture.deviceId, capture]));
    const now = Date.now();
    return { employees: devices.map((device) => {
      const latestCapture = latestCaptureByDevice.get(device.id) || null;
      const cachedCaptureTime = device.lastScreenCaptureAt ? new Date(device.lastScreenCaptureAt).getTime() : null;
      const recordCaptureTime = latestCapture?.capturedAt ? new Date(latestCapture.capturedAt).getTime() : null;
      return { employeeId: device.user?.id || null, employeeName: device.user?.displayName || 'Unassigned device', email: device.user?.email || null, acknowledgedAt: device.user?.screenMonitoringAcknowledgedAt || null, deviceId: device.id, deviceName: device.name, selected: device.screenCaptureEnabled, connectivity: device.lastSeenAt && now - new Date(device.lastSeenAt).getTime() < 5 * 60 * 1000 ? 'online' : 'offline', lastSeenAt: device.lastSeenAt, lastCaptureAt: latestCapture?.capturedAt || null, lastCaptureId: latestCapture?.id || null, captureRecordVerified: Boolean(latestCapture), captureStatusMismatch: cachedCaptureTime !== recordCaptureTime, deviceReportedLastCaptureAt: device.lastScreenCaptureAt || null, lastFailureAt: device.lastScreenCaptureFailureAt, lastFailure: device.lastScreenCaptureError };
    }).map((row) => ({ ...row, kind: devices.find((device) => device.id === row.deviceId)?.kind || null, revoked: Boolean(devices.find((device) => device.id === row.deviceId)?.isRevoked), policyAllowed: policies.get(row.deviceId)?.allowed === true, policyReason: policies.get(row.deviceId)?.reason || null })) };
  });

  fastify.patch('/screen-monitoring/devices/:deviceId', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    if (typeof request.body?.enabled !== 'boolean') return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'enabled must be boolean' } });
    const updated = await prisma.device.updateMany({
      where: {
        id: request.params.deviceId,
        organizationId,
        isRevoked: false,
        archivedAt: null,
        deletedAt: null,
        userId: { not: null },
        OR: [
          { kind: 'DESKTOP_AGENT' },
          {
            kind: 'BROWSER_EXTENSION',
            platform: 'windows',
            browser: { in: ['chrome', 'edge'] },
          },
        ],
      },
      data: { screenCaptureEnabled: request.body.enabled },
    });
    if (updated.count !== 1) return reply.code(404).send({ error: { code: 'DEVICE_NOT_FOUND', message: 'Eligible organization device not found' } });
    await audit(prisma, organizationId, 'SCREEN_MONITORING_DEVICE_UPDATED', request.user.email, { deviceId: request.params.deviceId, enabled: request.body.enabled });
    await audit(prisma, organizationId, 'DEVICE_AUTHORIZATION_CHANGED', request.user.email, { deviceId: request.params.deviceId, authorization: 'SCREEN_CAPTURE', enabled: request.body.enabled });
    return { success: true };
  });

  fastify.get('/screen-monitoring/me', async (request) => {
    const owner = await prisma.user.findUnique({ where: { id: request.user.id }, include: { organization: { select: { timezone: true } } } });
    const setting = await readSetting(prisma, request.user.organizationId);
    const devices = await prisma.device.findMany({ where: { organizationId: request.user.organizationId, userId: request.user.id, archivedAt: null, deletedAt: null }, select: { id: true, name: true, kind: true, platform: true, browser: true, isRevoked: true, archivedAt: true, screenCaptureEnabled: true, lastSeenAt: true, lastScreenCaptureAt: true, lastScreenCaptureFailureAt: true, lastScreenCaptureError: true } });
    const deviceStatuses = await Promise.all(devices.filter((device) => isScreenCaptureDevice(device)).map(async (device) => {
      const latest = await prisma.screenCaptureMetadata.findFirst({ where: { organizationId: request.user.organizationId, deviceId: device.id, captureStatus: 'stored', expiresAt: { gt: new Date() } }, select: { capturedAt: true }, orderBy: { capturedAt: 'desc' } });
      const policy = await evaluateDevicePolicy(prisma, { ...device, organizationId: request.user.organizationId, userId: request.user.id }, new Date(), { owner, setting });
      return { ...device, policyAllowed: policy.allowed, policyReason: policy.reason, lastCaptureAt: latest?.capturedAt || null, connectivity: device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 5 * 60 * 1000 ? 'online' : 'offline' };
    }));
    return { acknowledgedAt: owner?.screenMonitoringAcknowledgedAt || null, consentGranted: Boolean(owner?.monitoringConsentAt && (!owner?.monitoringConsentRevokedAt || owner.monitoringConsentRevokedAt < owner.monitoringConsentAt)), adminAuthorized: owner?.monitoringAuthorized === true, noticeVersion: 'screen-monitoring-v1', organizationEnabled: setting.enabled, captureIntervalSeconds: setting.captureIntervalSeconds, retentionDays: setting.retentionDays, workingDays: setting.workingDays, shiftStart: setting.shiftStart, shiftEnd: setting.shiftEnd, timezone: owner?.organization?.timezone || null, devices: deviceStatuses, explanation: 'DigitalPulse captures the authorized Windows desktop or only the visible active Chrome/Edge browser tab on selected enrolled work devices during authorized hours. Captures are private, access-audited, and automatically deleted after the retention period.' };
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

  fastify.post('/screen-monitoring/captures', { bodyLimit: MAX_IMAGE_BYTES }, async (request, reply) => {
    const device = request.device;
    if (!device || device.id !== request.query?.deviceId) return reply.code(403).send({ error: { code: 'DEVICE_SCOPE_MISMATCH', message: 'Capture device does not match authenticated device' } });
    const captureKey = String(request.headers['x-capture-key'] || '');
    const capturedAt = new Date(String(request.headers['x-captured-at'] || ''));
    const width = Number(request.headers['x-image-width']);
    const height = Number(request.headers['x-image-height']);
    const applicationName = String(request.headers['x-application-name'] || 'Active Windows desktop').slice(0, 128);
    const mimeType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(captureKey) || !Number.isFinite(capturedAt.getTime()) || capturedAt.getTime() > Date.now() + 5 * 60 * 1000 || !Number.isInteger(width) || width < 1 || width > 10000 || !Number.isInteger(height) || height < 1 || height > 10000 || !validImage(request.body, mimeType, width, height)) return reply.code(400).send({ error: { code: 'INVALID_CAPTURE', message: 'Screenshot metadata or image payload is invalid' } });
    const currentPolicy = await evaluateDevicePolicy(prisma, device);
    if (!currentPolicy.allowed) return reply.code(403).send({ error: { code: currentPolicy.reason, message: 'Screenshot upload is not currently authorized' } });
    const existing = await prisma.screenCaptureMetadata.findUnique({ where: { deviceId_captureKey: { deviceId: device.id, captureKey } } });
    if (existing) return { success: true, deduplicated: true, captureId: existing.id };
    const policy = await evaluateDevicePolicy(prisma, device, capturedAt);
    if (!policy.allowed) return reply.code(403).send({ error: { code: policy.reason, message: 'Screenshot capture is not currently authorized' } });
    if (policy.excludedApplications.some((value) => applicationName.toLowerCase().includes(value))) return reply.code(403).send({ error: { code: 'SENSITIVE_APPLICATION_EXCLUDED', message: 'The active application is excluded from screenshot monitoring' } });
    const captureId = crypto.randomUUID();
    const storageKey = screenshotObjectKey({ organizationId: device.organizationId, deviceId: device.id, captureId, extension: mimeType === 'image/png' ? 'png' : 'jpg' });
    await getStore().put(storageKey, request.body);
    const expiresAt = new Date(capturedAt.getTime() + policy.retentionDays * 86400_000);
    if (expiresAt <= new Date()) {
      await getStore().delete(storageKey);
      return reply.code(400).send({ error: { code: 'CAPTURE_EXPIRED', message: 'Screenshot is outside retention' } });
    }
    let capture;
    try {
      capture = await prisma.screenCaptureMetadata.create({ data: { id: captureId, organizationId: device.organizationId, employeeId: device.userId, deviceId: device.id, captureKey, storageKey, applicationName, mimeType, sizeBytes: request.body.length, width, height, captureStatus: 'stored', capturedAt, expiresAt } });
    } catch (error) {
      await getStore().delete(storageKey).catch(() => {});
      if (error?.code === 'P2002') {
        const duplicate = await prisma.screenCaptureMetadata.findUnique({ where: { deviceId_captureKey: { deviceId: device.id, captureKey } } });
        if (duplicate) return { success: true, deduplicated: true, captureId: duplicate.id };
      }
      throw error;
    }
    // Metadata now owns this object. A status-cache failure must never delete it.
    try {
      await prisma.device.updateMany({ where: { id: device.id, organizationId: device.organizationId, OR: [{ lastScreenCaptureAt: null }, { lastScreenCaptureAt: { lte: capturedAt } }] }, data: { lastScreenCaptureAt: capturedAt, lastScreenCaptureError: null } });
    } catch {
      fastify.log.error({ captureId, deviceId: device.id, code: 'SCREEN_STATUS_UPDATE_FAILED' }, 'Stored screenshot status update failed');
    }
    return reply.code(201).send({ success: true, captureId: capture.id, capturedAt: capture.capturedAt });
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
    const parsedPage = Number.parseInt(request.query?.page || '1', 10);
    const parsedPageSize = Number.parseInt(request.query?.pageSize || '24', 10);
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const pageSize = Number.isSafeInteger(parsedPageSize) ? Math.min(100, Math.max(1, parsedPageSize)) : 24;
    const where = { organizationId, expiresAt: { gt: new Date() } };
    if (request.query?.employeeId) where.employeeId = request.query.employeeId;
    if (request.query?.deviceId) where.deviceId = request.query.deviceId;
    if (request.query?.search) where.employee = { displayName: { contains: String(request.query.search).slice(0, 128), mode: 'insensitive' } };
    if (request.query?.from || request.query?.to) {
      const from = request.query.from ? new Date(request.query.from) : null;
      const to = request.query.to ? new Date(request.query.to) : null;
      if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) {
        return reply.code(400).send({ error: { code: 'INVALID_DATE_RANGE', message: 'Provide a valid screenshot date range' } });
      }
      where.capturedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }
    const [rows, total] = await Promise.all([
      prisma.screenCaptureMetadata.findMany({ where, include: { employee: { select: { displayName: true } }, device: { select: { name: true, kind: true, browser: true } } }, orderBy: { capturedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.screenCaptureMetadata.count({ where }),
    ]);
    return { captures: rows.map((row) => mapCapture(row, request)), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  });

  fastify.get('/screen-monitoring/employees/:employeeId/captures', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const rows = await prisma.screenCaptureMetadata.findMany({ where: { organizationId, employeeId: request.params.employeeId, expiresAt: { gt: new Date() } }, include: { employee: true, device: true }, orderBy: { capturedAt: 'desc' }, take: 100 });
    return { captures: rows.map((row) => mapCapture(row, request)) };
  });

  fastify.get('/screen-monitoring/captures/:captureId', async (request, reply) => {
    const organizationId = adminOrganization(request, reply);
    if (!organizationId) return;
    const row = await prisma.screenCaptureMetadata.findFirst({ where: { id: request.params.captureId, organizationId, expiresAt: { gt: new Date() } }, include: { employee: true, device: true } });
    if (!row) return reply.code(404).send({ error: { code: 'CAPTURE_NOT_FOUND', message: 'Screenshot not found' } });
    await audit(prisma, organizationId, 'SCREENSHOT_METADATA_VIEWED', request.user.email, { captureId: row.id });
    return { capture: mapCapture(row, request) };
  });

  fastify.get('/screen-monitoring/captures/:captureId/image', async (request, reply) => {
    const role = normalizeRole(request.user?.role);
    if (![Roles.ADMIN, Roles.SUPER_ADMIN].includes(role)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Screenshot access requires administrator permission' } });
    if (!verifyViewToken(request.query?.token, request.params.captureId, request.user.id)) return reply.code(403).send({ error: { code: 'VIEW_URL_EXPIRED', message: 'This screenshot link is invalid or expired' } });
    const organizationId = role === Roles.SUPER_ADMIN ? request.query?.organizationId : request.user.organizationId;
    if (!organizationId) return reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization' } });
    const row = await prisma.screenCaptureMetadata.findFirst({ where: { id: request.params.captureId, organizationId, captureStatus: 'stored', expiresAt: { gt: new Date() } } });
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
