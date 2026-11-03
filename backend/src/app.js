import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { activityEventSchema } from '@digitalpulse/contracts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter } from './middleware/rate-limiter.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DeviceService } from './modules/devices/devices.service.js';
import { createAuthMiddleware } from './middleware/auth.middleware.js';
import healthRoutes from './modules/health/health.routes.js';
import activityRoutes from './modules/activity/activity.routes.js';
import devicesRoutes from './modules/devices/devices.routes.js';
import screenRoutes from './modules/screen/screen.routes.js';
import plannerRoutes from './modules/planner/planner.routes.js';
import employeeRoutes from './modules/employees/employees.routes.js';
import policyRoutes from './modules/policies/policies.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { NotificationService } from './modules/notifications/notifications.service.js';
import analyticsRoutes from './modules/analytics/analytics.routes.js';
import privacyRoutes from './modules/privacy/privacy.routes.js';
import { readSessionToken, SESSION_COOKIE_NAME } from './modules/auth/session-cookie.js';

/**
 * Builds the Fastify application without starting a listener, so tests can use
 * `app.inject()` with an injected (real or fake) Prisma client.
 *
 * @param {object} options
 * @param {ReturnType<import('./shared/config.js').loadConfig>} options.config
 * @param {import('@prisma/client').PrismaClient} options.prisma
 * @param {boolean | object} [options.logger]
 */
export async function buildApp({ config, prisma, logger }) {
  const app = Fastify({
    trustProxy: Boolean(config.trustProxy),
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
    },
    bodyLimit: 1024 * 1024, // 1 MiB: ample for a 500-event batch, bounded against abuse.
  });

  app.decorate('config', config);
  app.decorate('prisma', prisma);

  const authService = new AuthService(prisma, app.log, config);
  const deviceService = new DeviceService(prisma, app.log);
  const authMiddleware = createAuthMiddleware(authService, deviceService);

  app.decorate('authService', authService);
  app.decorate('deviceService', deviceService);
  app.decorate('notifyService', new NotificationService(prisma, app.log));
  app.decorate('authMiddleware', authMiddleware);

  // Shared contract schemas are registered once and referenced by $id from route schemas.
  app.addSchema(activityEventSchema);

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onRequest', async (req, reply) => {
    const hasSessionCookie = req.headers.cookie?.split(';').some((part) => part.trim().startsWith(`${SESSION_COOKIE_NAME}=`));
    if (!hasSessionCookie || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin || !config.corsOrigins.includes(origin)) {
      return reply.code(403).send({ error: { code: 'CSRF_ORIGIN_REJECTED', message: 'This request origin is not allowed.' } });
    }
  });
  app.addHook('onRequest', createRateLimiter({ maxRequests: 200 }));

  await app.register(
    async (api) => {
      // Global authentication preHandler enforcing explicit allowlist and RBAC / Device boundary
      api.addHook('preHandler', async (req, reply) => {
        const urlPath = req.url.split('?')[0];

        // Explicit public allowlist (Task 1)
        const isPublic = [
          '/api/v1/health',
          '/api/v1/auth/register',
          '/api/v1/auth/login',
          '/api/v1/auth/logout',
          '/api/v1/auth/roles',
          '/api/v1/auth/reset-password-request',
          '/api/v1/auth/reset-password-confirm',
          '/api/v1/auth/invitations/accept',
          '/api/v1/invitations/accept',
          '/api/v1/auth/invitations/validate',
          '/api/v1/invitations/validate',
          '/api/v1/devices/enroll',
          '/api/v1/privacy/overview',
        ].includes(urlPath);

        if (isPublic) {
          const token = readSessionToken(req);
          const session = token ? await authService.validateSession(token) : null;
          if (session) {
            req.user = session.user;
            req.session = session;
            req.organizationId = session.user.organizationId;
          }
          return;
        }

        // Device ingestion & heartbeat routes (Task 4)
        const isDeviceIngest = urlPath === '/api/v1/activity/events/batch' || urlPath === '/api/v1/activity/events';
        const isDeviceHeartbeat = /^\/api\/v1\/devices\/[^/]+\/heartbeat$/.test(urlPath);

        if (isDeviceIngest || isDeviceHeartbeat) {
          return authMiddleware.authenticateDevice(req, reply);
        }

        // Device secret rotation allows device secret OR admin session
        if (/^\/api\/v1\/devices\/[^/]+\/rotate-secret$/.test(urlPath)) {
          const authHeader = req.headers.authorization;
          if (authHeader?.startsWith('Bearer ') && !authHeader.substring(7).trim().startsWith('dp_sec_')) {
            return authMiddleware.authenticate(req, reply);
          }
          return authMiddleware.authenticateDevice(req, reply);
        }

        // Browser policy synchronization is authenticated with the enrolled
        // device secret and scoped to that device's organization.
        if (urlPath === '/api/v1/policies/declarative-rules' && req.headers['x-device-secret']) {
          return authMiddleware.authenticateDevice(req, reply);
        }

        // Screen capture ingestion can be called by agent using device secret or authorized user
        if (urlPath === '/api/v1/screen/capture' && (req.headers['x-device-secret'] || req.headers.authorization?.startsWith('Bearer dp_sec_'))) {
          return authMiddleware.authenticateDevice(req, reply);
        }

        // All other routes require active user authentication (Task 1, 2, 3)
        return authMiddleware.authenticate(req, reply);
      });

      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(activityRoutes);
      await api.register(devicesRoutes);
      await api.register(screenRoutes);
      await api.register(plannerRoutes);
      await api.register(employeeRoutes);
      await api.register(policyRoutes);
      await api.register(notificationRoutes);
      await api.register(analyticsRoutes);
      await api.register(privacyRoutes);
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
  const setupReminderRoute = '/api/v1/employees/:employeeId/setup-reminder';
  if (!app.hasRoute({ method: 'POST', url: setupReminderRoute })) {
    throw new Error(`Required route was not registered: POST ${setupReminderRoute}`);
  }
  app.log.info({ method: 'POST', route: setupReminderRoute }, 'Employee setup reminder route registered');

  return app;
}
