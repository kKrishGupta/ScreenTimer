import crypto from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { getMonitoringAuthorization } from './monitoring-authorization.js';

// In-memory store for fallback and rapid lookups during unit testing
const enrollmentTokenHashesMap = new Map();
const revokedDevicesSet = new Set();
const deviceSecretsMap = new Map();
const inMemoryDevices = new Map();

/**
 * Hashes a device secret using crypto.scrypt.
 */
export function hashDeviceSecret(secret, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(secret, s, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return {
    hash: derivedKey.toString('hex'),
    salt: s,
  };
}

/**
 * Verifies a device secret against stored hash and salt using timing-safe comparison.
 */
export function verifyDeviceSecret(secret, storedHash, salt) {
  if (!secret || !storedHash || !salt) return false;
  try {
    const derivedKey = crypto.scryptSync(secret, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (derivedKey.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(derivedKey, storedBuf);
  } catch {
    return false;
  }
}

export class DeviceService {
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Creates an active verified test/dev device identity for tests and local dev.
   */
  async createTestDevice({
    deviceId = 'test-device-pc-1',
    organizationId = '00000000-0000-0000-0000-000000000000',
    userId = null,
    name = 'Dev Test PC',
    kind = 'DESKTOP_AGENT',
  } = {}) {
    const deviceSecret = `dp_sec_${crypto.randomBytes(24).toString('hex')}`;
    const { hash, salt } = hashDeviceSecret(deviceSecret);
    const deviceData = {
      id: deviceId,
      organizationId,
      userId,
      name,
      kind,
      platform: 'windows',
      secretHash: hash,
      secretSalt: salt,
      isRevoked: false,
      lastSeenAt: new Date(),
    };
    if (process.env.NODE_ENV !== 'production') {
      inMemoryDevices.set(deviceId, deviceData);
      deviceSecretsMap.set(deviceId, { secret: deviceSecret, secretHash: hash, secretSalt: salt, organizationId });
      revokedDevicesSet.delete(deviceId);
    }
    return { deviceId, deviceSecret, headers: { 'x-device-secret': deviceSecret }, device: deviceData };
  }

  /**
   * Generates a secure, time-limited one-time enrollment token.
   */
  async createEnrollmentToken({ organizationId, userId = null, deviceKind = 'DESKTOP_AGENT', expiresInHours = 24 }) {
    if (!organizationId) {
      throw new Error('Organization ID is required');
    }
    if (userId) {
      if (!this.prisma?.user?.findFirst) {
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new Error('Employee assignment storage is unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
      } else {
        let owner;
        try {
          owner = await this.prisma.user.findFirst({ where: { id: userId, organizationId }, select: { id: true } });
        } catch (error) {
          const unavailable = new Error('Employee assignment could not be verified');
          unavailable.statusCode = 503;
          unavailable.cause = error;
          throw unavailable;
        }
        if (!owner) {
          const denied = new Error('The selected account does not belong to this organization');
          denied.statusCode = 403;
          throw denied;
        }
      }
    }

    const token = `dp_enroll_${crypto.randomBytes(20).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    const kind = String(deviceKind).toUpperCase().includes('BROWSER') ? 'BROWSER_EXTENSION' : 'DESKTOP_AGENT';

    const tokenRecord = {
      id: crypto.randomUUID(),
      tokenHash,
      organizationId,
      userId,
      deviceKind: kind,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };

    if (!this.prisma?.deviceEnrollmentToken?.create) {
      const unavailable = new Error('Persistent device enrollment is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
    }
    try {
      await this.prisma.deviceEnrollmentToken.create({
        data: {
          id: tokenRecord.id,
          tokenHash,
          organizationId,
          userId,
          deviceKind: kind,
          expiresAt,
        },
      });
    } catch (error) {
      const unavailable = new Error('Device enrollment is temporarily unavailable');
      unavailable.statusCode = 503;
      unavailable.cause = error;
      throw unavailable;
    }

    if (process.env.NODE_ENV !== 'production') enrollmentTokenHashesMap.set(tokenHash, tokenRecord);

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      deviceKind: kind,
      instructions: 'Enter this token in the desktop agent or browser extension setup prompt.',
    };
  }

  /**
   * Consumes an enrollment token to register a device with cryptographically secure credentials.
   */
  async enrollDevice({ token, deviceId, name, platform = 'Windows 11', browser = null, agentVersion = '0.1.0' }) {
    if (!token) {
      const err = new Error('Enrollment token is required');
      err.statusCode = 400;
      throw err;
    }
    const cleanId = deviceId || crypto.randomUUID();

    // Check in-memory first
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    let tokenRecord = enrollmentTokenHashesMap.get(tokenHash);
    if (!tokenRecord && this.prisma?.deviceEnrollmentToken?.findUnique) {
      try {
        tokenRecord = await this.prisma.deviceEnrollmentToken.findUnique({
          where: { tokenHash },
        });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new Error('Device enrollment is temporarily unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
      }
    } else if (!tokenRecord && process.env.NODE_ENV === 'production') {
      const unavailable = new Error('Persistent device enrollment is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
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

    const consumedAt = new Date();
    // Prepare the credential before entering the transaction. The transaction
    // claims the token and creates the device together, so a failure cannot
    // strand a consumed token or enroll the same token twice.
    const deviceSecret = `dp_sec_${crypto.randomBytes(24).toString('hex')}`;
    const { hash, salt } = hashDeviceSecret(deviceSecret);

    const requestedKind = browser ? 'BROWSER_EXTENSION' : 'DESKTOP_AGENT';
    const kind = tokenRecord.deviceKind || requestedKind;
    if (kind !== requestedKind) {
      const err = new Error(`This token is for a ${kind === 'BROWSER_EXTENSION' ? 'browser extension' : 'Windows agent'}. Create the matching enrollment token and try again.`);
      err.statusCode = 400;
      throw err;
    }

    const deviceData = {
      id: cleanId,
      organizationId: tokenRecord.organizationId,
      userId: tokenRecord.userId,
      name: name || 'Windows PC',
      kind,
      platform,
      browser,
      agentVersion,
      secretHash: hash,
      secretSalt: salt,
      isRevoked: false,
      revokedAt: null,
      // Enrollment is not proof that a collector is running. Only a
      // credential-authenticated heartbeat can establish online status.
      lastSeenAt: null,
    };

    const persistEnrollment = async (tx) => {
      const claimed = await tx.deviceEnrollmentToken.updateMany({
        where: { tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: consumedAt } },
        data: { usedAt: consumedAt },
      });
      if (claimed.count !== 1) {
        const err = new Error('This one-time enrollment token has already been consumed');
        err.statusCode = 409;
        throw err;
      }
      await tx.device.create({ data: deviceData });
    };

    if (this.prisma?.$transaction && this.prisma.deviceEnrollmentToken?.updateMany && this.prisma.device?.create) {
      await this.prisma.$transaction(persistEnrollment);
    } else if (process.env.NODE_ENV === 'production') {
      const unavailable = new Error('Transactional device enrollment storage is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
    } else {
      // Minimal Prisma-compatible development adapters may not implement
      // transactions. Keep their behavior isolated to non-production runs.
      if (this.prisma?.deviceEnrollmentToken?.updateMany && this.prisma?.device?.create) {
        await persistEnrollment(this.prisma);
      } else if (this.prisma?.deviceEnrollmentToken?.update) {
        await this.prisma.deviceEnrollmentToken.update({ where: { tokenHash }, data: { usedAt: consumedAt } });
      }
      tokenRecord.usedAt = consumedAt;
      enrollmentTokenHashesMap.set(tokenHash, tokenRecord);
      inMemoryDevices.set(cleanId, deviceData);
      deviceSecretsMap.set(cleanId, { secret: deviceSecret, secretHash: hash, secretSalt: salt, organizationId: tokenRecord.organizationId, userId: tokenRecord.userId });
      revokedDevicesSet.delete(cleanId);
    }

    // Audit log enrollment
    if (this.prisma?.auditLog?.create) {
      try {
        await this.prisma.auditLog.create({
          data: {
            organizationId: tokenRecord.organizationId,
            action: 'DEVICE_ENROLLED',
            actor: cleanId,
            details: { name, platform, kind },
          },
        });
      } catch {
        // Safe
      }
    }

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
   * Validates device authentication credentials against persistent storage.
   */
  async validateDeviceCredentials(deviceId, providedSecret) {
    if (!deviceId) {
      return { valid: false, code: 'DEVICE_ID_REQUIRED', message: 'Device ID is required' };
    }

    // Production device identity must come from PostgreSQL. Memory-backed
    // credentials are restricted to local tests and development adapters.
    let device = null;
    if (this.prisma?.device?.findUnique) {
      try {
        device = await this.prisma.device.findUnique({
          where: { id: deviceId },
        });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          return { valid: false, code: 'STORAGE_UNAVAILABLE', message: 'Persistent device authentication is unavailable' };
        }
      }
    } else if (process.env.NODE_ENV === 'production') {
      return { valid: false, code: 'STORAGE_UNAVAILABLE', message: 'Persistent device authentication is unavailable' };
    }
    if (!device && process.env.NODE_ENV !== 'production') {
      device = inMemoryDevices.get(deviceId);
    }

    if (!device) {
      return { valid: false, code: 'DEVICE_NOT_FOUND', message: 'Device is not registered or enrolled' };
    }

    // Check revocation status
    if (device.isRevoked || device.revokedAt || revokedDevicesSet.has(deviceId)) {
      return { valid: false, code: 'DEVICE_REVOKED', message: 'This device has been revoked by an administrator' };
    }

    if (!providedSecret) {
      return { valid: false, code: 'CREDENTIALS_REQUIRED', message: 'Device credentials are required' };
    }

    // Timing-safe secret verification
    let isValid = false;
    if (device.secretHash && device.secretSalt) {
      isValid = verifyDeviceSecret(providedSecret, device.secretHash, device.secretSalt);
    }

    // Fallback to in-memory secret map for non-production tests only.
    if (!isValid && process.env.NODE_ENV !== 'production') {
      const memorySecret = deviceSecretsMap.get(deviceId);
      if (memorySecret?.secret === providedSecret) {
        isValid = true;
      }
    }

    if (!isValid) {
      return { valid: false, code: 'INVALID_CREDENTIALS', message: 'Invalid device secret or credentials' };
    }

    return { valid: true, device };
  }

  /**
   * Records a device heartbeat ping with credential validation.
   */
  async recordHeartbeat(deviceId, secret, { agentVersion, metrics = {} } = {}) {
    if (!deviceId) throw new Error('Device ID is required');

    // Validate credentials
    const check = await this.validateDeviceCredentials(deviceId, secret);
    if (!check.valid) {
      const err = new Error(check.message);
      err.statusCode = check.code === 'DEVICE_REVOKED' ? 403 : check.code === 'STORAGE_UNAVAILABLE' ? 503 : 401;
      err.code = check.code;
      throw err;
    }

    const now = new Date();
    const device = check.device;
    let owner = null;
    if (device.userId && this.prisma?.user?.findUnique) {
      try {
        owner = await this.prisma.user.findUnique({
          where: { id: device.userId },
          include: { organization: { select: { timezone: true } } },
        });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new Error('Monitoring authorization could not be verified');
          unavailable.statusCode = 503;
          unavailable.cause = error;
          throw unavailable;
        }
      }
    }
    const monitoring = getMonitoringAuthorization(
      owner && owner.organizationId === device.organizationId ? owner : null,
      now,
    );

    if (this.prisma?.device?.update) {
      try {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: {
            lastSeenAt: now,
            ...(agentVersion ? { agentVersion } : {}),
          },
        });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new Error('The device heartbeat could not be persisted');
          unavailable.statusCode = 503;
          unavailable.cause = error;
          throw unavailable;
        }
      }
    } else if (process.env.NODE_ENV === 'production') {
      const unavailable = new Error('Persistent device heartbeat storage is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
    }

    if (inMemoryDevices.has(deviceId)) {
      const d = inMemoryDevices.get(deviceId);
      d.lastSeenAt = now;
      if (agentVersion) d.agentVersion = agentVersion;
    }

    return {
      status: 'healthy',
      serverTime: now.toISOString(),
      heartbeatIntervalSeconds: 30,
      monitoring,
    };
  }

  /**
   * Revokes a device. Ensures tenant isolation (device must belong to user's organization).
   */
  async revokeDevice(deviceId, organizationId, actor = 'Administrator') {
    if (!deviceId) throw new Error('Device ID is required');

    let device = null;
    if (this.prisma?.device?.findUnique) {
      try {
        device = await this.prisma.device.findUnique({ where: { id: deviceId } });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new AppError(503, 'DEVICE_STORAGE_UNAVAILABLE', 'Device storage is temporarily unavailable');
          unavailable.cause = error;
          throw unavailable;
        }
      }
    }
    if (!device) {
      device = inMemoryDevices.get(deviceId);
    }

    if (!device) {
      const err = new Error('Device not found');
      err.statusCode = 404;
      throw err;
    }

    // Verify tenant ownership unless actor is SUPER_ADMIN
    if (organizationId && organizationId !== '00000000-0000-0000-0000-000000000000' && device.organizationId !== organizationId) {
      const err = new Error('Access denied: Device belongs to another organization');
      err.statusCode = 403;
      throw err;
    }

    if (process.env.NODE_ENV === 'production' && (!this.prisma?.device?.update || !this.prisma?.device?.findUnique)) {
      throw new AppError(503, 'DEVICE_STORAGE_UNAVAILABLE', 'Persistent device revocation is unavailable');
    }

    revokedDevicesSet.add(deviceId);
    if (inMemoryDevices.has(deviceId)) {
      const d = inMemoryDevices.get(deviceId);
      d.isRevoked = true;
      d.revokedAt = new Date();
    }

    if (this.prisma?.device?.update) {
      try {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: {
            isRevoked: true,
            revokedAt: new Date(),
          },
        });
      } catch {
        if (process.env.NODE_ENV === 'production') {
          throw new AppError(503, 'DEVICE_REVOCATION_FAILED', 'Device revocation could not be persisted');
        }
      }
    }

    if (this.prisma?.auditLog?.create) {
      try {
        await this.prisma.auditLog.create({
          data: {
            organizationId: device.organizationId || organizationId || '00000000-0000-0000-0000-000000000000',
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
   * Rotates credentials for an enrolled device.
   */
  async rotateDeviceSecret(deviceId, organizationId, currentSecret, isUserAdmin = false) {
    if (!deviceId) throw new Error('Device ID is required');

    let device = null;
    if (this.prisma?.device?.findUnique) {
      try {
        device = await this.prisma.device.findUnique({ where: { id: deviceId } });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new AppError(503, 'DEVICE_STORAGE_UNAVAILABLE', 'Device storage is temporarily unavailable');
          unavailable.cause = error;
          throw unavailable;
        }
      }
    }
    if (!device) {
      device = inMemoryDevices.get(deviceId);
    }

    if (!device) {
      const err = new Error('Device not found');
      err.statusCode = 404;
      throw err;
    }

    if (organizationId && device.organizationId !== organizationId) {
      const err = new Error('Access denied: Device belongs to another organization');
      err.statusCode = 403;
      throw err;
    }

    if (device.isRevoked || revokedDevicesSet.has(deviceId)) {
      const err = new Error('Cannot rotate credentials on a revoked device');
      err.statusCode = 403;
      throw err;
    }

    // If not admin, verify current secret
    if (!isUserAdmin) {
      const check = await this.validateDeviceCredentials(deviceId, currentSecret);
      if (!check.valid) {
        const err = new Error('Current device credentials invalid');
        err.statusCode = 401;
        throw err;
      }
    }

    // Generate new credentials
    const newDeviceSecret = `dp_sec_${crypto.randomBytes(24).toString('hex')}`;
    const { hash, salt } = hashDeviceSecret(newDeviceSecret);

    if (process.env.NODE_ENV !== 'production') {
      deviceSecretsMap.set(deviceId, {
        secret: newDeviceSecret,
        secretHash: hash,
        secretSalt: salt,
        organizationId: device.organizationId,
        userId: device.userId,
      });
    }

    if (inMemoryDevices.has(deviceId)) {
      const d = inMemoryDevices.get(deviceId);
      d.secretHash = hash;
      d.secretSalt = salt;
    }

    if (process.env.NODE_ENV === 'production' && (!this.prisma?.device?.update || !this.prisma?.device?.findUnique)) {
      throw new AppError(503, 'DEVICE_STORAGE_UNAVAILABLE', 'Persistent credential rotation is unavailable');
    }
    if (this.prisma?.device?.update) {
      try {
        await this.prisma.device.update({
          where: { id: deviceId },
          data: {
            secretHash: hash,
            secretSalt: salt,
            updatedAt: new Date(),
          },
        });
      } catch {
        if (process.env.NODE_ENV === 'production') {
          throw new AppError(503, 'DEVICE_ROTATION_FAILED', 'Device credential rotation could not be persisted');
        }
      }
    }

    if (this.prisma?.auditLog?.create) {
      try {
        await this.prisma.auditLog.create({
          data: {
            organizationId: device.organizationId,
            action: 'DEVICE_CREDENTIALS_ROTATED',
            actor: isUserAdmin ? 'Admin' : deviceId,
            details: { deviceId },
          },
        });
      } catch {
        // Safe
      }
    }

    return {
      success: true,
      deviceId,
      deviceSecret: newDeviceSecret,
      rotatedAt: new Date().toISOString(),
    };
  }

  /**
   * Checks if a device is active and not revoked.
   */
  isDeviceAllowed(deviceId) {
    if (revokedDevicesSet.has(deviceId)) return false;
    const d = inMemoryDevices.get(deviceId);
    if (d?.isRevoked) return false;
    return true;
  }

  /**
   * Lists devices with tenant isolation and status.
   */
  async listDevices(organizationId, userId = null) {
    let rows = [];
    if (process.env.NODE_ENV === 'production' && !this.prisma?.device?.findMany) {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Device storage is unavailable');
    }
    if (this.prisma?.device?.findMany) {
      try {
        const whereClause = {};
        if (organizationId) whereClause.organizationId = organizationId;
        if (userId) whereClause.userId = userId;

        rows = await this.prisma.device.findMany({
          where: whereClause,
          include: { user: { include: { organization: { select: { timezone: true } } } } },
          orderBy: { lastSeenAt: 'desc' },
        });
      } catch {
        if (process.env.NODE_ENV === 'production') throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Device records could not be loaded');
        rows = Array.from(inMemoryDevices.values());
      }
    } else {
      rows = Array.from(inMemoryDevices.values());
    }

    if (organizationId && rows.length > 0) {
      rows = rows.filter((d) => d.organizationId === organizationId);
    }
    if (userId && rows.length > 0) {
      rows = rows.filter((d) => d.userId === userId);
    }

    const now = Date.now();
    return rows.map((d) => {
      const isRevoked = d.isRevoked || revokedDevicesSet.has(d.id);
      const lastSeenMs = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
      const heartbeatAgeMs = now - lastSeenMs;
      const isOnline = !isRevoked && heartbeatAgeMs >= 0 && heartbeatAgeMs < 5 * 60 * 1000;

      return {
        id: d.id,
        kind: (d.kind || 'DESKTOP_AGENT').toLowerCase(),
        name: d.name,
        platform: d.platform,
        browser: d.browser,
        agentVersion: d.agentVersion,
        createdAt: d.createdAt ? (d.createdAt.toISOString ? d.createdAt.toISOString() : d.createdAt) : null,
        lastSeenAt: d.lastSeenAt ? (d.lastSeenAt.toISOString ? d.lastSeenAt.toISOString() : d.lastSeenAt) : null,
        lastSyncAt: d.lastSyncAt ? (d.lastSyncAt.toISOString ? d.lastSyncAt.toISOString() : d.lastSyncAt) : null,
        status: isRevoked ? 'revoked' : isOnline ? 'online' : 'offline',
        userId: d.userId || null,
        isRevoked,
        assignedUser: d.user ? { id: d.user.id, displayName: d.user.displayName, email: d.user.email } : null,
        monitoring: getMonitoringAuthorization(
          d.user && d.user.organizationId === d.organizationId ? d.user : null,
          new Date(),
        ),
      };
    });
  }
}
