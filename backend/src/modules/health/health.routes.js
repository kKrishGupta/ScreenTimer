import { probeDatabase } from '../../database/prisma.js';
import { healthResponseSchema } from './health.schemas.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

/**
 * Health module: GET /api/v1/health
 * Returns 200 when the API and database are reachable, 503 when degraded.
 *
 * @param {import('fastify').FastifyInstance} app
 */
export default async function healthRoutes(app) {
  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } } },
    async (_request, reply) => {
      const database = await probeDatabase(app.prisma);
      const healthy = database.status === 'up';
      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        service: 'digitalpulse-backend',
        version: VERSION,
        time: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        database,
      });
    },
  );
}

