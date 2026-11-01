import { activityBatchSchema } from '@digitalpulse/contracts';
import { badRequest } from '../../shared/errors.js';

const COLLECTOR_KIND_MAP = {
  desktop_agent: 'DESKTOP_AGENT',
  browser_extension: 'BROWSER_EXTENSION',
};

const ACTIVITY_TYPE_MAP = {
  app_session: 'APP_SESSION',
  web_session: 'WEB_SESSION',
  idle_session: 'IDLE_SESSION',
};

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

      // 1. Resolve default local development organization
      const org = await prisma.organization.findUnique({
        where: { slug: process.env.DEV_ORG_SLUG || 'local-dev' },
      });

      if (!org) {
        throw badRequest(
          'Default organization not found. Run npm run db:seed first.',
        );
      }

      // 2. Auto-register or update device metadata
      const collectorKind =
        COLLECTOR_KIND_MAP[devInfo.kind] || 'DESKTOP_AGENT';
      const now = new Date();

      await prisma.device.upsert({
        where: { id: devInfo.id },
        update: {
          name: devInfo.name,
          platform: devInfo.platform,
          browser: devInfo.browser || null,
          agentVersion: devInfo.agentVersion || null,
          lastSeenAt: now,
          lastSyncAt: now,
        },
        create: {
          id: devInfo.id,
          organizationId: org.id,
          kind: collectorKind,
          name: devInfo.name,
          platform: devInfo.platform,
          browser: devInfo.browser || null,
          agentVersion: devInfo.agentVersion || null,
          lastSeenAt: now,
          lastSyncAt: now,
        },
      });

      // 3. Process events with strict idempotency (deduplication)
      let accepted = 0;
      let deduplicated = 0;

      for (const event of events) {
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
          const domainLower = event.web.domain.toLowerCase();
          const website = await prisma.website.upsert({
            where: {
              organizationId_domain: {
                organizationId: org.id,
                domain: domainLower,
              },
            },
            update: {},
            create: {
              organizationId: org.id,
              domain: domainLower,
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
      }

      return reply.send({ accepted, deduplicated });
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

    const take = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
    const skip = Math.max(0, parseInt(offset, 10) || 0);

    const where = {};
    if (deviceId) where.deviceId = deviceId;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

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

    return reply.send({
      sessions: sessions.map((s) => ({
        id: s.id,
        type: s.type.toLowerCase(),
        source: s.source.toLowerCase(),
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt.toISOString(),
        durationSeconds: s.durationSeconds,
        application: s.application
          ? {
              name: s.application.displayName,
              executable: s.application.executableName,
              processId: s.processId,
            }
          : null,
        website: s.website
          ? {
              domain: s.website.domain,
              browser: s.browser,
            }
          : null,
        deviceName: s.device?.name,
      })),
      total,
      limit: take,
      offset: skip,
    });
  });

  // GET /api/v1/activity/apps
  app.get('/activity/apps', async (request, reply) => {
    const { from, to, deviceId } = request.query;
    const prisma = app.prisma;

    const where = { type: 'APP_SESSION' };
    if (deviceId) where.deviceId = deviceId;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

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
        appMap.set(key, {
          name: s.application.displayName,
          executable: s.application.executableName,
          totalSeconds: 0,
          sessionCount: 0,
        });
      }
      const entry = appMap.get(key);
      entry.totalSeconds += s.durationSeconds;
      entry.sessionCount++;
    }

    const applications = Array.from(appMap.values())
      .map((item) => ({
        ...item,
        percentage:
          totalSecondsAll > 0
            ? Math.round((item.totalSeconds / totalSecondsAll) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds);

    return reply.send({
      totalSeconds: totalSecondsAll,
      applications,
    });
  });

  // GET /api/v1/activity/websites
  app.get('/activity/websites', async (request, reply) => {
    const { from, to, deviceId } = request.query;
    const prisma = app.prisma;

    const where = { type: 'WEB_SESSION' };
    if (deviceId) where.deviceId = deviceId;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

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
      const key = s.website.domain;
      totalSecondsAll += s.durationSeconds;

      if (!webMap.has(key)) {
        webMap.set(key, {
          domain: s.website.domain,
          totalSeconds: 0,
          visitCount: 0,
        });
      }
      const entry = webMap.get(key);
      entry.totalSeconds += s.durationSeconds;
      entry.visitCount++;
    }

    const websites = Array.from(webMap.values())
      .map((item) => ({
        ...item,
        percentage:
          totalSecondsAll > 0
            ? Math.round((item.totalSeconds / totalSecondsAll) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds);

    return reply.send({
      totalSeconds: totalSecondsAll,
      websites,
    });
  });

  // GET /api/v1/activity/summary
  app.get('/activity/summary', async (request, reply) => {
    const { deviceId } = request.query;
    const prisma = app.prisma;

    // Default to start of today UTC
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const where = { startedAt: { gte: startOfToday } };
    if (deviceId) where.deviceId = deviceId;

    const sessions = await prisma.activitySession.findMany({
      where,
      include: {
        application: { select: { displayName: true } },
        website: { select: { domain: true } },
      },
    });

    let activeSeconds = 0;
    let idleSeconds = 0;
    const appUsage = new Map();
    const webUsage = new Map();

    for (const s of sessions) {
      if (s.type === 'IDLE_SESSION') {
        idleSeconds += s.durationSeconds;
      } else {
        activeSeconds += s.durationSeconds;
        if (s.application) {
          const name = s.application.displayName;
          appUsage.set(name, (appUsage.get(name) || 0) + s.durationSeconds);
        }
        if (s.website) {
          const domain = s.website.domain;
          webUsage.set(domain, (webUsage.get(domain) || 0) + s.durationSeconds);
        }
      }
    }

    const topApp = Array.from(appUsage.entries()).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0] || null;

    const topWebsite = Array.from(webUsage.entries()).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0] || null;

    return reply.send({
      today: {
        activeSeconds,
        idleSeconds,
        appCount: appUsage.size,
        websiteCount: webUsage.size,
        topApp,
        topWebsite,
      },
    });
  });
}
