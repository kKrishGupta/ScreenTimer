import crypto from 'node:crypto';

// In-memory rate limiting for login attempts
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// In-memory session store (works standalone and caches DB sessions)
const inMemorySessions = new Map();
// Password reset tokens (dev-friendly, expires in 30 minutes)
const resetTokens = new Map();

export const Roles = {
  FAMILY_OWNER: 'FAMILY_OWNER',
  ADULT_MEMBER: 'ADULT_MEMBER',
  SUPERVISED_MEMBER: 'SUPERVISED_MEMBER',
};

/**
 * Normalizes legacy roles to Stage 2 roles.
 */
export function normalizeRole(role) {
  if (!role) return Roles.ADULT_MEMBER;
  const upper = String(role).toUpperCase();
  if (upper === 'OWNER' || upper === 'FAMILY_OWNER') return Roles.FAMILY_OWNER;
  if (upper === 'SUPERVISED_MEMBER' || upper === 'CHILD') return Roles.SUPERVISED_MEMBER;
  return Roles.ADULT_MEMBER;
}

/**
 * Hashes a password using crypto.scrypt with a secure random salt.
 */
export function hashPassword(password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return {
    hash: derivedKey.toString('hex'),
    salt,
  };
}

/**
 * Verifies a password against the stored hash and salt using timing-safe comparison.
 */
export function verifyPassword(password, storedHashHex, saltHex) {
  if (!password || !storedHashHex || !saltHex) return false;
  try {
    const derivedKey = crypto.scryptSync(password, saltHex, 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    const storedBuffer = Buffer.from(storedHashHex, 'hex');
    if (derivedKey.length !== storedBuffer.length) return false;
    return crypto.timingSafeEqual(derivedKey, storedBuffer);
  } catch {
    return false;
  }
}

/**
 * Checks rate limiting for an identifier (email or IP).
 */
export function checkLoginThrottling(identifier) {
  const record = loginAttempts.get(identifier);
  if (!record) return { allowed: true };

  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil > now) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      reason: `Account temporarily locked due to excessive failed attempts. Please try again in ${remainingSeconds} seconds.`,
      remainingSeconds,
    };
  }

  // Lockout expired
  if (record.lockedUntil && record.lockedUntil <= now) {
    loginAttempts.delete(identifier);
    return { allowed: true };
  }

  return { allowed: true, attempts: record.count };
}

/**
 * Records a failed login attempt and applies lockout if threshold is exceeded.
 */
export function recordFailedLogin(identifier) {
  const now = Date.now();
  const record = loginAttempts.get(identifier) || { count: 0, firstAttemptAt: now };
  record.count += 1;

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
  }
  loginAttempts.set(identifier, record);
  return record;
}

/**
 * Clears failed attempts upon successful login.
 */
export function clearLoginThrottling(identifier) {
  loginAttempts.delete(identifier);
}

/**
 * Core Authentication and RBAC Service.
 */
export class AuthService {
  /**
   * @param {import('@prisma/client').PrismaClient} [prisma]
   * @param {object} [logger]
   */
  constructor(prisma, logger) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Registers a new user. The first user in a new household becomes FAMILY_OWNER.
   */
  async register({ email, password, displayName, role, organizationId, organizationName }) {
    if (!email || !email.includes('@')) {
      const err = new Error('Valid email address is required');
      err.statusCode = 400;
      throw err;
    }
    const cleanEmail = email.toLowerCase().trim();
    const { hash, salt } = hashPassword(password);

    let orgId = organizationId;
    let assignedRole = role ? normalizeRole(role) : Roles.FAMILY_OWNER;

    // Check if user already exists
    if (this.prisma?.user?.findFirst) {
      try {
        const existing = await this.prisma.user.findFirst({
          where: { email: cleanEmail },
        });
        if (existing) {
          const err = new Error('A user with this email already exists');
          err.statusCode = 409;
          throw err;
        }

        // Create organization if not provided
        if (!orgId) {
          const org = await this.prisma.organization.create({
            data: {
              name: organizationName || `${displayName || 'Family'}'s Household`,
              slug: `household-${crypto.randomBytes(4).toString('hex')}`,
            },
          });
          orgId = org.id;
        }

        const newUser = await this.prisma.user.create({
          data: {
            organizationId: orgId,
            email: cleanEmail,
            displayName: displayName || cleanEmail.split('@')[0],
            role: assignedRole === Roles.FAMILY_OWNER ? 'OWNER' : 'MEMBER',
            passwordHash: hash,
            passwordSalt: salt,
          },
        });

        await this.logAuthEvent({
          organizationId: orgId,
          action: 'USER_REGISTERED',
          actor: cleanEmail,
          details: { userId: newUser.id, role: assignedRole },
        });

        return {
          id: newUser.id,
          email: newUser.email,
          displayName: newUser.displayName,
          role: assignedRole,
          organizationId: newUser.organizationId,
        };
      } catch (err) {
        if (err.statusCode) throw err;
        // In unit test or fallback mode when DB is unavailable:
        return this._registerMemory({ cleanEmail, hash, salt, displayName, assignedRole, orgId, organizationName });
      }
    }

    return this._registerMemory({ cleanEmail, hash, salt, displayName, assignedRole, orgId, organizationName });
  }

