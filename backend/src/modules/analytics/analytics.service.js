const CATEGORIES = ['productive', 'neutral', 'distracting'];

function requireOrganizationId(organizationId) {
  if (!organizationId) {
    const error = new Error('Authenticated organization context is required');
    error.statusCode = 403;
    throw error;
  }
}

function rangeForDate(date) {
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    const error = new Error('date must be an ISO calendar date');
    error.statusCode = 400;
    throw error;
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function clippedInterval(session, start, end) {
  const sessionStart = new Date(session.startedAt).getTime();
  const sessionEnd = new Date(session.endedAt).getTime();
  if (!Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd) || sessionEnd <= sessionStart) return null;
  const from = Math.max(start.getTime(), sessionStart);
  const to = Math.min(end.getTime(), sessionEnd);
  return to > from ? [from, to] : null;
}

function unionSeconds(intervals) {
  const sorted = intervals.filter(Boolean).sort((a, b) => a[0] - b[0]);
  let seconds = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current) current = interval;
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else {
      seconds += (current[1] - current[0]) / 1000;
      current = interval;
    }
  }
  if (current) seconds += (current[1] - current[0]) / 1000;
  return seconds;
}

// An organization report is a sum of employee timelines (person-hours), not
// one union across everyone in the organization. Keep a device fallback for
// historical rows whose user relation has been removed.
function groupedUnionSeconds(sessions, start, end, predicate) {
  const grouped = new Map();
  for (const session of sessions) {
    if (!predicate(session)) continue;
    const owner = session.device?.userId || session.deviceId || 'unknown-device';
    const intervals = grouped.get(owner) || [];
    intervals.push(clippedInterval(session, start, end));
    grouped.set(owner, intervals);
  }
  return [...grouped.values()].reduce((total, intervals) => total + unionSeconds(intervals), 0);
}

async function resolveEmployeeScope(prisma, { organizationId, userId, departmentId, role, employeeId }) {
  if (employeeId === undefined || employeeId === null || employeeId === '') return null;
  if (typeof employeeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(employeeId)) {
    const error = new Error('employeeId must be a valid employee UUID');
    error.statusCode = 400;
    throw error;
  }
  if (role === 'EMPLOYEE' && employeeId !== userId) {
    const error = new Error('Employees can only view their own reports');
    error.statusCode = 403;
    throw error;
  }
  if (!prisma?.user?.findFirst) {
    const error = new Error('Employee report scope is unavailable');
    error.statusCode = 503;
    throw error;
  }
  const where = { id: employeeId, organizationId };
  if (role === 'MANAGER') where.OR = [{ id: userId }, { managerId: userId }, ...(departmentId ? [{ departmentId }] : [])];
  const employee = await prisma.user.findFirst({ where, select: { id: true } });
  if (!employee) {
    const error = new Error('Employee is outside your reporting scope');
    error.statusCode = 403;
    throw error;
  }
  return employee.id;
}

