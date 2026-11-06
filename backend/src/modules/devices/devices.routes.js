import { DeviceService } from './devices.service.js';
import { normalizeRole, Roles } from '../auth/auth.service.js';
import { getMonitoringAuthorization } from './monitoring-authorization.js';

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function readOwnMonitoringStatus(prisma, user) {
  if (!prisma?.user?.findUnique) {
    const error = new Error('Monitoring settings are unavailable');
    error.statusCode = 503;
    throw error;
  }
  const owner = await prisma.user.findUnique({
    where: { id: user.id },
    include: { organization: { select: { timezone: true } } },
  });
  if (!owner || owner.organizationId !== user.organizationId) {
    const error = new Error('Account or organization could not be verified');
    error.statusCode = 404;
    throw error;
  }
  return {
    monitoring: getMonitoringAuthorization(owner),
    settings: {
      shiftStart: owner.shiftStart || '',
      shiftEnd: owner.shiftEnd || '',
      workingDays: owner.workingDays || [],
      organizationTimezone: owner.organization?.timezone || '',
      adminAuthorized: owner.monitoringAuthorized === true,
      consentGranted: Boolean(owner.monitoringConsentAt && (!owner.monitoringConsentRevokedAt || owner.monitoringConsentRevokedAt < owner.monitoringConsentAt)),
    },
  };
}