  _registerMemory({ cleanEmail, hash, salt, displayName, assignedRole, orgId, organizationName }) {
    const memoryUser = {
      id: crypto.randomUUID(),
      organizationId: orgId || crypto.randomUUID(),
      email: cleanEmail,
      displayName: displayName || cleanEmail.split('@')[0],
      role: assignedRole,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: new Date(),
    };
    inMemorySessions.set(`user:${cleanEmail}`, memoryUser);
    return {
      id: memoryUser.id,
      email: memoryUser.email,
      displayName: memoryUser.displayName,
      role: memoryUser.role,
      organizationId: memoryUser.organizationId,
    };
  }

  /**
   * Authenticates credentials, creates a session token, and returns user session.
   */
  async login({ email, password, ipAddress = '127.0.0.1', userAgent = 'DigitalPulse Client' }) {
    if (!email || !password) {
      const err = new Error('Email and password are required');
      err.statusCode = 400;
      throw err;
    }
    const cleanEmail = email.toLowerCase().trim();

    // Check throttling
    const throttleCheck = checkLoginThrottling(cleanEmail);
    if (!throttleCheck.allowed) {
      const err = new Error(throttleCheck.reason);
      err.statusCode = 429;
      throw err;
    }

    let user = null;

    if (this.prisma?.user?.findFirst) {
      try {
        user = await this.prisma.user.findFirst({
          where: { email: cleanEmail },
        });
      } catch {
        // Fallback to in-memory user
      }
    }

    if (!user) {
      user = inMemorySessions.get(`user:${cleanEmail}`);
    }

    if (!user || !user.passwordHash || !user.passwordSalt) {
      recordFailedLogin(cleanEmail);
      await this.logAuthEvent({
        organizationId: user?.organizationId || '00000000-0000-0000-0000-000000000000',
        action: 'LOGIN_FAILED',
        actor: cleanEmail,
        details: { reason: 'User not found or no password set', ipAddress },
      });
      const err = new Error('Invalid email or password');
      err.statusCode = 401;
      throw err;
    }

    const isValid = verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!isValid) {
      recordFailedLogin(cleanEmail);
      await this.logAuthEvent({
        organizationId: user.organizationId,
        action: 'LOGIN_FAILED',
        actor: cleanEmail,
        details: { reason: 'Password mismatch', ipAddress },
      });
      const err = new Error('Invalid email or password');
      err.statusCode = 401;
      throw err;
    }

    // Success: clear rate limit counter
    clearLoginThrottling(cleanEmail);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const normalizedRole = normalizeRole(user.role);