export class AnalyticsService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Sets custom productivity category for app or domain.
   */
  async setCategory({ organizationId, target, category, targetType = 'APPLICATION' }) {
    requireOrganizationId(organizationId);
    if (!target) throw new Error('Target is required');
    if (!CATEGORIES.includes(category)) throw new Error('Invalid category');
    const clean = String(target).toLowerCase().trim();
    const kind = targetType === 'WEBSITE' ? 'WEBSITE' : 'APPLICATION';
    if (!this.prisma?.usageCategory?.upsert) {
      const error = new Error('Persistent category storage is unavailable');
      error.statusCode = 503;
      throw error;
    }
    return this.prisma.usageCategory.upsert({
      where: { organizationId_target_targetType: { organizationId, target: clean, targetType: kind } },
      create: { organizationId, target: clean, targetType: kind, category },
      update: { category },
      select: { target: true, targetType: true, category: true },
    });
  }

  /**
   * Gets category for a target.
   */
  async getCategory(organizationId, target, targetType) {
    if (!target || !this.prisma?.usageCategory?.findUnique) return 'neutral';
    const found = await this.prisma.usageCategory.findUnique({
      where: { organizationId_target_targetType: { organizationId, target: String(target).toLowerCase().trim(), targetType } },
      select: { category: true },
    });
    return found?.category || 'neutral';
  }

  /**
   * Computes daily breakdown for active, idle, productive, neutral, distracting.
   */
  async getDailyAnalytics({ organizationId, userId, departmentId, role, employeeId, date = new Date().toISOString().split('T')[0] } = {}) {
    requireOrganizationId(organizationId);
    let totalActiveSec = 0;
    let totalIdleSec = 0;
    let productiveSec = 0;
    let neutralSec = 0;
    let distractingSec = 0;

    const { start: startOfDay, end: endOfDay } = rangeForDate(date);

    if (this.prisma?.activitySession?.findMany) {
      try {
        const where = { organizationId, startedAt: { gte: startOfDay, lt: endOfDay } };
        const scopedEmployeeId = await resolveEmployeeScope(this.prisma, { organizationId, userId, departmentId, role, employeeId });
        if (role === 'MANAGER') {
          where.OR = [{ device: { user: { id: userId } } }, { device: { user: { managerId: userId } } }, ...(departmentId ? [{ device: { user: { departmentId } } }] : [])];
        }
        if (scopedEmployeeId) where.device = { userId: scopedEmployeeId };
        else if (role === 'EMPLOYEE') where.device = { userId };

        const sessions = await this.prisma.activitySession.findMany({
          where,
          include: { application: true, website: true, device: { select: { userId: true } } },
        });

        totalActiveSec = groupedUnionSeconds(sessions, startOfDay, endOfDay, (session) => session.type !== 'IDLE_SESSION');
        totalIdleSec = groupedUnionSeconds(sessions, startOfDay, endOfDay, (session) => session.type === 'IDLE_SESSION');

        for (const s of sessions) {
          if (s.type !== 'IDLE_SESSION') {
            const interval = clippedInterval(s, startOfDay, endOfDay);
            const dur = interval ? (interval[1] - interval[0]) / 1000 : 0;
            const targetName = s.application?.executableName || s.website?.domain || '';
            const targetType = s.application ? 'APPLICATION' : 'WEBSITE';
            const cat = await this.getCategory(organizationId, targetName, targetType);
            if (cat === 'productive') productiveSec += dur;
            else if (cat === 'distracting') distractingSec += dur;
            else neutralSec += dur;
          }
        }
      } catch (error) {
        this.logger.error?.({ err: error }, 'Daily analytics query failed');
        error.statusCode ||= 503;
        throw error;
      }
    } else {
      const error = new Error('Analytics database is unavailable');
      error.statusCode = 503;
      throw error;
    }

    // Baseline minimum fallback for fresh start
    return {
      date,
      totalActiveMinutes: Math.round(totalActiveSec / 60),
      totalIdleMinutes: Math.round(totalIdleSec / 60),
      breakdown: {
        productiveMinutes: Math.round(productiveSec / 60),
        neutralMinutes: Math.round(neutralSec / 60),
        distractingMinutes: Math.round(distractingSec / 60),
      },
      // Category durations can overlap across the app and browser collectors;
      // a single score would imply exclusive accounting we do not have.
      productivityScore: null,
    };
  }

  /**
   * Computes weekly or custom range usage trend with Android Wellbeing metrics.
   */
  async getWeeklyAnalytics({ organizationId, userId, departmentId, role, employeeId, range = '7d', startDate, endDate } = {}) {
    requireOrganizationId(organizationId);
    const days = [];
    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let numDays = 7;
    if (range === 'today') numDays = 1;
    else if (range === '30d') numDays = 30;

    const end = endDate ? new Date(`${endDate}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = startDate ? new Date(`${startDate}T00:00:00.000Z`) : new Date(end.getTime() - (numDays - 1) * 86400000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      const error = new Error('Invalid analytics date range');
      error.statusCode = 400;
      throw error;
    }
    const actualDays = Math.floor((end - start) / 86400000) + 1;
    for (let i = 0; i < actualDays; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const dateStr = d.toISOString().split('T')[0];
      const daily = await this.getDailyAnalytics({ organizationId, userId, departmentId, role, employeeId, date: dateStr });
      const dayOfWeek = dayNames[d.getDay()];
      days.push({
        ...daily,
        dayName: dayOfWeek,
        dayOfWeek: d.getDay(),
        totalScreenTimeMinutes: daily.totalActiveMinutes + daily.totalIdleMinutes,
      });
    }

    const currentWeekActive = days.reduce((acc, d) => acc + d.totalActiveMinutes, 0);
    const currentWeekIdle = days.reduce((acc, d) => acc + d.totalIdleMinutes, 0);
    const averageDailyMinutes = Math.round(currentWeekActive / Math.max(1, days.length));
    // Find highest and lowest usage days
    let highestUsageDay = days[0];
    let lowestUsageDay = days[0];
    for (const d of days) {
      if (d.totalActiveMinutes > highestUsageDay.totalActiveMinutes) highestUsageDay = d;
      if (d.totalActiveMinutes < lowestUsageDay.totalActiveMinutes) lowestUsageDay = d;
    }

    // Compute genuine prior period usage instead of hardcoded multiplier
    let prevPeriodActive = 0;
    for (let i = actualDays; i > 0; i--) {
      const d = new Date(start.getTime() - i * 86400000);
      const dateStr = d.toISOString().split('T')[0];
      const priorDaily = await this.getDailyAnalytics({ organizationId, userId, departmentId, role, employeeId, date: dateStr });
      prevPeriodActive += priorDaily.totalActiveMinutes;
    }

    const weekOverWeekDeltaPercent = prevPeriodActive > 0
      ? Math.round(((currentWeekActive - prevPeriodActive) / prevPeriodActive) * 100)
      : null;

    return {
      range,
      days,
      summary: {
        totalWeeklyActiveMinutes: currentWeekActive,
        totalWeeklyIdleMinutes: currentWeekIdle,
        totalWeeklyMonitoredMinutes: currentWeekActive + currentWeekIdle,
        averageDailyMinutes,
        highestUsageDay: {
          date: highestUsageDay?.date,
          dayName: highestUsageDay?.dayName,
          minutes: highestUsageDay?.totalActiveMinutes,
        },
        lowestUsageDay: {
          date: lowestUsageDay?.date,
          dayName: lowestUsageDay?.dayName,
          minutes: lowestUsageDay?.totalActiveMinutes,
        },
        weekOverWeekDeltaPercent,
        trend: weekOverWeekDeltaPercent === null
          ? 'unavailable'
          : (weekOverWeekDeltaPercent > 0 ? 'increasing' : (weekOverWeekDeltaPercent < 0 ? 'decreasing' : 'stable')),
      },
    };
  }

  /**
   * Generates actionable recommendations.
   */
  async getRecommendations(scope) {
    const daily = await this.getDailyAnalytics(scope);
    const recommendations = [];

    if (daily.totalActiveMinutes > 240) {
      recommendations.push({
        id: 'rec-screen-limit',
        severity: 'warning',
        title: 'Screen Time Goal Exceeded',
        message: `Total active time (${daily.totalActiveMinutes} mins) exceeded the recommended 4-hour limit. Consider scheduling breaks.`,
      });
    }

    if (daily.breakdown.distractingMinutes > 60) {
      recommendations.push({
        id: 'rec-distraction',
        severity: 'info',
        title: 'High Distraction Usage',
        message: `You spent ${daily.breakdown.distractingMinutes} minutes in distracting categories today. Try activating a 25-minute focus session.`,
      });
    }

    return { recommendations };
  }

  /**
   * Exports recorded sessions as CSV string.
   */
  async exportCsv({ organizationId, userId, departmentId, role, employeeId, startDate, endDate } = {}) {
    requireOrganizationId(organizationId);
    let rows = [
      ['Timestamp', 'Type', 'Target', 'DurationSeconds', 'ProductivityCategory'].join(','),
    ];

    if (this.prisma?.activitySession?.findMany) {
      try {
        const where = { organizationId };
        const scopedEmployeeId = await resolveEmployeeScope(this.prisma, { organizationId, userId, departmentId, role, employeeId });
        if (role === 'MANAGER') {
          where.OR = [{ device: { user: { id: userId } } }, { device: { user: { managerId: userId } } }, ...(departmentId ? [{ device: { user: { departmentId } } }] : [])];
        }
        if (scopedEmployeeId) where.device = { userId: scopedEmployeeId };
        else if (role === 'EMPLOYEE') where.device = { userId };
        if (startDate || endDate) {
          where.startedAt = {};
          if (startDate) where.startedAt.gte = rangeForDate(startDate).start;
          if (endDate) where.startedAt.lt = rangeForDate(endDate).end;
        }

        const sessions = await this.prisma.activitySession.findMany({
          where,
          take: 500,
          orderBy: { startedAt: 'desc' },
          include: { application: true, website: true },
        });

        for (const s of sessions) {
          const target = s.application?.executableName || s.website?.domain || 'system';
          const cat = await this.getCategory(organizationId, target, s.application ? 'APPLICATION' : 'WEBSITE');
          rows.push([
            s.startedAt.toISOString(),
            s.type,
            `"${target}"`,
            s.durationSeconds,
            cat,
          ].join(','));
        }
      } catch (error) {
        this.logger.error?.({ err: error }, 'Analytics export query failed');
        error.statusCode ||= 503;
        throw error;
      }
    } else {
      const error = new Error('Analytics database is unavailable');
      error.statusCode = 503;
      throw error;
    }

    return rows.join('\r\n');
  }
}

