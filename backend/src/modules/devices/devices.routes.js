export default async function devicesRoutes(app) {
  // GET /api/v1/devices
  app.get('/devices', async (_request, reply) => {
    const prisma = app.prisma;

    const devices = await prisma.device.findMany({
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        kind: true,
        name: true,
        platform: true,
        browser: true,
        agentVersion: true,
        lastSeenAt: true,
        lastSyncAt: true,
        createdAt: true,
      },
    });

    return reply.send({
      devices: devices.map((d) => ({
        id: d.id,
        kind: d.kind.toLowerCase(),
        name: d.name,
        platform: d.platform,
        browser: d.browser,
        agentVersion: d.agentVersion,
        lastSeenAt: d.lastSeenAt?.toISOString() || null,
        lastSyncAt: d.lastSyncAt?.toISOString() || null,
        createdAt: d.createdAt ? d.createdAt.toISOString() : new Date().toISOString(),
      })),
    });
  });
}
