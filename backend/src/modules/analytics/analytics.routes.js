import { AnalyticsService } from './analytics.service.js';

export default async function analyticsRoutes(fastify) {
  const analyticsService = new AnalyticsService(fastify.prisma, fastify.log);

  if (!fastify.analyticsService) {
    fastify.decorate('analyticsService', analyticsService);
  }

  // GET /api/v1/analytics/daily
  fastify.get('/analytics/daily', async (req) => {
    const { date } = req.query || {};
    return analyticsService.getDailyAnalytics({ date });
  });

  // GET /api/v1/analytics/weekly
  fastify.get('/analytics/weekly', async () => {
    return analyticsService.getWeeklyAnalytics();
  });

  // GET /api/v1/analytics/recommendations
  fastify.get('/analytics/recommendations', async () => {
    return analyticsService.getRecommendations();
  });

  // POST /api/v1/analytics/categories (Customize app / web category)
  fastify.post('/analytics/categories', async (req, reply) => {
    const { target, category } = req.body || {};
    try {
      const res = analyticsService.setCategory(target, category);
      return reply.send({ success: true, ...res });
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'INVALID_INPUT', message: err.message },
      });
    }
  });

  // GET /api/v1/analytics/export/csv (CSV report export)
  fastify.get('/analytics/export/csv', async (req, reply) => {
    const { startDate, endDate } = req.query || {};
    const csvContent = await analyticsService.exportCsv({ startDate, endDate });

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="digitalpulse-activity-report.csv"');
    return reply.send(csvContent);
  });
}