export default async function devicesRoutes(app) {
  const deviceService = app.deviceService || new DeviceService(app.prisma, app.log);
  if (!app.deviceService) {
    app.decorate('deviceService', deviceService);
  }

  const authMiddleware = app.authMiddleware;

  app.get('/devices/my-monitoring-status', async (request, reply) => {
    try {
      return reply.send(await readOwnMonitoringStatus(app.prisma, request.user));
    } catch (error) {
      return reply.code(error.statusCode || 503).send({ error: { code: 'MONITORING_STATUS_UNAVAILABLE', message: error.message } });
    }
  });

  app.post('/devices/my-monitoring-consent', async (request, reply) => {
    const { consent } = request.body || {};
    if (typeof consent !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'consent must be true or false' } });
    }
    if (!app.prisma?.user?.updateMany) {
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Monitoring consent could not be saved' } });
    }
    const now = new Date();
    try {
      const persistConsent = async (tx) => {
        const changed = await tx.user.updateMany({
          where: { id: request.user.id, organizationId: request.user.organizationId },
          data: consent
            ? { monitoringConsentAt: now, monitoringConsentRevokedAt: null, monitoringConsentVersion: 'activity-monitoring-v1' }
            : { monitoringConsentRevokedAt: now },
        });
        if (changed.count !== 1) return 0;
        if (tx.auditLog?.create) await tx.auditLog.create({
          data: {
            organizationId: request.user.organizationId,
            action: consent ? 'ACTIVITY_MONITORING_CONSENT_GRANTED' : 'ACTIVITY_MONITORING_CONSENT_REVOKED',
            actor: request.user.email,
            details: { userId: request.user.id, version: 'activity-monitoring-v1' },
          },
        });
        return 1;
      };
      const changedCount = app.prisma.$transaction
        ? await app.prisma.$transaction(persistConsent)
        : await persistConsent(app.prisma);
      if (changedCount !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found in this organization' } });
      return reply.send({ success: true, ...(await readOwnMonitoringStatus(app.prisma, request.user)) });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to persist monitoring consent');
      return reply.code(503).send({ error: { code: 'CONSENT_SAVE_FAILED', message: 'Monitoring consent could not be saved' } });
    }
  });

  // Organization administrators explicitly approve or pause monitoring for
  // their own account. The organization and target are derived from the
  // authenticated session, so a caller cannot change another user's policy.
  app.patch('/devices/my-monitoring-authorization', {
    preHandler: [authMiddleware.requireRole(Roles.ADMIN)],
  }, async (request, reply) => {
    const { authorized } = request.body || {};
    if (typeof authorized !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'authorized must be true or false' } });
    }
    if (!request.user?.organizationId || !app.prisma?.user?.updateMany) {
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Monitoring authorization could not be saved' } });
    }
    try {
      const persist = async (tx) => {
        const changed = await tx.user.updateMany({
          where: { id: request.user.id, organizationId: request.user.organizationId },
          data: { monitoringAuthorized: authorized },
        });
        if (changed.count !== 1) return 0;
        if (tx.auditLog?.create) await tx.auditLog.create({
          data: {
            organizationId: request.user.organizationId,
            action: authorized ? 'ACTIVITY_MONITORING_ADMIN_AUTHORIZED' : 'ACTIVITY_MONITORING_ADMIN_AUTHORIZATION_REVOKED',
            actor: request.user.email,
            details: { userId: request.user.id },
          },
        });
        return 1;
      };
      const changedCount = app.prisma.$transaction
        ? await app.prisma.$transaction(persist)
        : await persist(app.prisma);
      if (changedCount !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found in this organization' } });
      return reply.send({ success: true, ...(await readOwnMonitoringStatus(app.prisma, request.user)) });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to persist self monitoring authorization');
      return reply.code(503).send({ error: { code: 'AUTHORIZATION_SAVE_FAILED', message: 'Monitoring authorization could not be saved' } });
    }
  });

  app.patch('/devices/my-monitoring-schedule', async (request, reply) => {
    const { shiftStart, shiftEnd, workingDays } = request.body || {};
    if (!TIME_RE.test(shiftStart || '') || !TIME_RE.test(shiftEnd || '') || shiftStart === shiftEnd ||
        !Array.isArray(workingDays) || workingDays.length === 0 ||
        workingDays.some((day) => !WORKING_DAYS.includes(day)) || new Set(workingDays).size !== workingDays.length) {
      return reply.code(400).send({ error: { code: 'INVALID_SCHEDULE', message: 'Choose valid working hours and at least one working day. Overnight schedules are supported.' } });
    }
    if (!app.prisma?.user?.updateMany) {
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'The monitoring schedule could not be saved' } });
    }
    try {
      const changed = await app.prisma.user.updateMany({
        where: { id: request.user.id, organizationId: request.user.organizationId },
        data: { shiftStart, shiftEnd, workingDays },
      });
      if (changed.count !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found in this organization' } });
      return reply.send({ success: true, ...(await readOwnMonitoringStatus(app.prisma, request.user)) });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to persist personal monitoring schedule');
      return reply.code(503).send({ error: { code: 'SCHEDULE_SAVE_FAILED', message: 'The monitoring schedule could not be saved' } });
    }
  });

  app.patch('/devices/organization-timezone', {
    preHandler: [authMiddleware.requireRole(Roles.ADMIN)],
  }, async (request, reply) => {
    const timezone = typeof request.body?.timezone === 'string' ? request.body.timezone.trim() : '';
    if (!timezone || timezone.length > 64) {
      return reply.code(400).send({ error: { code: 'INVALID_TIMEZONE', message: 'Enter a valid organization time zone' } });
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
    catch { return reply.code(400).send({ error: { code: 'INVALID_TIMEZONE', message: 'Enter a valid IANA time zone, such as Europe/London' } }); }
    if (!request.user.organizationId || !app.prisma?.organization?.updateMany) {
      return reply.code(503).send({ error: { code: 'ORGANIZATION_SETTINGS_UNAVAILABLE', message: 'Organization settings could not be saved' } });
    }
    try {
      const changed = await app.prisma.organization.updateMany({ where: { id: request.user.organizationId }, data: { timezone } });
      if (changed.count !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      return reply.send({ success: true, timezone });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to persist organization time zone');
      return reply.code(503).send({ error: { code: 'ORGANIZATION_SETTINGS_UNAVAILABLE', message: 'Organization time zone could not be saved' } });
    }
  });

  // GET /api/v1/devices (Protected: User authentication, tenant & role scoped)
  app.get('/devices', async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const userRole = normalizeRole(user.role);

    const orgId =
      userRole === Roles.SUPER_ADMIN
        ? request.query?.organizationId
        : user.organizationId;

    if (userRole === Roles.SUPER_ADMIN && !orgId) {
      return reply.code(400).send({
        error: 'ORGANIZATION_SCOPE_REQUIRED',
        message: 'Select an organization to view its devices',
      });
    }

    const targetUserId =
      userRole === Roles.EMPLOYEE ? user.id : null;

    const devices = await deviceService.listDevices(orgId, targetUserId);
    return reply.send({ devices, totalCount: devices.length });
  });

  // POST /api/v1/devices/enrollment-tokens (Protected: Admin or Super Admin only)
  app.post(
    '/devices/enrollment-tokens',
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const userRole = normalizeRole(user.role);

      if (![Roles.ADMIN, Roles.SUPER_ADMIN].includes(userRole)) {
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Only administrators can create enrollment tokens',
        });
      }

      const { userId, deviceKind, expiresInHours } = request.body || {};
      const orgId =
        userRole === Roles.SUPER_ADMIN
          ? request.body?.organizationId
          : user.organizationId;

      if (!orgId) {
        return reply.code(400).send({
          error: 'ORGANIZATION_SCOPE_REQUIRED',
          message: 'Organization ID is required',
        });
      }

      try {
        const tokenInfo = await deviceService.createEnrollmentToken({
          organizationId: orgId,
          userId,
          deviceKind,
          expiresInHours,
        });
        return reply.status(201).send({ success: true, ...tokenInfo });
      } catch (err) {
        return reply.status(400).send({
          error: { code: 'TOKEN_CREATION_FAILED', message: err.message },
        });
      }
    },
  );

  // Employees and organization administrators may create a short-lived token
  // only for their own device. Scope always comes from the authenticated user.
  app.post('/devices/my-enrollment-token', {
    preHandler: [authMiddleware.requireRole(Roles.EMPLOYEE, Roles.ADMIN)],
  }, async (request, reply) => {
    const role = normalizeRole(request.user?.role);
    if (![Roles.EMPLOYEE, Roles.ADMIN].includes(role)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Only an employee or organization administrator may enroll their own device' } });
    }
    const { deviceKind } = request.body || {};
    if (!['DESKTOP_AGENT', 'BROWSER_EXTENSION'].includes(deviceKind)) {
      return reply.code(400).send({ error: { code: 'INVALID_DEVICE_KIND', message: 'Choose DESKTOP_AGENT or BROWSER_EXTENSION' } });
    }
    if (!request.user?.organizationId || !request.user?.id || request.user?.employmentStatus === 'disabled') {
      return reply.code(403).send({ error: { code: 'ACCOUNT_SCOPE_REQUIRED', message: 'An active organization account is required' } });
    }
    try {
      const tokenInfo = await deviceService.createEnrollmentToken({
        organizationId: request.user.organizationId,
        userId: request.user.id,
        deviceKind,
        expiresInHours: 4,
      });
      return reply.code(201).send({ success: true, ...tokenInfo });
    } catch (err) {
      return reply.code(err.statusCode || 503).send({ error: { code: 'TOKEN_CREATION_FAILED', message: err.message } });
    }
  });

  // POST /api/v1/devices/enroll (Public: Device consumes one-time enrollment token)
  app.post('/devices/enroll', async (request, reply) => {
    const { token, deviceId, name, platform, browser, agentVersion } = request.body || {};
    try {
      const result = await deviceService.enrollDevice({
        token,
        deviceId,
        name,
        platform,
        browser,
        agentVersion,
      });
      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: 'ENROLLMENT_FAILED', message: err.message },
      });
    }
  });

  // POST /api/v1/devices/:id/heartbeat (Protected: Authenticated Device credentials)
  app.post('/devices/:id/heartbeat', async (request, reply) => {
    const { id } = request.params;
    const { agentVersion, metrics } = request.body || {};

    // Extract device secret from header or payload
    const secret =
      request.headers['x-device-secret'] ||
      (request.headers.authorization?.startsWith('Bearer ') && request.headers.authorization.substring(7).trim()) ||
      request.body?.deviceSecret ||
      request.body?.secret;

    if (!secret) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Device credentials required. Supply X-Device-Secret or Bearer secret',
        },
      });
    }

    try {
      const result = await deviceService.recordHeartbeat(id, secret, { agentVersion, metrics });
      return reply.send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: err.code || 'HEARTBEAT_FAILED', message: err.message },
      });
    }
  });

  // POST /api/v1/devices/:id/revoke (Protected: Admin only, tenant-scoped)
  app.post(
    '/devices/:id/revoke',
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const userRole = normalizeRole(user.role);

      if (![Roles.ADMIN, Roles.SUPER_ADMIN].includes(userRole)) {
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Only administrators can revoke devices',
        });
      }

      const { id } = request.params;
      const orgId =
        userRole === Roles.SUPER_ADMIN
          ? null
          : user.organizationId;

      try {
        const result = await deviceService.revokeDevice(id, orgId, user.email || user.displayName || 'Administrator');
        return reply.send(result);
      } catch (err) {
        return reply.status(err.statusCode || 400).send({
          error: { code: 'REVOCATION_FAILED', message: err.message },
        });
      }
    },
  );

  // POST /api/v1/devices/:id/rotate-secret (Protected: Admin or Authenticated Device)
  app.post('/devices/:id/rotate-secret', async (request, reply) => {
    const { id } = request.params;
    const user = request.user;
    const secret =
      request.headers['x-device-secret'] ||
      (request.headers.authorization?.startsWith('Bearer ') && request.headers.authorization.substring(7).trim()) ||
      request.body?.deviceSecret ||
      request.body?.secret;

    const userRole = user ? normalizeRole(user.role) : null;

    const isUserAdmin =
      user && [Roles.ADMIN, Roles.SUPER_ADMIN].includes(userRole);

    const orgId = isUserAdmin
      ? userRole === Roles.SUPER_ADMIN
        ? null
        : user.organizationId
      : user?.organizationId;

    if (!isUserAdmin && !secret) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Current device secret or admin session required for rotation' },
      });
    }

    try {
      const result = await deviceService.rotateDeviceSecret(id, orgId, secret, isUserAdmin);
      return reply.send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: 'ROTATION_FAILED', message: err.message },
      });
    }
  });
}
