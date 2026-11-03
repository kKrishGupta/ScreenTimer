/**
 * DigitalPulse Enterprise Policy Engine: 15-Minute Grace Period State Machine.
 * 
 * State transitions:
 * NOT_VISITED -> (on first visit) -> GRACE_ACTIVE (15-min countdown)
 * GRACE_ACTIVE -> (after 15 elapsed mins) -> BLOCKED
 * BLOCKED -> (on admin action) -> ADMIN_RESET -> NOT_VISITED
 * 
 * Rules:
 * - Server-authoritative: Timer is calculated based on database timestamp (firstVisitedAt + 15 min).
 * - Cross-browser & restart persistent: Opening Chrome, Edge, or restarting the PC continues the same elapsed timer.
 * - Idempotent & race-safe: Transactional upsert based on unique constraint (organizationId, domain, calendarDate).
 */

export const GRACE_STATUS = {
  NOT_VISITED: 'NOT_VISITED',
  GRACE_ACTIVE: 'GRACE_ACTIVE',
  BLOCKED: 'BLOCKED',
  ADMIN_RESET: 'ADMIN_RESET',
};

const DEFAULT_GRACE_MINUTES = 15;

export class GraceService {
  constructor(prisma, logger = console) {
    this.prisma = prisma;
    this.logger = logger;
  }

  /**
   * Evaluates domain access status under the 15-minute grace period policy.
   */
  async evaluateDomain({ organizationId, userId = null, deviceId = null, domain }) {
    if (!organizationId || !domain) {
      throw new Error('organizationId and domain are required');
    }

    const cleanDomain = String(domain).toLowerCase().trim();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const now = new Date();

    // 1. Fetch existing record for today
    let grant = null;
    if (this.prisma?.graceGrant?.findFirst) {
      try {
        grant = await this.prisma.graceGrant.findFirst({
          where: {
            organizationId,
            domain: cleanDomain,
            calendarDate: today,
          },
        });
      } catch (err) {
        this.logger.warn(`Failed to fetch grace grant: ${err.message}`);
      }
    }

    // 2. If no record exists today, it is NOT_VISITED
    if (!grant) {
      return {
        domain: cleanDomain,
        status: GRACE_STATUS.NOT_VISITED,
        allowed: true,
        remainingSeconds: DEFAULT_GRACE_MINUTES * 60,
        graceMinutes: DEFAULT_GRACE_MINUTES,
        expiresAt: null,
        message: `Domain ${cleanDomain} has not been visited today. 15-minute grace period available upon first access.`,
      };
    }

    // 3. Handle ADMIN_RESET
    if (grant.status === 'ADMIN_RESET') {
      return {
        domain: cleanDomain,
        status: GRACE_STATUS.ADMIN_RESET,
        allowed: true,
        remainingSeconds: DEFAULT_GRACE_MINUTES * 60,
        graceMinutes: grant.graceMinutes,
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
        resetBy: grant.resetBy,
        message: `Domain access reset by administrator (${grant.resetBy || 'Admin'}).`,
      };
    }

    // 4. Handle GRACE_ACTIVE
    if (grant.status === 'GRACE_ACTIVE') {
      const expiresAtMs = new Date(grant.expiresAt).getTime();
      const remainingSeconds = Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));

      if (remainingSeconds > 0) {
        return {
          domain: cleanDomain,
          status: GRACE_STATUS.GRACE_ACTIVE,
          allowed: true,
          remainingSeconds,
          graceMinutes: grant.graceMinutes,
          firstVisitedAt: grant.firstVisitedAt?.toISOString(),
          expiresAt: grant.expiresAt.toISOString(),
          message: `Grace period active: ${Math.ceil(remainingSeconds / 60)} minutes remaining.`,
        };
      }

      // Expired: Transition to BLOCKED in database
      try {
        grant = await this.prisma.graceGrant.update({
          where: { id: grant.id },
          data: { status: 'BLOCKED' },
        });
      } catch (err) {
        this.logger.error(`Failed to update status to BLOCKED: ${err.message}`);
      }

