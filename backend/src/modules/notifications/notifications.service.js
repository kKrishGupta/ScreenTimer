import crypto from 'node:crypto';

const fallbackNotifications = [];
const fallbackCooldowns = new Map();
const DEFAULT_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

export const NotificationSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

export const NotificationTypes = {
  RESTRICTED_WEBSITE: 'restricted_website_warning',
  RESTRICTED_APP: 'restricted_application_advisory',
  SCREEN_TIME_LIMIT: 'screen_time_limit_reached',
  FOCUS_STARTED: 'focus_session_started',
  FOCUS_COMPLETED: 'focus_session_completed',
  BREAK_REMINDER: 'break_reminder',
  DEVICE_OFFLINE: 'device_offline',
  DEVICE_RECONNECTED: 'device_reconnected',
  MONITORING_PAUSED: 'monitoring_paused',
  SCREENSHOT_CAPTURED: 'screenshot_session_started',
  LIVE_SHARE_STARTED: 'live_screen_sharing_started',
  LIVE_SHARE_ENDED: 'live_screen_sharing_ended',
  DEVICE_ENROLLED: 'device_enrollment',
  EMPLOYEE_SETUP_REMINDER: 'employee_setup_reminder',
  POLICY_MODIFIED: 'policy_modification',
};

export class NotificationService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  persistent() {
    return Boolean(this.prisma?.notification?.findMany);
  }

  requirePersistentStorage() {
    if (process.env.NODE_ENV === 'production' && !this.persistent()) {
      const error = new Error('Persistent notification storage is unavailable');
      error.statusCode = 503;
      throw error;
    }
  }

  async createNotification({
    type,
    severity = NotificationSeverity.INFO,
    title,
    message,
    target = null,
    organizationId = DEFAULT_ORGANIZATION_ID,
    userId = null,
    cooldownMinutes = 5,
  }) {
    this.requirePersistentStorage();
    if (!title || !message) throw new Error('Title and message are required for notifications');
    const normalizedType = type || NotificationTypes.RESTRICTED_WEBSITE;
    const normalizedSeverity = Object.values(NotificationSeverity).includes(severity)
      ? severity
      : NotificationSeverity.INFO;
    const now = new Date();
    const since = new Date(now.getTime() - cooldownMinutes * 60 * 1000);

    if (this.persistent()) {
      const recent = await this.prisma.notification.findFirst({
        where: {
          organizationId,
          type: normalizedType,
          target,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recent) {
        return { suppressed: true, reason: 'Cooldown active', dedupKey: `${normalizedType}:${target || 'global'}:${organizationId}` };
      }

      const notification = await this.prisma.notification.create({
        data: {
          organizationId,
          userId,
          type: normalizedType,
          severity: normalizedSeverity,
          title: title.slice(0, 120),
          message: message.slice(0, 500),
          target: target ? target.slice(0, 100) : null,
        },
      });
      return { suppressed: false, notification };
    }

    const dedupKey = `${normalizedType}:${target || 'global'}:${organizationId}`;
    const lastTriggered = fallbackCooldowns.get(dedupKey);
    if (lastTriggered && Date.now() - lastTriggered < cooldownMinutes * 60 * 1000) {
      return { suppressed: true, reason: 'Cooldown active', dedupKey };
    }
    fallbackCooldowns.set(dedupKey, Date.now());
    const notification = {
      id: crypto.randomUUID(),
      type: normalizedType,
      severity: normalizedSeverity,
      title: title.slice(0, 120),
      message: message.slice(0, 500),
      target: target ? target.slice(0, 100) : null,
      organizationId,
      userId,
      read: false,
      readAt: null,
      createdAt: now.toISOString(),
    };
    fallbackNotifications.unshift(notification);
    if (fallbackNotifications.length > 500) fallbackNotifications.pop();
    return { suppressed: false, notification };
  }

  async listNotifications({ organizationId = DEFAULT_ORGANIZATION_ID, userId = null, unreadOnly = false, severity = null, limit = 50 }) {
    this.requirePersistentStorage();
    const take = Math.max(1, Math.min(Number(limit) || 50, 100));
    if (this.persistent()) {
      const where = { organizationId };
      if (userId) where.OR = [{ userId }, { userId: null }];
      if (unreadOnly) where.read = false;
      if (severity) where.severity = severity;
      const [notifications, totalCount, unreadCount] = await Promise.all([
        this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
        this.prisma.notification.count({ where }),
        this.prisma.notification.count({ where: { ...where, read: false } }),
      ]);
      return { notifications, totalCount, unreadCount };
    }
    let result = fallbackNotifications.filter((n) => n.organizationId === organizationId);
    if (userId) result = result.filter((n) => n.userId === userId || !n.userId);
    if (unreadOnly) result = result.filter((n) => !n.read);
    if (severity) result = result.filter((n) => n.severity === severity);
    return {
      notifications: result.slice(0, take),
      totalCount: result.length,
      unreadCount: result.filter((n) => !n.read).length,
    };
  }

  async markAsRead(id, organizationId = DEFAULT_ORGANIZATION_ID) {
    this.requirePersistentStorage();
    if (this.persistent()) {
      const result = await this.prisma.notification.updateMany({
        where: { id, organizationId },
        data: { read: true, readAt: new Date() },
      });
      if (result.count === 0) return null;
      return this.prisma.notification.findUnique({ where: { id } });
    }
    const item = fallbackNotifications.find((n) => n.id === id && n.organizationId === organizationId);
    if (!item) return null;
    item.read = true;
    item.readAt = new Date().toISOString();
    return item;
  }

  async markAllAsRead(organizationId = DEFAULT_ORGANIZATION_ID) {
    this.requirePersistentStorage();
    if (this.persistent()) {
      const result = await this.prisma.notification.updateMany({
        where: { organizationId, read: false },
        data: { read: true, readAt: new Date() },
      });
      return { success: true, updatedCount: result.count };
    }
    const now = new Date().toISOString();
    const updatedCount = fallbackNotifications.filter((n) => n.organizationId === organizationId && !n.read)
      .reduce((count, n) => { n.read = true; n.readAt = now; return count + 1; }, 0);
    return { success: true, updatedCount };
  }

  async deleteNotification(id, organizationId = DEFAULT_ORGANIZATION_ID) {
    this.requirePersistentStorage();
    if (this.persistent()) {
      const result = await this.prisma.notification.deleteMany({ where: { id, organizationId } });
      return result.count > 0;
    }
    const index = fallbackNotifications.findIndex((n) => n.id === id && n.organizationId === organizationId);
    if (index === -1) return false;
    fallbackNotifications.splice(index, 1);
    return true;
  }

  async getSummary(organizationId = DEFAULT_ORGANIZATION_ID) {
    const { notifications } = await this.listNotifications({ organizationId, limit: 100 });
    const unread = notifications.filter((n) => !n.read);
    return {
      totalUnread: unread.length,
      critical: unread.filter((n) => n.severity === NotificationSeverity.CRITICAL).length,
      warning: unread.filter((n) => n.severity === NotificationSeverity.WARNING).length,
      info: unread.filter((n) => n.severity === NotificationSeverity.INFO).length,
    };
  }
}
