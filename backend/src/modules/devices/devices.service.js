import crypto from 'node:crypto';

// In-memory store for fallback and rapid lookups
const enrollmentTokensMap = new Map();
const revokedDevicesSet = new Set();
const deviceSecretsMap = new Map();

export class DeviceService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Generates a secure, time-limited one-time enrollment token.
   */
  async createEnrollmentToken({ organizationId, userId = null, deviceKind = 'DESKTOP_AGENT', expiresInHours = 24 }) {
    if (!organizationId) {
      throw new Error('Organization/household ID is required');
    }

    const token = `dp_enroll_${crypto.randomBytes(20).toString('hex')}`;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    const kind = String(deviceKind).toUpperCase().includes('BROWSER') ? 'BROWSER_EXTENSION' : 'DESKTOP_AGENT';

    const tokenRecord = {
      id: crypto.randomUUID(),
      token,
      organizationId,
      userId,
      deviceKind: kind,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };

    enrollmentTokensMap.set(token, tokenRecord);

    if (this.prisma?.deviceEnrollmentToken?.create) {
      try {
        await this.prisma.deviceEnrollmentToken.create({
          data: {
            id: tokenRecord.id,
            token,
            organizationId,
            userId,
            deviceKind: kind,
            expiresAt,
          },
        });
      } catch {
        // Fallback to in-memory record
      }
    }

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      deviceKind: kind,
      instructions: 'Enter this token in the desktop agent or browser extension setup prompt.',
    };
  }

  /**
   * Consumes an enrollment token to register a device to a household.
   */
  async enrollDevice({ token, deviceId, name, platform = 'Windows 11', browser = null, agentVersion = '0.1.0' }) {
    if (!token) {
      const err = new Error('Enrollment token is required');
      err.statusCode = 400;
      throw err;
    }
    const cleanId = deviceId || crypto.randomUUID();

    // Check in-memory first
    let tokenRecord = enrollmentTokensMap.get(token);

    if (!tokenRecord && this.prisma?.deviceEnrollmentToken?.findUnique) {
      try {
        tokenRecord = await this.prisma.deviceEnrollmentToken.findUnique({
          where: { token },
        });
      } catch {
        // fallback
      }
    }

    if (!tokenRecord) {
      const err = new Error('Invalid or unknown enrollment token');
      err.statusCode = 401;
      throw err;
    }

    if (tokenRecord.revokedAt) {
      const err = new Error('This enrollment token has been revoked');
      err.statusCode = 403;
      throw err;
    }

    if (tokenRecord.usedAt) {
      const err = new Error('This one-time enrollment token has already been consumed');
      err.statusCode = 409;
      throw err;
    }

    if (new Date(tokenRecord.expiresAt) < new Date()) {
      const err = new Error('This enrollment token has expired');
      err.statusCode = 410;
      throw err;
    }

    // Mark token as used
    tokenRecord.usedAt = new Date();
    if (this.prisma?.deviceEnrollmentToken?.update) {
      try {
        await this.prisma.deviceEnrollmentToken.update({
          where: { token },
          data: { usedAt: tokenRecord.usedAt },
        });
      } catch {
        // Safe fallback
      }
    }

    // Generate persistent device secret for authenticated ingestion
    const deviceSecret = `dp_sec_${crypto.randomBytes(24).toString('hex')}`;
    deviceSecretsMap.set(cleanId, {
      secret: deviceSecret,
      organizationId: tokenRecord.organizationId,
      userId: tokenRecord.userId,
    });

    const kind = tokenRecord.deviceKind || (browser ? 'BROWSER_EXTENSION' : 'DESKTOP_AGENT');

    let deviceRow = null;
    if (this.prisma?.device?.upsert) {
      try {
        deviceRow = await this.prisma.device.upsert({
          where: { id: cleanId },
          update: {
            organizationId: tokenRecord.organizationId,
            userId: tokenRecord.userId,
            name: name || 'Windows PC',
            platform,
            browser,
            agentVersion,
            lastSeenAt: new Date(),
          },
          create: {
            id: cleanId,
            organizationId: tokenRecord.organizationId,
            userId: tokenRecord.userId,
            name: name || 'Windows PC',
            kind,
            platform,
            browser,
            agentVersion,
            lastSeenAt: new Date(),
          },
        });
      } catch {
        // Fallback
      }
    }

    revokedDevicesSet.delete(cleanId);

    return {
      success: true,
      deviceId: cleanId,
      deviceSecret,
      organizationId: tokenRecord.organizationId,
      assignedUserId: tokenRecord.userId,
      registeredAt: new Date().toISOString(),
    };
  }

  /**
   * Records a device heartbeat ping.
   */
  async recordHeartbeat(deviceId, { agentVersion, metrics = {} } = {}) {
    if (!deviceId) throw new Error('Device ID is required');

    if (revokedDevicesSet.has(deviceId)) {
      const err = new Error('This device has been revoked by the family administrator');
      err.statusCode = 403;
      throw err;
    }

    const now = new Date();
    if (this.prisma?.device?.update) {
      try {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: {
            lastSeenAt: now,
            ...(agentVersion ? { agentVersion } : {}),
          },
        });
      } catch {
        // Safe fallback
      }
    }

    return {
      status: 'healthy',
      serverTime: now.toISOString(),
      heartbeatIntervalSeconds: 30,
    };
  }

  /**
   * Revokes a device.
   */
  async revokeDevice(deviceId, actor = 'Family Owner') {
    if (!deviceId) throw new Error('Device ID is required');
    revokedDevicesSet.add(deviceId);

    let device = null;
    if (this.prisma?.device?.findUnique) {
      try {
        device = await this.prisma.device.findUnique({ where: { id: deviceId } });
      } catch {
        // Safe
      }
    }

    if (this.prisma?.auditLog?.create) {
      try {
        await this.prisma.auditLog.create({
          data: {
            organizationId: device?.organizationId || '00000000-0000-0000-0000-000000000000',
            action: 'DEVICE_REVOKED',
            actor,
            details: { deviceId },
          },
        });
      } catch {
        // Safe
      }
    }

    return { success: true, deviceId, status: 'revoked' };
  }

  /**
   * Checks if a device is active and not revoked.
   */
  isDeviceAllowed(deviceId) {
    return !revokedDevicesSet.has(deviceId);
  }

  /**
   * Lists devices with status and family member information.
   */
  async listDevices(organizationId) {
    if (this.prisma?.device?.findMany) {
      try {
        const whereClause = organizationId ? { organizationId } : {};
        const rows = await this.prisma.device.findMany({
          where: whereClause,
          include: { user: true },
          orderBy: { lastSeenAt: 'desc' },
        });

        const now = Date.now();
        return rows.map((d) => {
          const isRevoked = revokedDevicesSet.has(d.id);
          const lastSeenMs = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
          const isOnline = !isRevoked && now - lastSeenMs < 90 * 1000; // 90 seconds threshold

          return {
            id: d.id,
            kind: d.kind.toLowerCase(),
            name: d.name,
            platform: d.platform,
            browser: d.browser,
            agentVersion: d.agentVersion,
            lastSeenAt: d.lastSeenAt?.toISOString() || null,
            lastSyncAt: d.lastSyncAt?.toISOString() || null,
            status: isRevoked ? 'revoked' : isOnline ? 'online' : 'offline',
            assignedUser: d.user ? { id: d.user.id, displayName: d.user.displayName, email: d.user.email } : null,
          };
        });
      } catch {
        return [];
      }
    }
    return [];
  }
}
