import { NotificationService } from './notifications.service.js';

export default async function notificationRoutes(fastify) {
  const notifyService = new NotificationService(fastify.prisma, fastify.log);

  if (!fastify.notifyService) {
    fastify.decorate('notifyService', notifyService);
  }

  // GET /api/v1/notifications
  fastify.get('/notifications', async (req) => {
    const { unreadOnly, severity, limit } = req.query || {};
    return notifyService.listNotifications({
      unreadOnly: unreadOnly === 'true',
      severity,
      limit: limit ? Number(limit) : 50,
    });
  });

  // GET /api/v1/notifications/summary
  fastify.get('/notifications/summary', async () => {
    return notifyService.getSummary();
  });

  // POST /api/v1/notifications
  fastify.post('/notifications', async (req, reply) => {
    const { type, severity, title, message, target, cooldownMinutes } = req.body || {};
    try {
      const result = await notifyService.createNotification({
        type,
        severity,
        title,
        message,
        target,
        cooldownMinutes,
      });
      return reply.status(result.suppressed ? 200 : 201).send(result);
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'NOTIFICATION_FAILED', message: err.message },
      });
    }
  });

  // PATCH /api/v1/notifications/:id/read
  fastify.patch('/notifications/:id/read', async (req, reply) => {
    const { id } = req.params;
    const notification = notifyService.markAsRead(id);
    if (!notification) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Notification not found' },
      });
    }
    return reply.send({ success: true, notification });
  });

  // POST /api/v1/notifications/mark-all-read
  fastify.post('/notifications/mark-all-read', async () => {
    return notifyService.markAllAsRead();
  });

  // DELETE /api/v1/notifications/:id
  fastify.delete('/notifications/:id', async (req, reply) => {
    const { id } = req.params;
    const deleted = notifyService.deleteNotification(id);
    if (!deleted) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Notification not found' },
      });
    }
    return reply.send({ success: true, deletedId: id });
  });
}
