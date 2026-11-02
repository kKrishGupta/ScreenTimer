import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { activityEventSchema } from '@digitalpulse/contracts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter } from './middleware/rate-limiter.js';
import healthRoutes from './modules/health/health.routes.js';
import activityRoutes from './modules/activity/activity.routes.js';
import devicesRoutes from './modules/devices/devices.routes.js';
import screenRoutes from './modules/screen/screen.routes.js';
import plannerRoutes from './modules/planner/planner.routes.js';
import familyRoutes from './modules/family/family.routes.js';
import policyRoutes from './modules/policies/policies.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import analyticsRoutes from './modules/analytics/analytics.routes.js';
import privacyRoutes from './modules/privacy/privacy.routes.js';

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
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    },
    bodyLimit: 1024 * 1024, // 1 MiB: ample for a 500-event batch, bounded against abuse.
  });

  app.decorate('config', config);
  app.decorate('prisma', prisma);

  // Shared contract schemas are registered once and referenced by $id from route schemas.
  app.addSchema(activityEventSchema);

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onRequest', createRateLimiter({ maxRequests: 200 }));

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(activityRoutes);
      await api.register(devicesRoutes);
      await api.register(screenRoutes);
      await api.register(plannerRoutes);
      await api.register(familyRoutes);
      await api.register(policyRoutes);
      await api.register(notificationRoutes);
      await api.register(analyticsRoutes);
      await api.register(privacyRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