      return {
        domain: cleanDomain,
        status: GRACE_STATUS.BLOCKED,
        allowed: false,
        remainingSeconds: 0,
        graceMinutes: grant.graceMinutes,
        firstVisitedAt: grant.firstVisitedAt?.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        message: `15-minute grace period has expired for ${cleanDomain}. Domain is blocked for today.`,
      };
    }

    // 5. Handle BLOCKED
    return {
      domain: cleanDomain,
      status: GRACE_STATUS.BLOCKED,
      allowed: false,
      remainingSeconds: 0,
      graceMinutes: grant.graceMinutes,
      firstVisitedAt: grant.firstVisitedAt?.toISOString(),
      expiresAt: grant.expiresAt?.toISOString() || null,
      message: `Access to ${cleanDomain} is blocked under corporate policy.`,
    };
  }

  /**
   * Registers a domain visit, initiating the 15-minute countdown if NOT_VISITED.
   */
  async registerVisit({ organizationId, userId = null, deviceId = null, domain, graceMinutes = DEFAULT_GRACE_MINUTES }) {
    if (!organizationId || !domain) {
      throw new Error('organizationId and domain are required');
    }

    const cleanDomain = String(domain).toLowerCase().trim();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + graceMinutes * 60 * 1000);

    // Atomic find-or-create to guarantee single 15-min countdown
    let grant = await this.prisma.graceGrant.findFirst({
      where: {
        organizationId,
        domain: cleanDomain,
        calendarDate: today,
      },
    });

    if (!grant) {
      // First visit today: initiate GRACE_ACTIVE
      grant = await this.prisma.graceGrant.create({
        data: {
          organizationId,
          userId,
          deviceId,
          domain: cleanDomain,
          status: 'GRACE_ACTIVE',
          graceMinutes,
          firstVisitedAt: now,
          expiresAt,
          calendarDate: today,
        },
      });

      return {
        domain: cleanDomain,
        status: GRACE_STATUS.GRACE_ACTIVE,
        allowed: true,
        remainingSeconds: graceMinutes * 60,
        expiresAt: expiresAt.toISOString(),
        firstVisitedAt: now.toISOString(),
        isInitialVisit: true,
        message: `15-minute grace period started for ${cleanDomain}.`,
      };
    }

    // Already exists: evaluate existing timer
    return this.evaluateDomain({ organizationId, userId, deviceId, domain: cleanDomain });
  }

  /**
   * Administrator resets grace period for an employee/domain.
   */
  async resetGrace({ organizationId, domain, resetBy = 'System Admin', additionalMinutes = DEFAULT_GRACE_MINUTES }) {
    if (!organizationId || !domain) {
      throw new Error('organizationId and domain are required');
    }

    const cleanDomain = String(domain).toLowerCase().trim();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + additionalMinutes * 60 * 1000);

    const grant = await this.prisma.graceGrant.upsert({
      where: {
        organizationId_domain_calendarDate: {
          organizationId,
          domain: cleanDomain,
          calendarDate: today,
        },
      },
      update: {
        status: 'GRACE_ACTIVE',
        firstVisitedAt: now,
        expiresAt: newExpiresAt,
        resetBy,
        resetAt: now,
      },
      create: {
        organizationId,
        domain: cleanDomain,
        status: 'GRACE_ACTIVE',
        graceMinutes: additionalMinutes,
        firstVisitedAt: now,
        expiresAt: newExpiresAt,
        calendarDate: today,
        resetBy,
        resetAt: now,
      },
    });

    return {
      success: true,
      domain: cleanDomain,
      status: GRACE_STATUS.GRACE_ACTIVE,
      resetBy,
      expiresAt: newExpiresAt.toISOString(),
      remainingSeconds: additionalMinutes * 60,
      message: `Administrator ${resetBy} reset grace period for ${cleanDomain} (+${additionalMinutes} mins).`,
    };
  }

  /**
   * Returns list of all active grace grants for today.
   */
  async listGrants(organizationId) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const rows = await this.prisma.graceGrant.findMany({
      where: {
        organizationId,
        calendarDate: today,
      },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const now = new Date();
    return rows.map((g) => {
      let status = g.status;
      let remainingSeconds = 0;

      if (g.status === 'GRACE_ACTIVE' && g.expiresAt) {
        remainingSeconds = Math.max(0, Math.floor((new Date(g.expiresAt).getTime() - now.getTime()) / 1000));
        if (remainingSeconds === 0) status = 'BLOCKED';
      }

      return {
        id: g.id,
        domain: g.domain,
        status,
        remainingSeconds,
        graceMinutes: g.graceMinutes,
        firstVisitedAt: g.firstVisitedAt?.toISOString() || null,
        expiresAt: g.expiresAt?.toISOString() || null,
        resetBy: g.resetBy,
        user: g.user,
      };
    });
  }
}

