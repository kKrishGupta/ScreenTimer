import crypto from 'node:crypto';

// In-memory notifications store and cooldown tracker
const notifications = [];
const cooldowns = new Map(); // key: deduplicationKey -> timestamp

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
  POLICY_MODIFIED: 'policy_modification',
};

export class NotificationService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Generates a notification with automatic deduplication and cooldown.
   */
  async createNotification({
    type,
    severity = NotificationSeverity.INFO,
    title,
    message,
    target = null,
    organizationId = '00000000-0000-0000-0000-000000000000',
    userId = null,
    cooldownMinutes = 5,
  }) {
    if (!title || !message) {
      throw new Error('Title and message are required for notifications');
    }

    // Deduplication key: type + target
    const dedupKey = `${type}:${target || 'global'}:${organizationId}`;
    const now = Date.now();
    const lastTriggered = cooldowns.get(dedupKey);

    if (lastTriggered && now - lastTriggered < cooldownMinutes * 60 * 1000) {
      // Cooldown active, suppress duplicate notification
      return { suppressed: true, reason: 'Cooldown active', dedupKey };
    }

    cooldowns.set(dedupKey, now);

    const notification = {
      id: crypto.randomUUID(),
      type: type || NotificationTypes.RESTRICTED_WEBSITE,
      severity: [NotificationSeverity.INFO, NotificationSeverity.WARNING, NotificationSeverity.CRITICAL].includes(severity)
        ? severity
        : NotificationSeverity.INFO,
      title: title.slice(0, 120),
      message: message.slice(0, 500),
      target: target ? target.slice(0, 100) : null,
      organizationId,
      userId,
      read: false,
      readAt: null,
      createdAt: new Date().toISOString(),
    };

    notifications.unshift(notification);
    if (notifications.length > 500) notifications.pop();

    return { suppressed: false, notification };
  }

  /**
   * Lists notifications with filters.
   */
  listNotifications({ unreadOnly = false, severity = null, limit = 50 }) {
    let result = [...notifications];

    if (unreadOnly) {
      result = result.filter((n) => !n.read);
    }
    if (severity) {
      result = result.filter((n) => n.severity === severity);
    }

    return {
      notifications: result.slice(0, limit),
      totalCount: notifications.length,
      unreadCount: notifications.filter((n) => !n.read).length,
    };
  }

  /**
   * Marks a notification as read.
   */
  markAsRead(id) {
    const item = notifications.find((n) => n.id === id);
    if (!item) return null;
    item.read = true;
    item.readAt = new Date().toISOString();
    return item;
  }

  /**
   * Marks all notifications as read.
   */
  markAllAsRead() {
    const now = new Date().toISOString();
    let updatedCount = 0;
    notifications.forEach((n) => {
      if (!n.read) {
        n.read = true;
        n.readAt = now;
        updatedCount++;
      }
    });
    return { success: true, updatedCount };
  }

  /**
   * Deletes a notification.
   */
  deleteNotification(id) {
    const index = notifications.findIndex((n) => n.id === id);
    if (index === -1) return false;
    notifications.splice(index, 1);
    return true;
  }

  /**
   * Returns a breakdown summary of unread alerts.
   */
  getSummary() {
    const unread = notifications.filter((n) => !n.read);
    return {
      totalUnread: unread.length,
      critical: unread.filter((n) => n.severity === NotificationSeverity.CRITICAL).length,
      warning: unread.filter((n) => n.severity === NotificationSeverity.WARNING).length,
      info: unread.filter((n) => n.severity === NotificationSeverity.INFO).length,
    };
  }
}
