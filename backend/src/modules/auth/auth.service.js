import crypto from 'node:crypto';
import { createEmailService } from './email.service.js';

// In-memory rate limiting for login attempts
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_ATTEMPT_CLEANUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let lastLoginAttemptCleanupAt = 0;

// In-memory session store (works standalone and caches DB sessions)
const inMemorySessions = new Map();
// Password reset tokens (dev-friendly, expires in 30 minutes)
const resetTokens = new Map();

export const Roles = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ORGANIZATION_ADMIN: 'ORGANIZATION_ADMIN',
  ORG_ADMIN: 'ORGANIZATION_ADMIN',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
  FAMILY_OWNER: 'FAMILY_OWNER',
  ADULT_MEMBER: 'ADULT_MEMBER',
  SUPERVISED_MEMBER: 'SUPERVISED_MEMBER',
  OWNER: 'OWNER',
  MEMBER: 'MEMBER',
};

/**
 * Normalizes roles to canonical enterprise roles: SUPER_ADMIN, ORGANIZATION_ADMIN, MANAGER, EMPLOYEE.
 */
export function normalizeRole(role) {
  if (!role) return Roles.EMPLOYEE;
  const upper = String(role).toUpperCase();
  if (upper === 'SUPER_ADMIN') return Roles.SUPER_ADMIN;
  if (['ORGANIZATION_ADMIN', 'ORG_ADMIN', 'FAMILY_OWNER', 'OWNER'].includes(upper)) return Roles.ORGANIZATION_ADMIN;
  if (upper === 'MANAGER') return Roles.MANAGER;
  return Roles.EMPLOYEE;
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

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function invitationError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isValidPersonName(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  return name.length >= 2 && name.length <= 128 && !name.includes('@') && /\p{L}/u.test(name);
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
  constructor(prisma, logger, config = {}) {
    this.prisma = prisma;
    this.logger = logger || console;
    this.config = config;
    this.emailService = createEmailService(config);
  }

  get isProduction() {
    return this.config?.nodeEnv === 'production' || process.env.NODE_ENV === 'production';
  }

  _loginAttemptHash(identifier) {
    return crypto.createHash('sha256').update(String(identifier).toLowerCase().trim()).digest('hex');
  }

  _hasPersistentLoginAttemptStorage(client = this.prisma) {
    return Boolean(
      client?.loginAttempt?.findUnique
      && client.loginAttempt.create
      && client.loginAttempt.update
      && client.loginAttempt.deleteMany
      && client.$transaction
      && client.$executeRaw,
    );
  }

  _authenticationStorageError() {
    const error = new Error('Persistent authentication protection is unavailable');
    error.statusCode = 503;
    error.code = 'AUTHENTICATION_STORAGE_UNAVAILABLE';
    return error;
  }

  async _checkLoginThrottling(identifier) {
    if (!this._hasPersistentLoginAttemptStorage()) {
      if (this.isProduction) throw this._authenticationStorageError();
      return checkLoginThrottling(identifier);
    }

    try {
      const identifierHash = this._loginAttemptHash(identifier);
      const attempt = await this.prisma.loginAttempt.findUnique({ where: { identifierHash } });
      const now = Date.now();
      if (attempt?.lockedUntil && new Date(attempt.lockedUntil).getTime() > now) {
        const remainingSeconds = Math.ceil((new Date(attempt.lockedUntil).getTime() - now) / 1000);
        return {
          allowed: false,
          reason: `Account temporarily locked due to excessive failed attempts. Please try again in ${remainingSeconds} seconds.`,
          remainingSeconds,
        };
      }
      return { allowed: true };
    } catch (error) {
      if (this.isProduction) throw this._authenticationStorageError();
      return checkLoginThrottling(identifier);
    }
  }

  async _recordFailedLogin(identifier) {
    if (!this._hasPersistentLoginAttemptStorage()) {
      if (this.isProduction) throw this._authenticationStorageError();
      recordFailedLogin(identifier);
      return;
    }

    const identifierHash = this._loginAttemptHash(identifier);
    const lockKey = crypto.createHash('sha256').update(`login-attempt:${identifierHash}`).digest();
    try {
      await this.prisma.$transaction(async (tx) => {
        if (typeof tx.$executeRaw !== 'function') throw new Error('Persistent login lock is unavailable');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey.readInt32BE(0)}::integer, ${lockKey.readInt32BE(4)}::integer)`;

        const now = new Date();
        const attempt = await tx.loginAttempt.findUnique({ where: { identifierHash } });
        if (attempt?.lockedUntil && new Date(attempt.lockedUntil) > now) return;

        const resetWindow = !attempt || now.getTime() - new Date(attempt.firstFailedAt).getTime() >= LOCKOUT_DURATION_MS;
        const failureCount = resetWindow ? 1 : attempt.failureCount + 1;
        const data = {
          failureCount,
          firstFailedAt: resetWindow ? now : attempt.firstFailedAt,
          lockedUntil: failureCount >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : resetWindow ? null : attempt.lockedUntil,
          updatedAt: now,
        };

        if (attempt) {
          await tx.loginAttempt.update({ where: { identifierHash }, data });
        } else {
          await tx.loginAttempt.create({ data: { identifierHash, ...data } });
        }
      });

      // Bound storage growth without adding work to every login request.
      const now = Date.now();
      if (now - lastLoginAttemptCleanupAt >= 24 * 60 * 60 * 1000) {
        lastLoginAttemptCleanupAt = now;
        const cutoff = new Date(now - LOGIN_ATTEMPT_CLEANUP_AGE_MS);
        await this.prisma.loginAttempt.deleteMany({ where: { updatedAt: { lt: cutoff } } }).catch((error) => {
          this.logger.warn?.({ errorCode: error.code || 'LOGIN_ATTEMPT_CLEANUP_FAILED' }, 'Login-attempt cleanup failed');
        });
      }
    } catch (error) {
      if (this.isProduction) throw this._authenticationStorageError();
      recordFailedLogin(identifier);
    }
  }

  async _clearLoginThrottling(identifier) {
    if (!this._hasPersistentLoginAttemptStorage()) {
      if (this.isProduction) throw this._authenticationStorageError();
      clearLoginThrottling(identifier);
      return;
    }

    try {
      await this.prisma.loginAttempt.deleteMany({ where: { identifierHash: this._loginAttemptHash(identifier) } });
    } catch (error) {
      if (this.isProduction) throw this._authenticationStorageError();
      clearLoginThrottling(identifier);
    }
  }

  /**
   * Generates a verified test/dev session for automated tests and local dev enrollment.
   */
  async createTestSession({
    userId = 'test-user-admin-1',
    email = 'admin@enterprise.local',
    displayName = 'Enterprise Admin',
    role = Roles.ORGANIZATION_ADMIN,
    organizationId = '00000000-0000-0000-0000-000000000000',
    ...rest
  } = {}) {
    const token = `dp_test_${crypto.randomBytes(24).toString('hex')}`;
    const sessionObj = {
      id: crypto.randomUUID(),
      userId,
      token,
      expiresAt: new Date(Date.now() + 86400000),
      user: {
        id: userId,
        email,
        displayName,
        role: normalizeRole(role),
        organizationId,
        ...rest,
      },
    };
    inMemorySessions.set(`token:${token}`, sessionObj);
    return { token, headers: { authorization: `Bearer ${token}` }, session: sessionObj };
  }

  /**
   * Registers the first owner of a new organization.
   *
   * Public registration deliberately has no organization or role input. Existing
   * organization membership is created only through acceptInvitation().
   */
  async register({ email, password, displayName, organizationName }) {
    if (!email || !email.includes('@')) {
      const err = new Error('Valid email address is required');
      err.statusCode = 400;
      throw err;
    }
    const cleanEmail = email.toLowerCase().trim();
    const { hash, salt } = hashPassword(password);
    const assignedRole = Roles.ORGANIZATION_ADMIN;

    if (this.isProduction && (!this.prisma?.user?.findFirst || !this.prisma?.user?.create || !this.prisma?.organization?.create || !this.prisma?.$transaction)) {
      const unavailable = new Error('Transactional registration storage is unavailable');
      unavailable.statusCode = 503;
      throw unavailable;
    }

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

        const createOrganizationAndOwner = async (tx) => {
          const org = await tx.organization.create({
            data: {
              name: organizationName || `${displayName || 'Family'}'s Household`,
              slug: `household-${crypto.randomBytes(4).toString('hex')}`,
            },
          });
          const newUser = await tx.user.create({
            data: {
              organizationId: org.id,
              email: cleanEmail,
              displayName: displayName || cleanEmail.split('@')[0],
              // Persist the canonical organization-admin enum value. The API
              // normalizes legacy OWNER/FAMILY_OWNER aliases on read.
              role: 'ORG_ADMIN',
              passwordHash: hash,
              passwordSalt: salt,
            },
          });
          return { org, newUser };
        };

        const { org, newUser } = this.prisma.$transaction
          ? await this.prisma.$transaction(createOrganizationAndOwner)
          : await createOrganizationAndOwner(this.prisma);

        await this.logAuthEvent({
          organizationId: org.id,
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
        if (this.isProduction) {
          const unavailable = new Error('Registration storage is unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
        // In unit test or fallback mode when DB is unavailable:
        return this._registerMemory({
          cleanEmail,
          hash,
          salt,
          displayName,
          assignedRole,
          organizationName,
        });
      }
    }

    if (this.isProduction) {
      const unavailable = new Error('Persistent registration storage is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
    }

    return this._registerMemory({ cleanEmail, hash, salt, displayName, assignedRole, organizationName });
  }

  async _registerInvitedUser({ email, password, displayName, organizationId, role, departmentId, employeeNumber, shiftStart, shiftEnd, workingDays, shiftTimezone }) {
    const cleanEmail = email.toLowerCase().trim();
    const { hash, salt } = hashPassword(password);
    const assignedRole = normalizeRole(role) === Roles.MANAGER ? Roles.MANAGER : Roles.EMPLOYEE;

    if (this.isProduction && (!this.prisma?.user?.findFirst || !this.prisma?.user?.create || !this.prisma?.$transaction)) {
      const unavailable = new Error('Transactional employee registration storage is unavailable');
      unavailable.statusCode = 503;
      throw unavailable;
    }

    if (this.prisma?.user?.findFirst) {
      const existing = await this.prisma.user.findFirst({ where: { email: cleanEmail } });
      if (existing) {
        const err = new Error('A user with this email already exists');
        err.statusCode = 409;
        throw err;
      }

      const createUser = async (tx) =>
        tx.user.create({
          data: {
            organizationId,
            departmentId: departmentId || null,
            email: cleanEmail,
            displayName: displayName || cleanEmail.split('@')[0],
            role: assignedRole,
            passwordHash: hash,
            passwordSalt: salt,
            employeeNumber,
            shiftStart,
            shiftEnd,
            workingDays,
            shiftTimezone,
          },
        });

      const user = this.prisma.$transaction
        ? await this.prisma.$transaction(createUser)
        : await createUser(this.prisma);
      return { user, assignedRole };
    }

    return {
      user: this._registerMemory({
        cleanEmail,
        hash,
        salt,
        displayName,
        assignedRole,
        organizationId,
      }),
      assignedRole,
    };
  }

  _registerMemory({ cleanEmail, hash, salt, displayName, assignedRole, organizationId }) {
    const memoryUser = {
      id: crypto.randomUUID(),
      organizationId: organizationId || crypto.randomUUID(),
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
  async login({ email, password, rememberMe = true, ipAddress = '127.0.0.1', userAgent = 'DigitalPulse Client' }) {
    if (!email || !password) {
      const err = new Error('Email and password are required');
      err.statusCode = 400;
      throw err;
    }
    const cleanEmail = email.toLowerCase().trim();

    if (this.isProduction && (!this.prisma?.user?.findFirst || !this.prisma?.userSession?.create || !this._hasPersistentLoginAttemptStorage())) {
      const unavailable = this._authenticationStorageError();
      unavailable.message = 'Persistent authentication storage is unavailable';
      throw unavailable;
    }

    // Check throttling through the shared PostgreSQL store in production.
    const throttleCheck = await this._checkLoginThrottling(cleanEmail);
    if (!throttleCheck.allowed) {
      const err = new Error(throttleCheck.reason);
      err.statusCode = 429;
      throw err;
    }

    let user = null;

    if (this.isProduction && (!this.prisma?.user?.findFirst || !this.prisma?.userSession?.create)) {
      const unavailable = new Error('Persistent authentication storage is unavailable');
      unavailable.statusCode = 503;
      throw unavailable;
    }

    if (this.prisma?.user?.findFirst) {
      try {
        if (this.prisma.user.findMany) {
          const matchingAccounts = await this.prisma.user.findMany({ where: { email: cleanEmail }, take: 2 });
          user = matchingAccounts.length === 1 ? matchingAccounts[0] : null;
        } else {
          user = await this.prisma.user.findFirst({ where: { email: cleanEmail } });
        }
      } catch {
        if (this.isProduction) {
          const unavailable = new Error('Authentication storage is unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
      }
    }

    if (!user && !this.isProduction) {
      user = inMemorySessions.get(`user:${cleanEmail}`);
    }

    if (!user || !user.passwordHash || !user.passwordSalt) {
      await this._recordFailedLogin(cleanEmail);
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
      await this._recordFailedLogin(cleanEmail);
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
    await this._clearLoginThrottling(cleanEmail);

    const token = crypto.randomBytes(32).toString('hex');
    const sessionLifetimeMs = rememberMe ? 7 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
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

    // Save session in DB if available
    if (this.prisma?.userSession?.create) {
      try {
        await this.prisma.userSession.create({
          data: {
            id: sessionData.id,
            userId: user.id,
            tokenHash: hashSessionToken(token),
            userAgent,
            ipAddress,
            expiresAt,
          },
        });
      } catch {
        if (this.isProduction) {
          const unavailable = new Error('Session storage is unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
      }
    } else if (this.isProduction) {
      const unavailable = new Error('Persistent session storage is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
    }

    if (!this.isProduction) inMemorySessions.set(`token:${token}`, sessionData);

    await this.logAuthEvent({
      organizationId: user.organizationId,
      action: 'LOGIN_SUCCESS',
      actor: cleanEmail,
      details: { sessionId: sessionData.id, ipAddress },
    });

    return {
      token,
      expiresAt,
      rememberMe: Boolean(rememberMe),
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
    const cached = this.isProduction ? null : inMemorySessions.get(`token:${token}`);
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
          where: { tokenHash: hashSessionToken(token) },
          include: { user: true },
        });
        if (
          dbSession &&
          !dbSession.revokedAt &&
          new Date(dbSession.expiresAt) > new Date() &&
          dbSession.user.employmentStatus !== 'disabled' &&
          dbSession.user.employmentStatus !== 'terminated'
        ) {
          const sessionObj = {
            id: dbSession.id,
            userId: dbSession.userId,
            token,
            userAgent: dbSession.userAgent,
            ipAddress: dbSession.ipAddress,
            expiresAt: dbSession.expiresAt,
            user: {
              id: dbSession.user.id,
              email: dbSession.user.email,
              displayName: dbSession.user.displayName,
              role: normalizeRole(dbSession.user.role),
              organizationId: dbSession.user.organizationId,
              employmentStatus: dbSession.user.employmentStatus || 'active',
            },
          };
          if (!this.isProduction) inMemorySessions.set(`token:${token}`, sessionObj);
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

    if (this.isProduction && !this.prisma?.userSession?.updateMany) {
      const unavailable = new Error('Persistent session revocation is unavailable');
      unavailable.statusCode = 503;
      throw unavailable;
    }
    if (this.prisma?.userSession?.updateMany) {
      try {
        await this.prisma.userSession.updateMany({
          where: { tokenHash: hashSessionToken(token) },
          data: { revokedAt: new Date() },
        });
      } catch {
        if (this.isProduction) {
          const unavailable = new Error('Session revocation is temporarily unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
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
   * Requests a password reset token.
   * Produces an expiring, single-use reset token with secure storage (SHA-256 hash).
   * In production, the raw token is delivered via email and never exposed in the API response.
   */
  async requestPasswordReset({ email }) {
    const cleanEmail = email?.toLowerCase().trim();
    if (!cleanEmail) {
      const err = new Error('Email is required');
      err.statusCode = 400;
      throw err;
    }

    let user = null;
    if (this.prisma?.user?.findFirst) {
      try {
        user = await this.prisma.user.findFirst({ where: { email: cleanEmail } });
      } catch {
        // Fallback to in memory
      }
    }
    if (!user) {
      user = inMemorySessions.get(`user:${cleanEmail}`);
    }

    // Always generate secure random token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const orgId = user?.organizationId || '00000000-0000-0000-0000-000000000000';

    const isProduction = this.isProduction;
    if (user && this.prisma?.passwordResetToken?.create) {
      try {
        await this.prisma.passwordResetToken.create({
          data: {
            tokenHash,
            userId: user.id,
            expiresAt,
          },
        });
      } catch {
        if (isProduction) {
          const err = new Error('Password reset is temporarily unavailable');
          err.statusCode = 503;
          throw err;
        }
      }
    } else if (user && isProduction) {
      const err = new Error('Password reset is not configured');
      err.statusCode = 503;
      throw err;
    }

    // In-memory reset state is development/test-only and never used in production.
    if (!isProduction) {
      resetTokens.set(tokenHash, {
        tokenHash,
        email: user?.email || cleanEmail,
        userId: user?.id,
        organizationId: user?.organizationId,
        expiresAt,
        usedAt: null,
      });
    }

    // Audited event (never log token!)
    await this.logAuthEvent({
      organizationId: orgId,
      action: 'PASSWORD_RESET_REQUESTED',
      actor: cleanEmail,
      details: { expiresAt: expiresAt.toISOString() },
    });

    const emailProviderConfigured = this.emailService.configured;

    if (user && emailProviderConfigured) {
      try {
        await this.emailService.sendPasswordResetEmail({
          to: user.email,
          resetToken,
          resetUrl: this.config.passwordResetUrl || process.env.PASSWORD_RESET_URL || 'http://localhost:5173/reset-password',
        });
      } catch (error) {
        this.logger.error?.({ err: error, email: cleanEmail }, 'Password reset email delivery failed');
        const err = new Error('Password reset is temporarily unavailable');
        err.statusCode = 503;
        throw err;
      }
    }

    const response = {
      success: true,
      message: 'If the account exists, a password reset instruction has been processed.',
    };

    // Only expose reset token if in non-production environment for test/dev usability without SMTP
    if (!isProduction && !emailProviderConfigured && user) {
      response.resetToken = resetToken;
    }

    return response;
  }

  /**
   * Confirms password reset using expiring, single-use reset token.
   */
  async confirmPasswordReset({ email, resetToken, newPassword }) {
    const cleanEmail = email?.toLowerCase().trim();
    if (!resetToken || !newPassword) {
      const err = new Error('Reset token and new password are required');
      err.statusCode = 400;
      throw err;
    }

    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const isProduction = this.isProduction;
    let record = null;

    if (!isProduction && resetTokens.has(tokenHash)) {
      record = resetTokens.get(tokenHash);
    }

    if (!record && this.prisma?.passwordResetToken?.findUnique) {
      try {
        const dbToken = await this.prisma.passwordResetToken.findUnique({
          where: { tokenHash },
          include: { user: true },
        });
        if (dbToken) {
          record = {
            id: dbToken.id,
            tokenHash: dbToken.tokenHash,
            userId: dbToken.userId,
            email: dbToken.user?.email,
            expiresAt: dbToken.expiresAt,
            usedAt: dbToken.usedAt,
            organizationId: dbToken.user?.organizationId,
          };
        }
      } catch {
        // Fallback
      }
    }

    if (!record || record.usedAt || new Date(record.expiresAt) < new Date()) {
      const err = new Error('Invalid, expired, or already used password reset token');
      err.statusCode = 400;
      throw err;
    }

    if (cleanEmail && record.email && cleanEmail !== record.email.toLowerCase()) {
      const err = new Error('Reset token does not match the supplied account');
      err.statusCode = 400;
      throw err;
    }

    const { hash, salt } = hashPassword(newPassword);
    const targetUserId = record.userId;
    const consumedAt = new Date();

    if (this.prisma?.$transaction && this.prisma.passwordResetToken?.updateMany) {
      await this.prisma.$transaction(async (tx) => {
        const consumed = await tx.passwordResetToken.updateMany({
          where: { tokenHash, usedAt: null },
          data: { usedAt: consumedAt },
        });
        if (consumed.count !== 1) {
          const err = new Error('Invalid, expired, or already used password reset token');
          err.statusCode = 400;
          throw err;
        }
        await tx.user.update({
          where: { id: targetUserId },
          data: { passwordHash: hash, passwordSalt: salt },
        });
        if (tx.userSession?.updateMany) {
          await tx.userSession.updateMany({
            where: { userId: targetUserId, revokedAt: null },
            data: { revokedAt: consumedAt },
          });
        }
      });
    } else if (this.prisma?.user?.update && !isProduction) {
      await this.prisma.user.update({
        where: { id: targetUserId },
        data: { passwordHash: hash, passwordSalt: salt },
      });
      record.usedAt = consumedAt;
    } else {
      const err = new Error('Password reset is temporarily unavailable');
      err.statusCode = 503;
      throw err;
    }

    resetTokens.delete(tokenHash);
    const memUser = inMemorySessions.get(`user:${record.email || cleanEmail}`);
    if (memUser) {
      memUser.passwordHash = hash;
      memUser.passwordSalt = salt;
    }
    for (const [key, session] of inMemorySessions.entries()) {
      if (key.startsWith('token:') && session.userId === targetUserId) {
        session.revokedAt = consumedAt;
        inMemorySessions.delete(key);
      }
    }

    await this.logAuthEvent({
      organizationId: record.organizationId || '00000000-0000-0000-0000-000000000000',
      action: 'PASSWORD_RESET_CONFIRMED',
      actor: record.email || cleanEmail || 'system',
      details: {},
    });

    return { success: true, message: 'Password successfully reset' };
  }

  /**
   * Creates an employee/user invitation token for an organization.
   */
  async createInvitation({ organizationId, email, role = 'EMPLOYEE', departmentId = null, invitedBy = 'Admin', displayName = null, shiftStart = '09:00', shiftEnd = '17:00', workingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], shiftTimezone = 'UTC' }) {
    if (!organizationId || !email) {
      const err = new Error('organizationId and email are required');
      err.statusCode = 400;
      throw err;
    }
    const cleanEmail = String(email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      const err = new Error('A valid employee email address is required');
      err.statusCode = 400;
      throw err;
    }
    const validTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(shiftStart) || !validTime(shiftEnd) || shiftStart === shiftEnd) {
      const err = new Error('Working hours must use valid 24-hour times with different start and end values');
      err.statusCode = 400;
      throw err;
    }
    if (!Array.isArray(workingDays) || !workingDays.length || workingDays.some((day) => !['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(day))) {
      const err = new Error('Select at least one valid working day');
      err.statusCode = 400;
      throw err;
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: shiftTimezone }); }
    catch {
      const err = new Error('A valid IANA time zone is required');
      err.statusCode = 400;
      throw err;
    }

    const token = `dp_inv_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    if (!this.prisma?.invitation?.create) {
      const err = new Error('Invitation storage is unavailable');
      err.statusCode = 503;
      throw err;
    }
    const roleValue = normalizeRole(role) === Roles.MANAGER ? 'MANAGER' : 'EMPLOYEE';
    if (this.prisma.invitation.findFirst) {
      const active = await this.prisma.invitation.findFirst({ where: { organizationId, email: cleanEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (active) {
        const err = new Error('A pending invitation already exists for this email');
        err.statusCode = 409;
        throw err;
      }
    }
    const invitation = await this.prisma.invitation.create({
      data: { token: null, tokenHash, organizationId, email: cleanEmail, role: roleValue, departmentId,
        displayName: displayName?.trim() || null, shiftStart, shiftEnd, workingDays, shiftTimezone, invitedBy, expiresAt },
    });

    const baseUrl = this.config.invitationAcceptUrl || process.env.INVITATION_ACCEPT_URL || 'http://localhost:5173/accept-invitation';
    const makeInvitationUrl = () => {
      const link = new URL(baseUrl);
      // Keep the bearer token in the URL fragment so it is not sent to the web
      // server in request logs or Referer headers.
      link.hash = new URLSearchParams({ token }).toString();
      return link.toString();
    };
    let emailSent = false;
    if (this.emailService?.configured) {
      try {
        await this.emailService.sendInvitationEmail({
          to: cleanEmail,
          token,
          invitationUrl: baseUrl,
        });
        emailSent = true;
      } catch (error) {
        // Do not log provider error details: mail transport errors can contain message content.
        this.logger.warn?.({ invitationId: invitation.id }, 'Invitation email delivery failed');
      }
    }

    return {
      success: true,
      invitation: { id: invitation.id, email: cleanEmail, role: roleValue, displayName: displayName?.trim() || null },
      emailSent,
      organizationId,
      expiresAt: expiresAt.toISOString(),
      invitationUrl: makeInvitationUrl(),
    };
  }

  /**
   * Looks up a bearer token by its SHA-256 digest and returns only public invitation details.
   */
  async getInvitationDetails(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) {
      const err = new Error('This invitation link is invalid. Ask your organization for a new link.');
      err.statusCode = 404;
      throw err;
    }
    if (!this.prisma?.invitation?.findFirst) {
      const err = new Error('Invitation validation is temporarily unavailable. Please try again later.');
      err.statusCode = 503;
      throw err;
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    let invitation;
    try {
      invitation = await this.prisma.invitation.findFirst({ where: { tokenHash } });
    } catch (cause) {
      this.logger.warn?.({ errorCode: cause.code || 'INVITATION_LOOKUP_FAILED' }, 'Invitation validation lookup failed');
      throw invitationError('Invitation validation is temporarily unavailable. Please try again later.', 503, 'INVITATION_VALIDATION_UNAVAILABLE');
    }
    if (!invitation) {
      const err = new Error('This invitation link is invalid. Ask your organization for a new link.');
      err.statusCode = 404;
      throw err;
    }
    if (invitation.acceptedAt) {
      const err = new Error('This invitation has already been accepted. Sign in or ask your organization for help.');
      err.statusCode = 409;
      throw err;
    }
    if (invitation.revokedAt) {
      const err = new Error('This invitation has been revoked. Ask your organization for a new link.');
      err.statusCode = 410;
      throw err;
    }
    if (new Date(invitation.expiresAt) <= new Date()) {
      const err = new Error('This invitation has expired. Ask your organization to resend it.');
      err.statusCode = 410;
      throw err;
    }

    let organization;
    let department;
    try {
      [organization, department] = await Promise.all([
        this.prisma.organization?.findUnique
          ? this.prisma.organization.findUnique({ where: { id: invitation.organizationId }, select: { name: true } })
          : null,
        invitation.departmentId && this.prisma.department?.findFirst
          ? this.prisma.department.findFirst({ where: { id: invitation.departmentId, organizationId: invitation.organizationId }, select: { name: true } })
          : null,
      ]);
    } catch (cause) {
      this.logger.warn?.({ errorCode: cause.code || 'INVITATION_DETAILS_FAILED' }, 'Invitation details lookup failed');
      throw invitationError('Invitation details are temporarily unavailable. Please try again later.', 503, 'INVITATION_VALIDATION_UNAVAILABLE');
    }
    return {
      valid: true,
      invitation: {
        displayName: invitation.displayName,
        email: invitation.email,
        role: normalizeRole(invitation.role) === Roles.MANAGER ? Roles.MANAGER : Roles.EMPLOYEE,
        department: department?.name || null,
        shiftStart: invitation.shiftStart,
        shiftEnd: invitation.shiftEnd,
        workingDays: invitation.workingDays,
        shiftTimezone: invitation.shiftTimezone,
        expiresAt: new Date(invitation.expiresAt).toISOString(),
        organizationName: organization?.name || 'your organization',
      },
    };
  }

  /** Rotates the one-time token and expiry for an existing invitation. */
  async resendInvitation({ organizationId, invitationId, invitedBy }) {
    if (!this.prisma?.invitation?.findFirst || !this.prisma?.invitation?.updateMany) {
      const err = new Error('Invitation storage is unavailable');
      err.statusCode = 503;
      throw err;
    }
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
    });
    if (!invitation) {
      const err = new Error('Pending invitation not found');
      err.statusCode = 404;
      throw err;
    }
    const token = `dp_inv_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const rotated = await this.prisma.invitation.updateMany({
      where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
      data: { token: null, tokenHash, expiresAt, invitedBy: invitedBy || invitation.invitedBy },
    });
    if (rotated.count !== 1) {
      const err = new Error('This invitation has already been accepted or revoked');
      err.statusCode = 409;
      throw err;
    }

    const baseUrl = this.config.invitationAcceptUrl || process.env.INVITATION_ACCEPT_URL || 'http://localhost:5173/accept-invitation';
    const link = new URL(baseUrl);
    link.hash = new URLSearchParams({ token }).toString();
    let emailSent = false;
    if (this.emailService?.configured) {
      try {
        await this.emailService.sendInvitationEmail({ to: invitation.email, token, invitationUrl: baseUrl });
        emailSent = true;
      } catch {
        this.logger.warn?.({ invitationId }, 'Invitation email delivery failed');
      }
    }
    return {
      success: true,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: normalizeRole(invitation.role) === Roles.MANAGER ? Roles.MANAGER : Roles.EMPLOYEE,
        displayName: invitation.displayName,
      },
      organizationId: invitation.organizationId,
      expiresAt: expiresAt.toISOString(),
      emailSent,
      invitationUrl: link.toString(),
    };
  }

  /**
   * Accept an invitation, creating a new user or attaching an already
   * authenticated account in the invitation's existing organization.
   */
  async acceptInvitation({ token, password, displayName, authenticatedUser }) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) {
      throw invitationError('This invitation link is invalid. Ask your organization for a new link.', 404, 'INVITATION_INVALID');
    }
    if (!this.prisma?.$transaction || !this.prisma.$executeRaw || !this.prisma.invitation?.findFirst || !this.prisma.user?.findMany) {
      throw invitationError('Invitation acceptance is temporarily unavailable. Please try again later.', 503, 'INVITATION_STORAGE_UNAVAILABLE');
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const validateInvitation = (invitation) => {
      if (!invitation) throw invitationError('This invitation link is invalid. Ask your organization for a new link.', 404, 'INVITATION_INVALID');
      if (invitation.acceptedAt) throw invitationError('This invitation has already been accepted. Sign in or ask your organization for help.', 409, 'INVITATION_ALREADY_ACCEPTED');
      if (invitation.revokedAt) throw invitationError('This invitation has been revoked. Ask your organization for a new link.', 410, 'INVITATION_REVOKED');
      if (new Date(invitation.expiresAt) <= new Date()) throw invitationError('This invitation has expired. Ask your organization to resend it.', 410, 'INVITATION_EXPIRED');
    };

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        let invitation = await tx.invitation.findFirst({ where: { tokenHash } });
        validateInvitation(invitation);

        const email = String(invitation.email).toLowerCase().trim();
        // Serialize acceptances for the same normalized email across distinct
        // invitations and organizations. The User model has no membership
        // table or globally unique email index, so this lock prevents two
        // concurrent invitations from creating ambiguous duplicate accounts.
        if (typeof tx.$executeRaw !== 'function') {
          throw invitationError('Invitation acceptance conflict protection is unavailable. Please try again later.', 503, 'INVITATION_STORAGE_UNAVAILABLE');
        }
        const lockKey = crypto.createHash('sha256').update(email).digest();
        // pg_advisory_xact_lock returns PostgreSQL `void`; Prisma's queryRaw
        // result decoder rejects that type. executeRaw still awaits the lock
        // while holding it through the surrounding interactive transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey.readInt32BE(0)}::integer, ${lockKey.readInt32BE(4)}::integer)`;
        // A same-token acceptance may have committed while this transaction
        // waited for the email lock. Re-read under the lock so replay reports
        // the accepted state instead of treating the new user as an old one.
        invitation = await tx.invitation.findFirst({ where: { tokenHash } });
        validateInvitation(invitation);
        const existingUsers = await tx.user.findMany({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: {
            id: true,
            organizationId: true,
            email: true,
            displayName: true,
            role: true,
            employmentStatus: true,
            departmentId: true,
            shiftStart: true,
            shiftEnd: true,
            workingDays: true,
            shiftTimezone: true,
          },
        });

        const invitedRole = normalizeRole(invitation.role) === Roles.MANAGER ? Roles.MANAGER : Roles.EMPLOYEE;
        if (existingUsers.length > 0) {
          if (!authenticatedUser) {
            return { kind: 'existing-account-sign-in-required' };
          }
          if (String(authenticatedUser.email || '').toLowerCase().trim() !== email
            || !existingUsers.some((account) => account.id === authenticatedUser.id)) {
            throw invitationError('Sign in with the invited email address before accepting this invitation.', 403, 'INVITATION_ACCOUNT_MISMATCH');
          }
          if (existingUsers.length !== 1) {
            throw invitationError('This email is associated with multiple DigitalPulse accounts. Contact your organization administrator for help.', 409, 'ACCOUNT_RECORD_CONFLICT');
          }

          const account = existingUsers[0];
          if (authenticatedUser.organizationId !== account.organizationId) {
            throw invitationError('Your current sign-in no longer matches this account. Sign in again with the invited email.', 403, 'INVITATION_ACCOUNT_MISMATCH');
          }
          if (account.organizationId !== invitation.organizationId) {
            throw invitationError('This account already belongs to another DigitalPulse organization. Multi-organization membership is not available yet. Ask the inviting administrator to use an account in this organization or contact support.', 409, 'ORGANIZATION_MEMBERSHIP_UNSUPPORTED');
          }
          if (normalizeRole(account.role) !== invitedRole) {
            throw invitationError('This invitation role does not match your existing account role. Ask the organization administrator to correct the invitation.', 409, 'INVITATION_ROLE_CONFLICT');
          }
          if (String(account.employmentStatus || 'active').toLowerCase() !== 'active') {
            throw invitationError('This account is inactive. Ask your organization administrator to reactivate it before accepting the invitation.', 409, 'ACCOUNT_INACTIVE');
          }

          const acceptedAt = new Date();
          const consumed = await tx.invitation.updateMany({
            where: { id: invitation.id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: acceptedAt } },
            data: { acceptedAt, token: null },
          });
          if (consumed.count !== 1) {
            throw invitationError('This invitation has already been accepted or is no longer active.', 409, 'INVITATION_ALREADY_ACCEPTED');
          }

          // User is the employee record in this schema. Attach the invited
          // department and work schedule while preserving identity, role,
          // organization, existing display name, and password credentials.
          const user = await tx.user.update({
            where: { id: account.id },
            data: {
              departmentId: invitation.departmentId ?? account.departmentId,
              shiftStart: invitation.shiftStart ?? account.shiftStart,
              shiftEnd: invitation.shiftEnd ?? account.shiftEnd,
              workingDays: invitation.workingDays ?? account.workingDays,
              shiftTimezone: invitation.shiftTimezone ?? account.shiftTimezone,
            },
          });
          return { kind: 'accepted', user, role: account.role, existingAccount: true };
        }

        const cleanName = typeof displayName === 'string' ? displayName.trim() : '';
        if (!isValidPersonName(cleanName)) {
          throw invitationError('Enter your full name. It must be a person’s name, not an email address.', 400, 'INVALID_DISPLAY_NAME');
        }
        if (typeof password !== 'string' || password.length < 8) {
          throw invitationError('Use a password with at least 8 characters.', 400, 'INVALID_PASSWORD');
        }
        const { hash, salt } = hashPassword(password);
        const acceptedAt = new Date();
        const consumed = await tx.invitation.updateMany({
          where: { id: invitation.id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: acceptedAt } },
          data: { acceptedAt, token: null },
        });
        if (consumed.count !== 1) {
          throw invitationError('This invitation has already been accepted or is no longer active.', 409, 'INVITATION_ALREADY_ACCEPTED');
        }

        const user = await tx.user.create({
          data: {
            organizationId: invitation.organizationId,
            departmentId: invitation.departmentId || null,
            email,
            displayName: cleanName,
            role: invitedRole,
            passwordHash: hash,
            passwordSalt: salt,
            employeeNumber: `EMP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
            shiftStart: invitation.shiftStart || '09:00',
            shiftEnd: invitation.shiftEnd || '17:00',
            workingDays: invitation.workingDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            shiftTimezone: invitation.shiftTimezone || 'UTC',
          },
        });
        return { kind: 'accepted', user, role: invitedRole, existingAccount: false };
      });

      if (result.kind === 'existing-account-sign-in-required') {
        throw invitationError('This email already has a DigitalPulse account. Sign in with the invited email to accept this invitation.', 409, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
      }
      return {
        success: true,
        user: {
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.displayName,
          role: normalizeRole(result.role),
          organizationId: result.user.organizationId,
        },
        existingAccount: result.existingAccount,
      };
    } catch (error) {
      if (error.statusCode) throw error;
      if (error.code === 'P2002') {
        throw invitationError('An account with this email already exists. Sign in with that account to accept the invitation.', 409, 'EXISTING_ACCOUNT_REQUIRES_AUTH');
      }
      this.logger.warn?.({ errorCode: error.code || 'INVITATION_ACCEPTANCE_FAILED' }, 'Invitation acceptance transaction failed');
      throw invitationError('Invitation acceptance could not be completed. Please try again later.', 503, 'INVITATION_ACCEPTANCE_UNAVAILABLE');
    }
  }

  /**
   * Lists invitations for an organization.
   */
  async listInvitations(organizationId) {
    if (this.prisma?.invitation?.findMany) {
      try {
        const where = {};
        if (organizationId) where.organizationId = organizationId;
        const rows = await this.prisma.invitation.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            role: true,
            departmentId: true,
            displayName: true,
            shiftStart: true,
            shiftEnd: true,
            workingDays: true,
            shiftTimezone: true,
            invitedBy: true,
            expiresAt: true,
            acceptedAt: true,
            revokedAt: true,
            createdAt: true,
          },
        });
        return rows.map((row) => ({ ...row, status: row.revokedAt ? 'revoked' : row.acceptedAt ? 'accepted' : new Date(row.expiresAt) <= new Date() ? 'expired' : 'pending' }));
      } catch (cause) {
        const error = new Error('Invitation records could not be loaded');
        error.statusCode = 503;
        error.cause = cause;
        throw error;
      }
    }
    const error = new Error('Invitation storage is unavailable');
    error.statusCode = 503;
    throw error;
  }

  /**
   * Revokes a pending invitation.
   */
  async revokeInvitation({ organizationId, invitationId }) {
    if (this.prisma?.invitation?.updateMany) {
      try {
        const where = { id: invitationId, acceptedAt: null, revokedAt: null };
        if (organizationId) where.organizationId = organizationId;
        // Keep the one-way digest so a link opened after revocation can show a clear reason.
        // The raw bearer token is never stored.
        const res = await this.prisma.invitation.updateMany({ where, data: { revokedAt: new Date(), token: null } });
        return { success: res.count > 0 };
      } catch (error) {
        throw error;
      }
    }
    const err = new Error('Invitation storage is unavailable');
    err.statusCode = 503;
    throw err;
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
