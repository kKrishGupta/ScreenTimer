import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { activityEventSchema } from '@digitalpulse/contracts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import healthRoutes from './modules/health/health.routes.js';
import activityRoutes from './modules/activity/activity.routes.js';
import devicesRoutes from './modules/devices/devices.routes.js';
import screenRoutes from './modules/screen/screen.routes.js';
import plannerRoutes from './modules/planner/planner.routes.js';
import familyRoutes from './modules/family/family.routes.js';
import policyRoutes from './modules/policies/policies.routes.js';

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
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(activityRoutes);
      await api.register(devicesRoutes);
      await api.register(screenRoutes);
      await api.register(plannerRoutes);
      await api.register(familyRoutes);
      await api.register(policyRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

