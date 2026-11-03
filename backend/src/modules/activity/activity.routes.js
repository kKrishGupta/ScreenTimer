import { activityBatchSchema } from '@digitalpulse/contracts';
import { badRequest } from '../../shared/errors.js';
import { Roles, normalizeRole } from '../auth/auth.service.js';
import { getMonitoringAuthorization, isEventWithinSchedule } from '../devices/monitoring-authorization.js';

const ACTIVITY_TYPE_MAP = {
  app_session: 'APP_SESSION',
  web_session: 'WEB_SESSION',
  idle_session: 'IDLE_SESSION',
};

function unionSecondsForType(sessions, types) {
  const intervals = sessions
    .filter((session) => types.includes(session.type))
    .map((session) => [new Date(session.startedAt).getTime(), new Date(session.endedAt).getTime()])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let seconds = 0;
  let current = null;
  for (const interval of intervals) {
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

async function getCategoryOverride(prisma, organizationId, target, targetType) {
  if (!organizationId || !target || !prisma?.usageCategory?.findUnique) return null;
  const row = await prisma.usageCategory.findUnique({
    where: { organizationId_target_targetType: { organizationId, target: String(target).toLowerCase().trim(), targetType } },
    select: { category: true },
  });
  return row?.category || null;
}

const KNOWN_BASE_DOMAINS = [
  'instagram.com',
  'whatsapp.com',
  'facebook.com',
  'reddit.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'linkedin.com',
  'google.com',
  'github.com',
];

export function categorizeTarget(nameOrDomain) {
  if (!nameOrDomain) return 'Other';
  const s = String(nameOrDomain).toLowerCase().trim();
  if (/code|cursor|terminal|powershell|cmd|devenv|github|stackoverflow|notion|jira|confluence|gitlab|docker|postman|figma|studio|bash/.test(s)) return 'Productivity';
  if (/khanacademy|wikipedia|coursera|edx|udemy|duolingo|canvas|classroom|quizlet/.test(s)) return 'Education';
  if (/teams|slack|discord|whatsapp|telegram|signal|outlook|mail|zoom|skype/.test(s)) return 'Communication';
  if (/instagram|tiktok|facebook|twitter|x\.com|reddit|snapchat|pinterest|linkedin/.test(s)) return 'Social Media';
  if (/spotify|netflix|youtube|twitch|roblox|steam|hulu|disney|epicgames|primevideo|game/.test(s)) return 'Entertainment';
  if (/bank|paypal|stripe|chase|wellsfargo|fidelity|coinbase|robinhood/.test(s)) return 'Finance';
  if (/amazon|ebay|walmart|aliexpress|shopify|target|etsy/.test(s)) return 'Shopping';
  return 'Other';
}

export function normalizeDomain(rawDomain) {
  if (!rawDomain) return '';
  let d = String(rawDomain).toLowerCase().trim().split(':')[0];
  if (d.startsWith('www.')) d = d.slice(4);
  for (const base of KNOWN_BASE_DOMAINS) {
    if (d === base || d.endsWith('.' + base)) {
      return base;
    }
  }
  return d;
}

/**
 * Builds query scope enforcing multi-tenant isolation and role-based permissions.
 */
async function buildActivityScope(request, prisma) {
  const user = request.user;
  const orgId = user?.role === Roles.SUPER_ADMIN && request.query?.organizationId
    ? request.query.organizationId
    : (user?.organizationId || request.organizationId);

  if (request.query?.organizationId && normalizeRole(user?.role) !== Roles.SUPER_ADMIN && request.query.organizationId !== orgId) {
    const err = new Error('Access denied: cross-tenant access prohibited');
    err.statusCode = 403;
    throw err;
  }

  const where = orgId ? { organizationId: orgId } : {};
  const userRole = user ? normalizeRole(user.role) : null;

  if (userRole === Roles.EMPLOYEE && user) {
    if (request.query?.userId && request.query.userId !== user.id) {
      const err = new Error('Employees may only access their own activity records');
      err.statusCode = 403;
      throw err;
    }
    where.device = { userId: user.id };
  } else if (userRole === Roles.MANAGER && user) {
    if (request.query?.userId) {
      if (!prisma?.user?.findFirst) {
        const err = new Error('Manager employee scope could not be verified');
        err.statusCode = 503;
        throw err;
      }
      const target = await prisma.user.findFirst({
        where: {
          id: request.query.userId,
          organizationId: orgId,
          OR: [{ id: user.id }, { managerId: user.id }, ...(user.departmentId ? [{ departmentId: user.departmentId }] : [])],
        },
        select: { id: true },
      });
      if (!target) {
        const err = new Error('Managers may only access employees within their assigned scope');
        err.statusCode = 403;
        throw err;
      }
      where.device = { userId: request.query.userId };
    } else where.OR = [{ device: { user: { id: user.id } } }, { device: { user: { managerId: user.id } } }, ...(user.departmentId ? [{ device: { user: { departmentId: user.departmentId } } }] : [])];
  } else if (request.query?.userId) {
    where.device = { userId: request.query.userId };
  }

  if (request.query?.deviceId) {
    if (userRole === Roles.EMPLOYEE && prisma?.device?.findUnique) {
      try {
        const dev = await prisma.device.findUnique({ where: { id: request.query.deviceId } });
        if (dev && dev.userId && dev.userId !== user.id) {
          const err = new Error('Employees may only access their own devices');
          err.statusCode = 403;
          throw err;
        }
      } catch (e) {
        if (e.statusCode) throw e;
      }
    }
    where.deviceId = request.query.deviceId;
  }

  return { where, orgId };
}

export default async function activityRoutes(app) {
  // POST /api/v1/activity/events/batch
  app.post(
    '/activity/events/batch',
    {
      schema: {
        body: activityBatchSchema,
      },
    },
    async (request, reply) => {
      const { device: devInfo, events } = request.body;
      const prisma = app.prisma;

      // Extract device credentials
      const secret =
        request.headers['x-device-secret'] ||
        (request.headers.authorization?.startsWith('Bearer ') && request.headers.authorization.substring(7).trim()) ||
        devInfo.secret ||
        request.body?.deviceSecret;

      // Device identity and tenant scope come from the authenticated device
      // record. Never trust the collector's submitted kind or an ambient
      // development organization when persisting production activity.
      if (!app.deviceService?.validateDeviceCredentials) {
        return reply.status(503).send({ error: { code: 'DEVICE_AUTH_UNAVAILABLE', message: 'Device authentication is unavailable' } });
      }
      const check = await app.deviceService.validateDeviceCredentials(devInfo.id, secret);
      if (!check.valid) {
        if (check.code === 'DEVICE_REVOKED') {
          return reply.status(403).send({
            error: {
              code: 'DEVICE_REVOKED',
              message: 'This device has been revoked by an administrator',
            },
          });
        }
        return reply.status(check.code === 'STORAGE_UNAVAILABLE' ? 503 : 401).send({
          error: {
            code: check.code || 'UNAUTHORIZED',
            message: check.message || 'Invalid or missing device credentials',
          },
        });
      }
      const authenticatedDevice = check.device;

      if (!authenticatedDevice?.organizationId) {
        return reply.status(403).send({ error: { code: 'DEVICE_ORGANIZATION_REQUIRED', message: 'The enrolled device has no organization scope' } });
      }

      if (app.deviceService && !app.deviceService.isDeviceAllowed(devInfo.id)) {
        return reply.status(403).send({ error: { code: 'DEVICE_REVOKED', message: 'This device has been revoked by an administrator' } });
      }

      if (events.some((event) => event.deviceId !== authenticatedDevice.id)) {
        return reply.status(400).send({ error: { code: 'DEVICE_ID_MISMATCH', message: 'Every activity event must belong to the authenticated device' } });
      }

      let owner = null;
      if (authenticatedDevice.userId) {
        if (!prisma?.user?.findUnique) {
          return reply.status(503).send({ error: { code: 'EMPLOYEE_SCOPE_UNAVAILABLE', message: 'The enrolled employee status could not be verified' } });
        }
        try {
          owner = await prisma.user.findUnique({
            where: { id: authenticatedDevice.userId },
            include: { organization: { select: { timezone: true } } },
          });
        } catch (error) {
          app.log.error({ err: error }, 'Failed to verify employee authorization for device activity');
          return reply.status(503).send({ error: { code: 'EMPLOYEE_SCOPE_UNAVAILABLE', message: 'The enrolled employee status could not be verified' } });
        }
        if (!owner || owner.organizationId !== authenticatedDevice.organizationId) {
          return reply.status(403).send({ error: { code: 'MONITORING_NOT_AUTHORIZED', message: 'The enrolled account is no longer available in this organization' } });
        }
        const authorization = getMonitoringAuthorization(owner, new Date());
        if (!authorization.allowed) {
          return reply.status(403).send({
            error: { code: authorization.reason || 'MONITORING_NOT_AUTHORIZED', message: 'Monitoring is paused until the account has valid consent, authorization, and an active schedule.' },
            monitoring: authorization,
          });
        }
      } else {
        return reply.status(403).send({ error: { code: 'EMPLOYEE_SCOPE_REQUIRED', message: 'Monitoring is only available for an account explicitly assigned to this device' } });
      }

      const org = { id: authenticatedDevice.organizationId };

      // 2. Update metadata on the credential-verified device identity.
      const collectorKind = String(authenticatedDevice.kind || '').toUpperCase();
      if (!['DESKTOP_AGENT', 'BROWSER_EXTENSION'].includes(collectorKind)) {
        return reply.status(403).send({ error: { code: 'INVALID_DEVICE_KIND', message: 'The authenticated device has an unsupported collector kind' } });
      }
      const now = new Date();

      const deviceMetadata = {
        name: devInfo.name,
        platform: devInfo.platform,
        browser: devInfo.browser || null,
        agentVersion: devInfo.agentVersion || null,
        lastSyncAt: now,
      };
      if (prisma?.device?.update) {
        await prisma.device.update({ where: { id: authenticatedDevice.id }, data: deviceMetadata });
      } else if (process.env.NODE_ENV !== 'production' && prisma?.device?.upsert) {
        // Test/dev adapters may keep the verified test device in memory. This
        // branch is never used for production device registration.
        await prisma.device.upsert({
          where: { id: authenticatedDevice.id },
          update: deviceMetadata,
          create: {
            id: authenticatedDevice.id,
            organizationId: org.id,
            userId: authenticatedDevice.userId || null,
            kind: collectorKind,
            secretHash: authenticatedDevice.secretHash,
            secretSalt: authenticatedDevice.secretSalt,
            isRevoked: false,
            lastSeenAt: null,
            ...deviceMetadata,
          },
        });
      } else {
        return reply.status(503).send({ error: { code: 'DEVICE_STORAGE_UNAVAILABLE', message: 'The enrolled device could not be updated' } });
      }

      // 3. Process events with strict idempotency (deduplication)
      let accepted = 0;
      let deduplicated = 0;
      let rejected = 0;
      const acceptedEventIds = [];
      const deduplicatedEventIds = [];
      const rejectedEventIds = [];
      const consentAt = owner ? new Date(owner.monitoringConsentAt).getTime() : 0;

      for (const event of events) {
        if (!owner || new Date(event.startedAt).getTime() < consentAt || !isEventWithinSchedule(owner, event.startedAt, event.endedAt)) {
          rejected++;
          rejectedEventIds.push(event.eventId);
          continue;
        }
        // Check for idempotency key
        const existing = await prisma.activityEvent.findUnique({
          where: {
            deviceId_eventId: {
              deviceId: event.deviceId,
              eventId: event.eventId,
            },
          },
        });

        if (existing) {
          deduplicated++;
          deduplicatedEventIds.push(event.eventId);
          continue;
        }

        const eventType = ACTIVITY_TYPE_MAP[event.type];
        if (!eventType) continue;

        let applicationId = null;
        let websiteId = null;

        // Resolve Application if app session
        if (event.app) {
          const exeLower = event.app.executable.toLowerCase();
          const application = await prisma.application.upsert({
            where: {
              organizationId_executableName: {
                organizationId: org.id,
                executableName: exeLower,
              },
            },
            update: {
              displayName: event.app.name,
            },
            create: {
              organizationId: org.id,
              executableName: exeLower,
              displayName: event.app.name,
            },
          });
          applicationId = application.id;
        }

        // Resolve Website if web session
        if (event.web) {
          const domainNormalized = normalizeDomain(event.web.domain);
          const website = await prisma.website.upsert({
            where: {
              organizationId_domain: {
                organizationId: org.id,
                domain: domainNormalized,
              },
            },
            update: {},
            create: {
              organizationId: org.id,
              domain: domainNormalized,
            },
          });
          websiteId = website.id;
        }

        // Insert raw event and normalized session in a transaction
        await prisma.$transaction(async (tx) => {
          const rawEvent = await tx.activityEvent.create({
            data: {
              organizationId: org.id,
              deviceId: event.deviceId,
              eventId: event.eventId,
              schemaVersion: event.schemaVersion,
              source: collectorKind,
              type: eventType,
              payload: event,
            },
          });

          await tx.activitySession.create({
            data: {
              organizationId: org.id,
              deviceId: event.deviceId,
              activityEventId: rawEvent.id,
              type: eventType,
              source: collectorKind,
              applicationId,
              websiteId,
              processId: event.app?.processId ?? null,
              browser: event.web?.browser ?? null,
              startedAt: new Date(event.startedAt),
              endedAt: new Date(event.endedAt),
              durationSeconds: event.durationSeconds,
            },
          });
        });

        accepted++;
        acceptedEventIds.push(event.eventId);
      }

      return reply.send({ accepted, deduplicated, rejected, acceptedEventIds, deduplicatedEventIds, rejectedEventIds });
    },
  );

  // GET /api/v1/activity/timeline
  app.get('/activity/timeline', async (request, reply) => {
    const {
      limit = '50',
      offset = '0',
      from,
      to,
      deviceId,
    } = request.query;
    const prisma = app.prisma;

    let scopeWhere = {};
    try {
      const scope = await buildActivityScope(request, prisma);
      scopeWhere = scope.where;
    } catch (err) {
      return reply.status(err.statusCode || 403).send({
        error: { code: 'FORBIDDEN', message: err.message },
      });
    }

    const take = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
    const skip = Math.max(0, parseInt(offset, 10) || 0);

    const where = { ...scopeWhere };
    if (deviceId) where.deviceId = deviceId;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    try {
      const [sessions, total] = await Promise.all([
        prisma.activitySession.findMany({
          where,
          take,
          skip,
          orderBy: { startedAt: 'desc' },
          include: {
            application: { select: { displayName: true, executableName: true } },
            website: { select: { domain: true } },
            device: { select: { name: true, kind: true } },
          },
        }),
        prisma.activitySession.count({ where }),
      ]);

      const mappedSessions = sessions.map((s) => {
        const typeLower = s.type === 'APP_SESSION' ? 'app_session' : s.type === 'WEB_SESSION' ? 'web_session' : 'idle_session';
        const appData = s.application
          ? {
              name: s.application.displayName,
              executable: s.application.executableName,
              processId: s.processId,
            }
          : null;
        const webData = s.website
          ? {
              domain: normalizeDomain(s.website.domain),
              browser: s.browser,
            }
          : null;

        return {
          id: s.id,
          type: typeLower,
          source: s.source ? s.source.toLowerCase() : 'desktop_agent',
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt.toISOString(),
          durationSeconds: s.durationSeconds,
          app: appData,
          application: appData,
          web: webData,
          website: webData,
          deviceName: s.device?.name,
        };
      });

      return reply.send({
        events: mappedSessions,
        sessions: mappedSessions,
        total,
        limit: take,
        offset: skip,
      });
    } catch (err) {
      app.log.error({ err }, 'Failed to fetch timeline');
      return reply.status(503).send({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Activity data is temporarily unavailable' } });
    }
  });

  // GET /api/v1/activity/apps
  app.get('/activity/apps', async (request, reply) => {
    const { from, to, date, deviceId } = request.query;
    const prisma = app.prisma;

    let scopeWhere = {};
    try {
      const scope = await buildActivityScope(request, prisma);
      scopeWhere = scope.where;
    } catch (err) {
      return reply.status(err.statusCode || 403).send({
        error: { code: 'FORBIDDEN', message: err.message },
      });
    }

    const where = { ...scopeWhere, type: 'APP_SESSION' };
    if (deviceId) where.deviceId = deviceId;
    if (date && !from && !to) {
      where.startedAt = {
        gte: new Date(`${date}T00:00:00.000Z`),
        lte: new Date(`${date}T23:59:59.999Z`),
      };
    } else if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    try {
      const sessions = await prisma.activitySession.findMany({
        where,
        include: {
          application: { select: { displayName: true, executableName: true } },
        },
      });

      const appMap = new Map();
      let totalSecondsAll = 0;

      for (const s of sessions) {
        if (!s.application) continue;
        const key = s.application.executableName;
        totalSecondsAll += s.durationSeconds;

        if (!appMap.has(key)) {
          const category = await getCategoryOverride(prisma, scopeWhere.organizationId, key || s.application.displayName, 'APPLICATION') || categorizeTarget(key || s.application.displayName);
          appMap.set(key, {
            name: s.application.displayName,
            executable: s.application.executableName,
            category,
            totalSeconds: 0,
            sessionCount: 0,
          });
        }
        const entry = appMap.get(key);
        entry.totalSeconds += s.durationSeconds;
        entry.sessionCount++;
      }

      const appsList = Array.from(appMap.values())
        .map((item) => ({
          ...item,
          durationSeconds: Math.round(item.totalSeconds),
          percentage:
            totalSecondsAll > 0
              ? Math.round((item.totalSeconds / totalSecondsAll) * 1000) / 10
              : 0,
        }))
        .sort((a, b) => b.totalSeconds - a.totalSeconds);

      return reply.send({
        totalSeconds: totalSecondsAll,
        apps: appsList,
        applications: appsList,
      });
    } catch (err) {
      app.log.error({ err }, 'Failed to fetch application analytics');
      return reply.status(503).send({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Application activity is temporarily unavailable' } });
    }
  });

  // GET /api/v1/activity/websites
  app.get('/activity/websites', async (request, reply) => {
    const { from, to, date, deviceId } = request.query;
    const prisma = app.prisma;

    let scopeWhere = {};
    try {
      const scope = await buildActivityScope(request, prisma);
      scopeWhere = scope.where;
    } catch (err) {
      return reply.status(err.statusCode || 403).send({
        error: { code: 'FORBIDDEN', message: err.message },
      });
    }

    const where = { ...scopeWhere, type: 'WEB_SESSION' };
    if (deviceId) where.deviceId = deviceId;
    if (date && !from && !to) {
      where.startedAt = {
        gte: new Date(`${date}T00:00:00.000Z`),
        lte: new Date(`${date}T23:59:59.999Z`),
      };
    } else if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    try {
      const sessions = await prisma.activitySession.findMany({
        where,
        include: {
          website: { select: { domain: true } },
        },
      });

      const webMap = new Map();
      let totalSecondsAll = 0;

      for (const s of sessions) {
        if (!s.website) continue;
        const key = normalizeDomain(s.website.domain);
        totalSecondsAll += s.durationSeconds;

        if (!webMap.has(key)) {
          const category = await getCategoryOverride(prisma, scopeWhere.organizationId, key, 'WEBSITE') || categorizeTarget(key);
          webMap.set(key, {
            domain: key,
            category,
            totalSeconds: 0,
            visitCount: 0,
          });
        }
        const entry = webMap.get(key);
        entry.totalSeconds += s.durationSeconds;
        entry.visitCount++;
      }

      const websitesList = Array.from(webMap.values())
        .map((item) => ({
          ...item,
          durationSeconds: Math.round(item.totalSeconds),
          percentage:
            totalSecondsAll > 0
              ? Math.round((item.totalSeconds / totalSecondsAll) * 1000) / 10
              : 0,
        }))
        .sort((a, b) => b.totalSeconds - a.totalSeconds);

      return reply.send({
        totalSeconds: totalSecondsAll,
        websites: websitesList,
      });
    } catch (err) {
      app.log.error({ err }, 'Failed to fetch website analytics');
      return reply.status(503).send({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Website activity is temporarily unavailable' } });
    }
  });

  // GET /api/v1/activity/summary
  app.get('/activity/summary', async (request, reply) => {
    const { deviceId, from, to, date } = request.query;
    const prisma = app.prisma;

    let scopeWhere = {};
    try {
      const scope = await buildActivityScope(request, prisma);
      scopeWhere = scope.where;
    } catch (err) {
      return reply.status(err.statusCode || 403).send({
        error: { code: 'FORBIDDEN', message: err.message },
      });
    }

    let whereStartedAt = {};
    if (date) {
      whereStartedAt = {
        gte: new Date(`${date}T00:00:00.000Z`),
        lte: new Date(`${date}T23:59:59.999Z`),
      };
    } else if (from || to) {
      if (from) whereStartedAt.gte = new Date(from);
      if (to) whereStartedAt.lte = new Date(to);
    } else {
      const startOfToday = new Date();
      startOfToday.setUTCHours(0, 0, 0, 0);
      whereStartedAt = { gte: startOfToday };
    }

    const where = { ...scopeWhere, startedAt: whereStartedAt };
    if (deviceId) where.deviceId = deviceId;

    try {
      const sessions = await prisma.activitySession.findMany({
        where,
        include: {
          application: { select: { displayName: true } },
          website: { select: { domain: true } },
        },
      });

      const activeSeconds = unionSecondsForType(sessions, ['APP_SESSION', 'WEB_SESSION']);
      const idleSeconds = unionSecondsForType(sessions, ['IDLE_SESSION']);
      const observedSeconds = unionSecondsForType(sessions, ['APP_SESSION', 'WEB_SESSION', 'IDLE_SESSION']);
      let appSessionCount = 0;
      let webSessionCount = 0;
      let idleSessionCount = 0;
      const appUsage = new Map();
      const webUsage = new Map();

      for (const s of sessions) {
        if (s.type === 'IDLE_SESSION') {
          idleSessionCount++;
        } else {
          if (s.type === 'APP_SESSION') {
            appSessionCount++;
            if (s.application) {
              const name = s.application.displayName;
              appUsage.set(name, (appUsage.get(name) || 0) + s.durationSeconds);
            }
          } else if (s.type === 'WEB_SESSION') {
            webSessionCount++;
            if (s.website) {
              const domain = normalizeDomain(s.website.domain);
              webUsage.set(domain, (webUsage.get(domain) || 0) + s.durationSeconds);
            }
          }
        }
      }

      const sortedApps = Array.from(appUsage.entries()).sort((a, b) => b[1] - a[1]);
      const topAppEntry = sortedApps[0] ? { name: sortedApps[0][0], durationSeconds: sortedApps[0][1] } : null;

      const sortedWebsites = Array.from(webUsage.entries()).sort((a, b) => b[1] - a[1]);
      const topDomainEntry = sortedWebsites[0] ? { domain: sortedWebsites[0][0], durationSeconds: sortedWebsites[0][1] } : null;

      return reply.send({
        totalActiveSeconds: Math.round(activeSeconds),
        totalIdleSeconds: Math.round(idleSeconds),
        totalScreenTimeSeconds: Math.round(observedSeconds),
        appSessionCount,
        webSessionCount,
        idleSessionCount,
        totalEvents: sessions.length,
        topApp: topAppEntry,
        topDomain: topDomainEntry,
        today: {
          activeSeconds,
          idleSeconds,
          appCount: appUsage.size,
          websiteCount: webUsage.size,
          topApp: topAppEntry?.name || null,
          topWebsite: topDomainEntry?.domain || null,
        },
      });
    } catch (err) {
      app.log.error({ err }, 'Failed to fetch summary analytics');
      return reply.status(503).send({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Activity summary is temporarily unavailable' } });
    }
  });
}