    const sessionData = {
      id: crypto.randomUUID(),
      userId: user.id,
      token,
      userAgent,
      ipAddress,
      expiresAt,
      createdAt: new Date(),
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: normalizedRole,
        organizationId: user.organizationId,
      },
    };

    inMemorySessions.set(`token:${token}`, sessionData);

    // Save session in DB if available
    if (this.prisma?.userSession?.create) {
      try {
        await this.prisma.userSession.create({
          data: {
            id: sessionData.id,
            userId: user.id,
            token,
            userAgent,
            ipAddress,
            expiresAt,
          },
        });
      } catch {
        // Safe fallback in memory
      }
    }

    await this.logAuthEvent({
      organizationId: user.organizationId,
      action: 'LOGIN_SUCCESS',
      actor: cleanEmail,
      details: { sessionId: sessionData.id, ipAddress },
    });

    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: normalizedRole,
        organizationId: user.organizationId,
      },
    };
  }

  /**
   * Validates an active session token.
   */
  async validateSession(token) {
    if (!token) return null;

    // Check in-memory cache first
    const cached = inMemorySessions.get(`token:${token}`);
    if (cached) {
      if (cached.revokedAt || new Date(cached.expiresAt) < new Date()) {
        inMemorySessions.delete(`token:${token}`);
        return null;
      }
      return cached;
    }

    // Check DB
    if (this.prisma?.userSession?.findUnique) {
      try {
        const dbSession = await this.prisma.userSession.findUnique({
          where: { token },
          include: { user: true },
        });
        if (dbSession && !dbSession.revokedAt && new Date(dbSession.expiresAt) > new Date()) {
          const sessionObj = {
            id: dbSession.id,
            userId: dbSession.userId,
            token: dbSession.token,
            userAgent: dbSession.userAgent,
            ipAddress: dbSession.ipAddress,
            expiresAt: dbSession.expiresAt,
            user: {
              id: dbSession.user.id,
              email: dbSession.user.email,
              displayName: dbSession.user.displayName,
              role: normalizeRole(dbSession.user.role),
              organizationId: dbSession.user.organizationId,
            },
          };
          inMemorySessions.set(`token:${token}`, sessionObj);
          return sessionObj;
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Logs out / revokes a session token.
   */
  async logout(token) {
    if (!token) return true;
    const session = inMemorySessions.get(`token:${token}`);
    if (session) {
      session.revokedAt = new Date();
      inMemorySessions.delete(`token:${token}`);
    }

    if (this.prisma?.userSession?.updateMany) {
      try {
        await this.prisma.userSession.updateMany({
          where: { token },
          data: { revokedAt: new Date() },
        });
      } catch {
        // Safe fallback
      }
    }

    if (session) {
      await this.logAuthEvent({
        organizationId: session.user.organizationId,
        action: 'LOGOUT',
        actor: session.user.email,
        details: { sessionId: session.id },
      });
    }

    return true;
  }

  /**
   * Changes user password after verifying old password.
   */
  async changePassword({ userId, oldPassword, newPassword }) {
    if (!userId || !oldPassword || !newPassword) {
      const err = new Error('User ID, old password, and new password are required');
      err.statusCode = 400;
      throw err;
    }

    let user = null;
    if (this.prisma?.user?.findUnique) {
      try {
        user = await this.prisma.user.findUnique({ where: { id: userId } });
      } catch {
        // fallback
      }
    }
    if (!user) {
      for (const val of inMemorySessions.values()) {
        if (val.id === userId || val.userId === userId) {
          user = val.user || val;
          break;
        }
      }
    }

    if (!user || !user.passwordHash || !user.passwordSalt) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    const isValid = verifyPassword(oldPassword, user.passwordHash, user.passwordSalt);
    if (!isValid) {
      const err = new Error('Current password is incorrect');
      err.statusCode = 401;
      throw err;
    }

    const { hash, salt } = hashPassword(newPassword);

    if (this.prisma?.user?.update) {
      try {
        await this.prisma.user.update({
          where: { id: userId },
          data: { passwordHash: hash, passwordSalt: salt },
        });
      } catch {
        user.passwordHash = hash;
        user.passwordSalt = salt;
      }
    } else {
      user.passwordHash = hash;
      user.passwordSalt = salt;
    }

    await this.logAuthEvent({
      organizationId: user.organizationId,
      action: 'PASSWORD_CHANGED',
      actor: user.email,
      details: { userId },
    });

    return { success: true, message: 'Password updated successfully' };
  }

  /**
   * Requests a password reset token for local development.
   */
  async requestPasswordReset({ email }) {
    const cleanEmail = email.toLowerCase().trim();
    const resetToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    resetTokens.set(cleanEmail, { token: resetToken, expiresAt });

    await this.logAuthEvent({
      organizationId: '00000000-0000-0000-0000-000000000000',
      action: 'PASSWORD_RESET_REQUESTED',
      actor: cleanEmail,
      details: { expiresAt },
    });

    return {
      success: true,
      resetToken, // Included in response for local development usability
      message: 'Reset token generated (valid for 30 minutes)',
    };
  }

  /**
   * Confirms password reset using valid reset token.
   */
  async confirmPasswordReset({ email, resetToken, newPassword }) {
    const cleanEmail = email.toLowerCase().trim();
    const record = resetTokens.get(cleanEmail);

    if (!record || record.token !== resetToken || new Date(record.expiresAt) < new Date()) {
      const err = new Error('Invalid or expired password reset token');
      err.statusCode = 400;
      throw err;
    }

    const { hash, salt } = hashPassword(newPassword);

    if (this.prisma?.user?.updateMany) {
      try {
        await this.prisma.user.updateMany({
          where: { email: cleanEmail },
          data: { passwordHash: hash, passwordSalt: salt },
        });
      } catch {
        const user = inMemorySessions.get(`user:${cleanEmail}`);
        if (user) {
          user.passwordHash = hash;
          user.passwordSalt = salt;
        }
      }
    }

    resetTokens.delete(cleanEmail);

    await this.logAuthEvent({
      organizationId: '00000000-0000-0000-0000-000000000000',
      action: 'PASSWORD_RESET_CONFIRMED',
      actor: cleanEmail,
      details: {},
    });

    return { success: true, message: 'Password successfully reset' };
  }

  /**
   * Logs an authentication event in the AuditLog.
   */
  async logAuthEvent({ organizationId, action, actor, details = {} }) {
    if (this.prisma?.auditLog?.create) {
      try {
        await this.prisma.auditLog.create({
          data: {
            organizationId,
            action,
            actor,
            details,
          },
        });
      } catch {
        // Safe logging
      }
    }
  }
}
