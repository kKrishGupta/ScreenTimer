import crypto from 'node:crypto';
import { GraceService, GRACE_STATUS } from './grace.service.js';
import { Roles, normalizeRole } from '../auth/auth.service.js';

// In-memory family policy rules, temporary approvals, and violation logs for fast lookup & fallback
const policyState = {
  policies: [],
  temporaryApprovals: new Map(), // key: organizationId:targetDomainOrApp -> { expiresAt, approvedBy }
  violations: [],
};

function temporaryApprovalKey(organizationId, target) {
  return `${organizationId || 'unscoped'}:${target}`;
}

/**
 * Checks if current time falls within bedtime / scheduled restriction.
 */
function isWithinSchedule(schedule) {
  if (!schedule) return true;
  const currentHour = new Date().getHours();
  const { startHour, endHour } = schedule;

  if (startHour > endHour) {
    // Overnight window (e.g. 21:00 to 07:00)
    return currentHour >= startHour || currentHour < endHour;
  }
  return currentHour >= startHour && currentHour < endHour;
}

export default async function policyRoutes(fastify) {
  const { prisma } = fastify;
  const dashboardBaseUrl = fastify.config.publicAppUrl || 'http://localhost:5173';
  const graceService = new GraceService(fastify.prisma, fastify.log);

  function isPolicyAdministrator(user) {
    const role = normalizeRole(user?.role);
    return role === Roles.ADMIN || role === Roles.SUPER_ADMIN;
  }

  function requirePolicyAdministrator(req, reply) {
    if (!isPolicyAdministrator(req.user)) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Only administrators may configure policies' } });
      return false;
    }
    return true;
  }

  // Resolve the resource within the caller's tenant before any mutation.
  // `findFirst` is supported by Prisma; `findMany` keeps lightweight test
  // adapters compatible without permitting a cross-tenant fallback.
  async function findOwnedPolicy(id, organizationId) {
    if (!id || !organizationId) return null;
    if (prisma?.familyPolicy?.findFirst) {
      return prisma.familyPolicy.findFirst({ where: { id, organizationId } });
    }
    if (prisma?.familyPolicy?.findMany) {
      const policies = await prisma.familyPolicy.findMany({ where: { organizationId } });
      return policies.find((policy) => policy.id === id) || null;
    }
    if (process.env.NODE_ENV === 'production') return null;
    return policyState.policies.find((policy) => policy.id === id && policy.organizationId === organizationId) || null;
  }

  // Load organization policy state from persistence. Production never treats
  // a database error as an empty policy set, which would silently allow sites.
  async function getPolicies(organizationId) {
    if (prisma?.familyPolicy?.findMany) {
      try {
        if (!organizationId) {
          const err = new Error('Authenticated organization context is required');
          err.statusCode = 403;
          throw err;
        }
        const whereClause = { organizationId };
        const rows = await prisma.familyPolicy.findMany({ where: whereClause });
        if (rows) {
          return rows.map((r) => ({
            id: r.id,
            name: r.name,
            category: r.category,
            strictness: 50,
            restrictedDomains: r.restrictedDomains || [],
            restrictedApps: r.restrictedApps || [],
            allowedDomains: r.allowedDomains || [],
            maxMinutesPerDay: r.maxMinutesPerDay,
            temporaryAccessMinutes: 15,
            schedule: null,
            warningThresholdPercent: r.warningThresholdPercent,
            action: r.action,
            active: r.active,
            organizationId: r.organizationId,
            createdAt: r.createdAt?.toISOString ? r.createdAt.toISOString() : r.createdAt,
          }));
        }
      } catch (error) {
        if (error.statusCode) throw error;
        if (process.env.NODE_ENV === 'production') {
          const unavailable = new Error('Persistent policy data is unavailable');
          unavailable.statusCode = 503;
          throw unavailable;
        }
      }
    }
    if (process.env.NODE_ENV === 'production') {
      const unavailable = new Error('Persistent policy storage is not configured');
      unavailable.statusCode = 503;
      throw unavailable;
    }
    let list = policyState.policies;
    if (organizationId) {
      list = list.filter((p) => !p.organizationId || p.organizationId === organizationId);
    }
    return list;
  }

  // GET /api/v1/policies
  fastify.get('/policies', async (req) => {
    const orgId = req.user?.organizationId;
    const policies = await getPolicies(orgId);
    return {
      policies,
      totalCount: policies.length,
    };
  });

  // POST /api/v1/policies (Protected: Admin only)
  fastify.post('/policies', async (req, reply) => {
    const user = req.user;
    if (!requirePolicyAdministrator(req, reply)) return;

    const {
      name,
      category = 'general',
      strictness = 0,
      restrictedDomains = [],
      restrictedApps = [],
      allowedDomains = [],
      schedule = null,
      maxMinutesPerDay = 60,
      temporaryAccessMinutes = 15,
      warningThresholdPercent = 80,
      action = 'warn',
      active = true,
      memberId = null,
      deviceId = null,
    } = req.body ?? {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'Policy "name" is required' },
      });
    }

    const orgId = user.organizationId;
    const policy = {
      id: crypto.randomUUID(),
      organizationId: orgId,
      name: name.trim().slice(0, 100),
      category: String(category).slice(0, 32),
      strictness: Math.max(0, Math.min(100, Number(strictness) || 0)),
      restrictedDomains: Array.isArray(restrictedDomains)
        ? restrictedDomains.map((d) => String(d).toLowerCase().trim())
        : [],
      restrictedApps: Array.isArray(restrictedApps)
        ? restrictedApps.map((a) => String(a).toLowerCase().trim())
        : [],
      allowedDomains: Array.isArray(allowedDomains)
        ? allowedDomains.map((d) => String(d).toLowerCase().trim())
        : [],
      schedule: schedule && typeof schedule === 'object' ? schedule : null,
      maxMinutesPerDay: Math.max(5, Math.min(1440, Number(maxMinutesPerDay))),
      temporaryAccessMinutes: Math.max(1, Math.min(120, Number(temporaryAccessMinutes) || 15)),
      warningThresholdPercent: Math.max(50, Math.min(100, Number(warningThresholdPercent))),
      action: ['allow', 'warn', 'temporary_access', 'block'].includes(action) ? action : 'warn',
      active: Boolean(active),
      memberId,
      deviceId,
      createdAt: new Date().toISOString(),
    };

    if (prisma?.familyPolicy?.create) {
      try {
        await prisma.familyPolicy.create({
          data: {
            id: policy.id,
            organizationId: orgId,
            name: policy.name,
            category: policy.category,
            restrictedDomains: policy.restrictedDomains,
            restrictedApps: policy.restrictedApps,
            allowedDomains: policy.allowedDomains,
            maxMinutesPerDay: policy.maxMinutesPerDay,
            warningThresholdPercent: policy.warningThresholdPercent,
            action: policy.action,
            active: policy.active,
          },
        });
      } catch {
        // Fallback
      }
    }

    policyState.policies.push(policy);
    return reply.status(200).send({ success: true, policy });
  });

  // PATCH /api/v1/policies/:id (Protected: Admin only)
  fastify.patch('/policies/:id', async (req, reply) => {
    const user = req.user;
    if (!requirePolicyAdministrator(req, reply)) return;

    const { id } = req.params;
    const policy = await findOwnedPolicy(id, user.organizationId);
    if (!policy) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
    }

    const {
      name,
      strictness,
      restrictedDomains,
      restrictedApps,
      allowedDomains,
      schedule,
      maxMinutesPerDay,
      temporaryAccessMinutes,
      warningThresholdPercent,
      action,
      active,
    } = req.body ?? {};

    if (name) policy.name = name.trim().slice(0, 100);
    if (strictness !== undefined) policy.strictness = Math.max(0, Math.min(100, Number(strictness) || 0));
    if (Array.isArray(restrictedDomains)) policy.restrictedDomains = restrictedDomains.map((d) => String(d).toLowerCase().trim());
    if (Array.isArray(restrictedApps)) policy.restrictedApps = restrictedApps.map((a) => String(a).toLowerCase().trim());
    if (Array.isArray(allowedDomains)) policy.allowedDomains = allowedDomains.map((d) => String(d).toLowerCase().trim());
    if (schedule !== undefined) policy.schedule = schedule;
    if (maxMinutesPerDay != null) policy.maxMinutesPerDay = Math.max(5, Math.min(1440, Number(maxMinutesPerDay)));
    if (temporaryAccessMinutes != null) policy.temporaryAccessMinutes = Math.max(1, Math.min(120, Number(temporaryAccessMinutes) || 15));
    if (warningThresholdPercent != null) policy.warningThresholdPercent = Math.max(50, Math.min(100, Number(warningThresholdPercent)));
    if (action && ['allow', 'warn', 'temporary_access', 'block'].includes(action)) policy.action = action;
    if (typeof active === 'boolean') policy.active = active;

    if (prisma?.familyPolicy?.updateMany) {
      try {
        const result = await prisma.familyPolicy.updateMany({
          where: { id, organizationId: user.organizationId },
          data: {
            ...(name ? { name: policy.name } : {}),
            ...(Array.isArray(restrictedDomains) ? { restrictedDomains: policy.restrictedDomains } : {}),
            ...(Array.isArray(restrictedApps) ? { restrictedApps: policy.restrictedApps } : {}),
            ...(Array.isArray(allowedDomains) ? { allowedDomains: policy.allowedDomains } : {}),
            ...(maxMinutesPerDay != null ? { maxMinutesPerDay: policy.maxMinutesPerDay } : {}),
            ...(action ? { action: policy.action } : {}),
            ...(typeof active === 'boolean' ? { active: policy.active } : {}),
          },
        });
        if (result.count !== 1) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'production') throw error;
      }
    } else if (prisma?.familyPolicy?.update) {
      // Test adapters without updateMany still pass through the tenant-owned
      // lookup above. Prisma deployments use the scoped updateMany path.
      try {
        await prisma.familyPolicy.update({ where: { id }, data: {
          ...(name ? { name: policy.name } : {}),
          ...(Array.isArray(restrictedDomains) ? { restrictedDomains: policy.restrictedDomains } : {}),
          ...(Array.isArray(restrictedApps) ? { restrictedApps: policy.restrictedApps } : {}),
          ...(Array.isArray(allowedDomains) ? { allowedDomains: policy.allowedDomains } : {}),
          ...(maxMinutesPerDay != null ? { maxMinutesPerDay: policy.maxMinutesPerDay } : {}),
          ...(action ? { action: policy.action } : {}),
          ...(typeof active === 'boolean' ? { active: policy.active } : {}),
        } });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') throw error;
      }
    }

    return { success: true, policy };
  });

  // POST /api/v1/policies/:id/reset-strictness (Admin only)
  fastify.post('/policies/:id/reset-strictness', async (req, reply) => {
    const user = req.user;
    if (!requirePolicyAdministrator(req, reply)) return;

    const { id } = req.params;
    const policy = await findOwnedPolicy(id, user.organizationId);
    if (!policy) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
    }

    const previousStrictness = policy.strictness;
    policy.strictness = 0;
    return {
      success: true,
      message: `Strictness reset to 0 (Least restrictive) from previous value of ${previousStrictness}.`,
      policy,
    };
  });

  // DELETE /api/v1/policies/:id (Protected: Admin only)
  fastify.delete('/policies/:id', async (req, reply) => {
    const user = req.user;
    if (!requirePolicyAdministrator(req, reply)) return;

    const { id } = req.params;
    const policy = await findOwnedPolicy(id, user.organizationId);
    if (!policy) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
    }
    policyState.policies = policyState.policies.filter((item) => item.id !== id || item.organizationId !== user.organizationId);

    if (prisma?.familyPolicy?.deleteMany) {
      try {
        const result = await prisma.familyPolicy.deleteMany({ where: { id, organizationId: user.organizationId } });
        if (result.count !== 1) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
        }
      } catch (error) {
        if (process.env.NODE_ENV === 'production') throw error;
      }
    } else if (prisma?.familyPolicy?.delete) {
      try {
        await prisma.familyPolicy.delete({ where: { id } });
      } catch (error) {
        if (process.env.NODE_ENV === 'production') throw error;
      }
    }

    return { success: true, deletedId: id };
  });

  // POST /api/v1/policies/temporary-approvals (Parent grants temporary bypass)
  fastify.post('/policies/temporary-approvals', async (req, reply) => {
    if (!requirePolicyAdministrator(req, reply)) return;
    const { target, durationMinutes = 30, approvedBy = 'Parent' } = req.body || {};
    if (!target) {
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'Target domain or application is required' },
      });
    }
    const cleanTarget = String(target).toLowerCase().trim();
    const duration = Math.max(5, Math.min(240, Number(durationMinutes)));
    const expiresAt = new Date(Date.now() + duration * 60 * 1000);

    policyState.temporaryApprovals.set(temporaryApprovalKey(req.user.organizationId, cleanTarget), { expiresAt, approvedBy });

    return {
      success: true,
      target: cleanTarget,
      durationMinutes: duration,
      expiresAt: expiresAt.toISOString(),
      message: `Temporary approval active for ${duration} minutes.`,
    };
  });

  // POST /api/v1/policies/check (Evaluates live domain/app against active policies with configurable workflow)
  fastify.post('/policies/check', async (req, reply) => {
    const { domain, applicationName, memberId = null, deviceId = null, employee = 'Local User' } = req.body ?? {};
    if (!domain && !applicationName) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'domain or applicationName is required' },
      });
    }

    const cleanDomain = domain ? String(domain).toLowerCase().trim() : null;
    const cleanApp = applicationName ? String(applicationName).toLowerCase().trim() : null;
    const targetKey = cleanDomain || cleanApp;
    const now = new Date();

    // 1. HIGHEST PRECEDENCE: Check temporary approval override
    const organizationId = req.user?.organizationId || req.device?.organizationId;
    const approvalKey = temporaryApprovalKey(organizationId, targetKey);
    const tempApproval = policyState.temporaryApprovals.get(approvalKey);
    if (tempApproval) {
      const expDate = new Date(tempApproval.expiresAt);
      if (expDate > now) {
        const remainingSeconds = Math.max(0, Math.floor((expDate.getTime() - now.getTime()) / 1000));
        return {
          restricted: false,
          allowed: true,
          action: 'allow',
          policy: 'Temporary Parental Approval',
          policyName: 'Temporary Parental Approval',
          temporaryApprovalActive: true,
          expiresAt: expDate.toISOString(),
          website: cleanDomain,
          domain: cleanDomain,
          applicationName: cleanApp,
          employee,
          device: deviceId || 'Windows Device',
          accessAttemptTime: now.toISOString(),
          temporaryAccessExpiry: expDate.toISOString(),
          remainingSeconds,
          enforcementResult: 'TEMPORARY_ACCESS_GRANTED',
          adminNotificationStatus: 'SENT',
          warningMessage: `Temporary access active. Countdown: ${Math.ceil(remainingSeconds / 60)} minutes remaining.`,
        };
      } else {
        policyState.temporaryApprovals.delete(approvalKey);
      }
    }

    // 2. Load and sort policies by precedence:
    // (a) Member-specific policy (priority 1)
    // (b) Device-specific policy (priority 2)
    // (c) Household-wide default policy (priority 3)
    let persistedPolicies;
    try {
      persistedPolicies = await getPolicies(req.user?.organizationId || req.device?.organizationId);
    } catch (error) {
      return reply.code(error.statusCode || 503).send({ error: { code: 'POLICY_UNAVAILABLE', message: error.message } });
    }
    const activePolicies = persistedPolicies
      .filter((p) => p.active)
      .sort((a, b) => {
        const scoreA = (a.memberId === memberId ? 10 : 0) + (a.deviceId === deviceId ? 5 : 0);
        const scoreB = (b.memberId === memberId ? 10 : 0) + (b.deviceId === deviceId ? 5 : 0);
        return scoreB - scoreA;
      });

    let matchedPolicy = null;
    let isRestricted = false;

    for (const policy of activePolicies) {
      // Check schedule
      if (policy.schedule && !isWithinSchedule(policy.schedule)) {
        continue; // Restriction window not currently active
      }

      // Check domain match
      if (cleanDomain && policy.restrictedDomains.some((rd) => cleanDomain === rd || cleanDomain.endsWith(`.${rd}`))) {
        matchedPolicy = policy;
        isRestricted = true;
        break;
      }

      // Check app match
      if (cleanApp && policy.restrictedApps?.some((ra) => cleanApp === ra || cleanApp.endsWith(ra))) {
        matchedPolicy = policy;
        isRestricted = true;
        break;
      }
    }

    if (!isRestricted || !matchedPolicy) {
      return {
        restricted: false,
        allowed: true,
        action: 'allow',
        policyName: 'Default Allow',
        website: cleanDomain,
        domain: cleanDomain,
        applicationName: cleanApp,
        employee,
        device: deviceId || 'Windows Device',
        accessAttemptTime: now.toISOString(),
        temporaryAccessExpiry: null,
        enforcementResult: 'ALLOWED',
        adminNotificationStatus: 'NOT_REQUIRED',
        warningMessage: `Access to ${cleanDomain || cleanApp} complies with all active policies.`,
      };
    }

    // Evaluate action workflow: 'allow', 'warn', 'temporary_access', 'block'
    let finalAction = matchedPolicy.action || 'warn';
    let enforcementResult = 'WARNING_ISSUED';
    let temporaryAccessExpiry = null;
    let remainingSeconds = 0;
    let warningMessage = '';

    // If strictness == 100, override to block
    if (matchedPolicy.strictness === 100) {
      finalAction = 'block';
    }

    if (finalAction === 'allow') {
      enforcementResult = 'ALLOWED';
      warningMessage = `Access explicitly permitted under policy "${matchedPolicy.name}".`;
    } else if (finalAction === 'temporary_access' || matchedPolicy.strictness >= 75) {
      // Check or create temporary access grant
      let grant = policyState.temporaryApprovals.get(approvalKey);
      if (!grant) {
        const durationMins = matchedPolicy.temporaryAccessMinutes || 15;
        const expiry = new Date(now.getTime() + durationMins * 60 * 1000);
        grant = { expiresAt: expiry.toISOString(), approvedBy: 'Policy Engine' };
        policyState.temporaryApprovals.set(approvalKey, grant);
      }

      const expDate = new Date(grant.expiresAt);
      remainingSeconds = Math.max(0, Math.floor((expDate.getTime() - now.getTime()) / 1000));

      if (remainingSeconds > 0) {
        finalAction = 'temporary_access';
        enforcementResult = 'TEMPORARY_ACCESS_GRANTED';
        temporaryAccessExpiry = expDate.toISOString();
        warningMessage = `Policy advisory: 15-minute temporary access active for ${cleanDomain || cleanApp}. Countdown: ${Math.ceil(remainingSeconds / 60)}m (${remainingSeconds}s remaining).`;
      } else {
        // Expired -> Enforce blocking
        finalAction = 'block';
        enforcementResult = 'RESTRICTION_ENFORCED_BLOCKED';
        temporaryAccessExpiry = expDate.toISOString();
        warningMessage = `Temporary access for ${cleanDomain || cleanApp} has expired. Access blocked under "${matchedPolicy.name}".`;
      }
    } else if (finalAction === 'block') {
      enforcementResult = 'RESTRICTION_ENFORCED_BLOCKED';
      warningMessage = `Access to ${cleanDomain || cleanApp} is blocked under "${matchedPolicy.name}".`;
    } else {
      // warn
      finalAction = 'warn';
      enforcementResult = 'WARNING_ISSUED';
      warningMessage = `Visiting ${cleanDomain || cleanApp} is flagged under "${matchedPolicy.name}" (Strictness: ${matchedPolicy.strictness || 0}).`;
    }

    const violation = {
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      policyName: matchedPolicy.name,
      target: cleanDomain || cleanApp,
      targetType: cleanDomain ? 'website' : 'application',
      employee,
      deviceId: deviceId || 'Windows Device',
      severity: finalAction === 'block' ? 'critical' : 'warning',
      actionTaken: enforcementResult,
      enforcementResult,
      warningMessage,
      temporaryAccessExpiry,
      adminNotificationStatus: 'SENT',
      acknowledged: false,
      organizationId: req.user?.organizationId || matchedPolicy.organizationId || '00000000-0000-0000-0000-000000000000',
      userId: req.user?.id || memberId || null,
    };

    if (prisma?.policyViolation?.create) {
      try {
        await prisma.policyViolation.create({
          data: {
            id: violation.id,
            organizationId: violation.organizationId,
            policyId: matchedPolicy.id,
            deviceId: deviceId || null,
            userId: violation.userId,
            target: violation.target,
            targetType: violation.targetType,
            severity: violation.severity,
            warningMessage: violation.warningMessage,
            actionTaken: violation.actionTaken,
            acknowledged: false,
          },
        });
      } catch {
        // Fallback
      }
    }

    policyState.violations.unshift(violation);
    if (policyState.violations.length > 500) policyState.violations.pop();

    return {
      restricted: finalAction === 'block' || finalAction === 'warn',
      allowed: finalAction === 'allow' || (finalAction === 'temporary_access' && remainingSeconds > 0),
      action: finalAction,
      policyName: matchedPolicy.name,
      website: cleanDomain,
      domain: cleanDomain,
      applicationName: cleanApp,
      employee,
      device: deviceId || 'Windows Device',
      accessAttemptTime: now.toISOString(),
      temporaryAccessExpiry,
      remainingSeconds,
      enforcementResult,
      adminNotificationStatus: 'SENT',
      warningMessage,
      violation,
    };
  });

  // GET /api/v1/policies/declarative-rules (Exports Chrome/Edge MV3 declarativeNetRequest rules)
  fastify.get('/policies/declarative-rules', async (req) => {
    const orgId = req.user?.organizationId || req.device?.organizationId;
    const policies = await getPolicies(orgId);
    const rules = [];
    let ruleId = 1;
    const addedDomains = new Set();

    const now = new Date();
    for (const policy of policies) {
      if (!policy.active) continue;

      for (const domain of policy.restrictedDomains || []) {
        const clean = String(domain).toLowerCase().trim();
        if (!clean || addedDomains.has(clean)) continue;

        // If policy allows temporary access and an unexpired grant exists, permit browsing (do not block)
        if (policy.action === 'temporary_access') {
          const grant = policyState.temporaryApprovals.get(temporaryApprovalKey(orgId, clean));
          if (grant && new Date(grant.expiresAt) > now) {
            continue; // Grace period active: do not emit redirect rule
          }
        } else if (policy.action !== 'block') {
          continue;
        }

        addedDomains.add(clean);

        rules.push({
          id: ruleId++,
          priority: 1,
          action: {
            type: 'redirect',
            redirect: { url: `${dashboardBaseUrl}/blocked?domain=${encodeURIComponent(clean)}&policy=${encodeURIComponent(policy.name)}` },
          },
          condition: {
            urlFilter: `||${clean}`,
            resourceTypes: ['main_frame'],
          },
        });
      }
    }

    // Also include any active blocked domains from persistent grace grants
    if (prisma?.graceGrant?.findMany) {
      try {
        const whereClause = { status: 'BLOCKED' };
        if (orgId) whereClause.organizationId = orgId;
        const blockedGrants = await prisma.graceGrant.findMany({ where: whereClause });
        for (const grant of blockedGrants) {
          const clean = String(grant.domain).toLowerCase().trim();
          if (!clean || addedDomains.has(clean)) continue;
          addedDomains.add(clean);

          rules.push({
            id: ruleId++,
            priority: 1,
            action: {
              type: 'redirect',
              redirect: { url: `${dashboardBaseUrl}/blocked?domain=${encodeURIComponent(clean)}&policy=${encodeURIComponent('Corporate Compliance Policy')}` },
            },
            condition: {
              urlFilter: `||${clean}`,
              resourceTypes: ['main_frame'],
            },
          });
        }
      } catch {
        // Fallback
      }
    }

    return {
      rules,
      count: rules.length,
      version: 1,
    };
  });

  // GET /api/v1/policies/violations
  fastify.get('/policies/violations', async (req) => {
    const orgId = req.user?.organizationId;

    if (prisma?.policyViolation?.findMany) {
      try {
        const whereClause = {};
        if (orgId) whereClause.organizationId = orgId;
        if (req.user && normalizeRole(req.user.role) === Roles.EMPLOYEE) {
          whereClause.userId = req.user.id;
        }
        const rows = await prisma.policyViolation.findMany({
          where: whereClause,
          orderBy: { timestamp: 'desc' },
        });
        if (rows) {
          return {
            violations: rows,
            totalCount: rows.length,
            unacknowledgedCount: rows.filter((v) => !v.acknowledged).length,
          };
        }
      } catch {
        // Fallback
      }
    }

    let list = policyState.violations;
    if (orgId) {
      list = list.filter((v) => !v.organizationId || v.organizationId === orgId);
    }
    if (req.user && normalizeRole(req.user.role) === Roles.EMPLOYEE) {
      list = list.filter((v) => v.userId === req.user.id || v.employee === req.user.displayName || v.employee === req.user.email);
    }
    return {
      violations: list,
      totalCount: list.length,
      unacknowledgedCount: list.filter((v) => !v.acknowledged).length,
    };
  });

  // POST /api/v1/policies/violations/:id/acknowledge
  fastify.post('/policies/violations/:id/acknowledge', async (req, reply) => {
    const { id } = req.params;

    if (prisma?.policyViolation?.update) {
      try {
        const updated = await prisma.policyViolation.update({
          where: { id },
          data: { acknowledged: true },
        });
        const v = policyState.violations.find((item) => item.id === id);
        if (v) {
          v.acknowledged = true;
          v.acknowledgedAt = new Date().toISOString();
        }
        return { success: true, violation: updated };
      } catch {
        // Fallback
      }
    }

    const violation = policyState.violations.find((v) => v.id === id);
    if (!violation) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Violation not found' },
      });
    }

    violation.acknowledged = true;
    violation.acknowledgedAt = new Date().toISOString();
    return { success: true, violation };
  });

  // GET /api/v1/alerts (Consolidated alerts feed combining database notifications and policy violations)
  fastify.get('/alerts', async (req) => {
    const orgId = req.user?.organizationId;
    const unacknowledgedViolations = policyState.violations.filter(
      (v) => !v.acknowledged && (!orgId || v.organizationId === orgId),
    );

    const alerts = unacknowledgedViolations.map((v) => ({
      id: v.id,
      timestamp: v.timestamp,
      type: 'policy_violation',
      severity: v.severity,
      title: `Policy Warning: ${v.policyName}`,
      description: v.warningMessage,
      target: v.target,
    }));

    // Ingest persistent notifications from PostgreSQL
    if (prisma?.notification?.findMany) {
      try {
        const where = {};
        if (orgId) where.organizationId = orgId;
        const dbNotifications = await prisma.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 20,
        });

        for (const n of dbNotifications) {
          alerts.push({
            id: n.id,
            timestamp: n.createdAt.toISOString(),
            type: n.type || 'system_notice',
            severity: n.severity?.toLowerCase() || 'info',
            title: n.title,
            description: n.message,
            target: n.target || 'Organization Policy',
          });
        }
      } catch {
        // Fallback
      }
    }

    // Always include system agent monitor active notice in feed
    alerts.push({
      id: 'system-agent-active',
      timestamp: new Date().toISOString(),
      type: 'system_notice',
      severity: 'info',
      title: 'DigitalPulse Monitor Active',
      description: 'Local Windows desktop agent is monitoring authorized foreground application intervals.',
      target: 'Windows 11',
    });

    return {
      alerts,
      count: alerts.length,
    };
  });

  // GET /api/v1/policies/grace
  fastify.get('/policies/grace', async (req, reply) => {
    const org = await fastify.prisma.organization.findFirst({ where: { slug: 'local-dev' } });
    if (!org) return reply.code(400).send({ error: { message: 'Organization not found' } });
    const grants = await graceService.listGrants(org.id);
    return { grants, count: grants.length };
  });

  // POST /api/v1/policies/grace/visit
  fastify.post('/policies/grace/visit', async (req, reply) => {
    const { domain, userId, deviceId } = req.body ?? {};
    if (!domain) return reply.code(400).send({ error: { message: 'domain is required' } });
    const org = await fastify.prisma.organization.findFirst({ where: { slug: 'local-dev' } });
    const result = await graceService.registerVisit({
      organizationId: org?.id,
      userId,
      deviceId,
      domain,
    });
    return result;
  });

  // POST /api/v1/policies/grace/reset (Protected: Admin only)
  fastify.post('/policies/grace/reset', async (req, reply) => {
    const user = req.user;
    if (!requirePolicyAdministrator(req, reply)) return;

    const { domain, resetBy = 'Admin', additionalMinutes = 15 } = req.body ?? {};
    if (!domain) return reply.code(400).send({ error: { message: 'domain is required' } });
    const org = user?.organizationId
      ? { id: user.organizationId }
      : await fastify.prisma.organization.findFirst({ where: { slug: 'local-dev' } });
    const result = await graceService.resetGrace({
      organizationId: org?.id,
      domain,
      resetBy: user?.displayName || user?.email || resetBy,
      additionalMinutes: Number(additionalMinutes) || 15,
    });
    return result;
  });

  // GET /api/v1/policies/blocked-page (Rendered HTML for blocked navigation)
  fastify.get('/policies/blocked-page', async (req, reply) => {
    const { domain = 'Unknown Domain', policy = 'Enterprise Acceptable Use Policy', remainingSeconds = 0 } = req.query;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Access Restricted - DigitalPulse Enterprise</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #131b2e; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 32px; max-width: 480px; text-align: center; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    .badge { display: inline-block; background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-bottom: 16px; }
    h1 { font-size: 22px; margin: 0 0 8px 0; color: #ffffff; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin: 8px 0; }
    .domain { font-family: monospace; color: #38bdf8; font-weight: bold; }
    .details { background: #0f172a; border-radius: 8px; padding: 12px; margin: 20px 0; font-size: 13px; text-align: left; }
    .details-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .details-row:last-child { border-bottom: none; }
    .details-label { color: #64748b; }
    .details-val { color: #cbd5e1; font-weight: 500; }
    .footer { font-size: 11px; color: #64748b; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Access Restricted</div>
    <h1>Domain Blocked</h1>
    <p>Navigation to <span class="domain">${domain}</span> has been restricted in accordance with your organization's digital wellbeing policy.</p>
    <div class="details">
      <div class="details-row"><span class="details-label">Policy</span><span class="details-val">${policy}</span></div>
      <div class="details-row"><span class="details-label">Grace Status</span><span class="details-val">15-min Allowance Expired</span></div>
      <div class="details-row"><span class="details-label">Platform</span><span class="details-val">DigitalPulse Enterprise</span></div>
    </div>
    <p style="font-size: 12px; color: #64748b;">If this website is required for essential business duties, contact your system administrator to request an access grant.</p>
    <div class="footer">DigitalPulse Enterprise Endpoint Activity Intelligence &bull; Authorized Device Governance</div>
  </div>
</body>
</html>`;
    return reply.type('text/html').send(html);
  });
}
