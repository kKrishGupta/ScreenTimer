import { AnalyticsService } from './analytics.service.js';
import { Roles, normalizeRole } from '../auth/auth.service.js';

export default async function analyticsRoutes(fastify) {
  const analyticsService = new AnalyticsService(fastify.prisma, fastify.log);

  if (!fastify.analyticsService) {
    fastify.decorate('analyticsService', analyticsService);
  }

  // GET /api/v1/analytics/daily
  fastify.get('/analytics/daily', async (req, reply) => {
    const { date, employeeId } = req.query || {};
    try {
      return await analyticsService.getDailyAnalytics({
        organizationId: req.user?.organizationId,
        userId: req.user?.id,
        departmentId: req.user?.departmentId,
        role: normalizeRole(req.user?.role),
        employeeId,
        date,
      });
    } catch (err) {
      return reply.status(err.statusCode || 503).send({ error: { code: err.statusCode === 403 ? 'FORBIDDEN' : err.statusCode === 400 ? 'INVALID_INPUT' : 'STORAGE_UNAVAILABLE', message: err.message } });
    }
  });

  // GET /api/v1/analytics/weekly
  fastify.get('/analytics/weekly', async (req, reply) => {
    try {
      return await analyticsService.getWeeklyAnalytics({
        organizationId: req.user?.organizationId,
        userId: req.user?.id,
        departmentId: req.user?.departmentId,
        role: normalizeRole(req.user?.role),
        ...(req.query || {}),
      });
    } catch (err) {
      return reply.status(err.statusCode || 503).send({ error: { code: err.statusCode === 403 ? 'FORBIDDEN' : err.statusCode === 400 ? 'INVALID_INPUT' : 'STORAGE_UNAVAILABLE', message: err.message } });
    }
  });

  // GET /api/v1/analytics/recommendations
  fastify.get('/analytics/recommendations', async (req) => {
    return analyticsService.getRecommendations({
      organizationId: req.user?.organizationId,
      userId: req.user?.id,
      departmentId: req.user?.departmentId,
      role: normalizeRole(req.user?.role),
    });
  });

  // POST /api/v1/analytics/categories (Customize app / web category)
  fastify.post('/analytics/categories', { preHandler: fastify.authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN) }, async (req, reply) => {
    const { target, category, targetType } = req.body || {};
    try {
      const res = await analyticsService.setCategory({ organizationId: req.user?.organizationId, target, category, targetType });
      return reply.send({ success: true, ...res });
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: err.statusCode === 503 ? 'STORAGE_UNAVAILABLE' : 'INVALID_INPUT', message: err.message },
      });
    }
  });

  // GET /api/v1/analytics/export/csv (CSV report export)
  fastify.get('/analytics/export/csv', async (req, reply) => {
    const { startDate, endDate, employeeId } = req.query || {};
    let csvContent;
    try { csvContent = await analyticsService.exportCsv({
      organizationId: req.user?.organizationId,
      userId: req.user?.id,
      departmentId: req.user?.departmentId,
      role: normalizeRole(req.user?.role),
      employeeId,
      startDate,
      endDate,
    }); } catch (err) {
      return reply.status(err.statusCode || 503).send({ error: { code: err.statusCode === 403 ? 'FORBIDDEN' : err.statusCode === 400 ? 'INVALID_INPUT' : 'STORAGE_UNAVAILABLE', message: err.message } });
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="digitalpulse-activity-report.csv"');
    return reply.send(csvContent);
  });
}

