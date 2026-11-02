import { DeviceService } from './devices.service.js';

export default async function devicesRoutes(app) {
  const deviceService = new DeviceService(app.prisma, app.log);

  // Expose on fastify instance
  if (!app.deviceService) {
    app.decorate('deviceService', deviceService);
  }

  // GET /api/v1/devices
  app.get('/devices', async (request, reply) => {
    const orgId = request.query?.organizationId;
    const devices = await deviceService.listDevices(orgId);
    return reply.send({ devices });
  });

  // POST /api/v1/devices/enrollment-tokens
  app.post('/devices/enrollment-tokens', async (request, reply) => {
    const { organizationId, userId, deviceKind, expiresInHours } = request.body || {};
    try {
      const tokenInfo = await deviceService.createEnrollmentToken({
        organizationId: organizationId || '00000000-0000-0000-0000-000000000000',
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
  });

  // POST /api/v1/devices/enroll
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

  // POST /api/v1/devices/:id/heartbeat
  app.post('/devices/:id/heartbeat', async (request, reply) => {
    const { id } = request.params;
    const { agentVersion, metrics } = request.body || {};
    try {
      const result = await deviceService.recordHeartbeat(id, { agentVersion, metrics });
      return reply.send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: 'HEARTBEAT_FAILED', message: err.message },
      });
    }
  });

  // POST /api/v1/devices/:id/revoke
  app.post('/devices/:id/revoke', async (request, reply) => {
    const { id } = request.params;
    try {
      const result = await deviceService.revokeDevice(id, 'Family Owner');
      return reply.send(result);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'REVOCATION_FAILED', message: err.message },
      });
    }
  });
}
