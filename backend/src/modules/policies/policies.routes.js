import crypto from 'node:crypto';

// In-memory family policy rules, temporary approvals, and violation logs
const policyState = {
  policies: [
    {
      id: 'pol-safe-browsing',
      name: 'Safe Browsing & Social Limits',
      category: 'social_media',
      restrictedDomains: ['tiktok.com', 'instagram.com', 'facebook.com', 'snapchat.com'],
      restrictedApps: ['tiktok.exe', 'instagram.exe'],
      allowedDomains: [],
      maxMinutesPerDay: 45,
      schedule: null, // Always active
      warningThresholdPercent: 80,
      action: 'warn',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'pol-gaming-focus',
      name: 'Gaming & Distraction Policy',
      category: 'gaming',
      restrictedDomains: ['roblox.com', 'twitch.tv', 'discord.com'],
      restrictedApps: ['robloxplayerbeta.exe', 'discord.exe', 'steam.exe'],
      allowedDomains: [],
      maxMinutesPerDay: 60,
      schedule: { startHour: 21, endHour: 7 }, // Bedtime restriction: 9 PM to 7 AM
      warningThresholdPercent: 75,
      action: 'block',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'pol-education-whitelist',
      name: 'Educational Whitelist Mode',
      category: 'education',
      restrictedDomains: [],
      restrictedApps: [],
      allowedDomains: ['khanacademy.org', 'wikipedia.org', 'github.com', 'coursera.org'],
      maxMinutesPerDay: 240,
      warningThresholdPercent: 95,
      action: 'allow',
      active: true,
      createdAt: new Date().toISOString(),
    },
  ],
  temporaryApprovals: new Map(), // key: targetDomainOrApp -> expiresAt
  violations: [
    {
      id: crypto.randomUUID(),
      timestamp: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      policyName: 'Safe Browsing & Social Limits',
      target: 'tiktok.com',
      targetType: 'website',
      severity: 'warning',
      actionTaken: 'soft_warning_issued',
      warningMessage: 'Visiting tiktok.com is restricted under household policy.',
      acknowledged: false,
    },
  ],
};

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
  // GET /api/v1/policies
  fastify.get('/policies', async () => {
    return {
      policies: policyState.policies,
      totalCount: policyState.policies.length,
    };
  });

  // POST /api/v1/policies
  fastify.post('/policies', async (req, reply) => {
    const {
      name,
      category = 'general',
      restrictedDomains = [],
      restrictedApps = [],
      allowedDomains = [],
      schedule = null,
      maxMinutesPerDay = 60,
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

    const policy = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 100),
      category: String(category).slice(0, 32),
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
      warningThresholdPercent: Math.max(50, Math.min(100, Number(warningThresholdPercent))),
      action: ['warn', 'block', 'allow'].includes(action) ? action : 'warn',
      active: Boolean(active),
      memberId,
      deviceId,
      createdAt: new Date().toISOString(),
    };

    policyState.policies.push(policy);
    return { success: true, policy };
  });

  // PATCH /api/v1/policies/:id
  fastify.patch('/policies/:id', async (req, reply) => {
    const { id } = req.params;
    const policy = policyState.policies.find((p) => p.id === id);
    if (!policy) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
    }

    const { name, restrictedDomains, restrictedApps, allowedDomains, schedule, maxMinutesPerDay, warningThresholdPercent, action, active } = req.body ?? {};
    if (name) policy.name = name.trim().slice(0, 100);
    if (Array.isArray(restrictedDomains)) policy.restrictedDomains = restrictedDomains.map((d) => String(d).toLowerCase().trim());
    if (Array.isArray(restrictedApps)) policy.restrictedApps = restrictedApps.map((a) => String(a).toLowerCase().trim());
    if (Array.isArray(allowedDomains)) policy.allowedDomains = allowedDomains.map((d) => String(d).toLowerCase().trim());
    if (schedule !== undefined) policy.schedule = schedule;
    if (maxMinutesPerDay != null) policy.maxMinutesPerDay = Math.max(5, Math.min(1440, Number(maxMinutesPerDay)));
    if (warningThresholdPercent != null) policy.warningThresholdPercent = Math.max(50, Math.min(100, Number(warningThresholdPercent)));
    if (action && ['warn', 'block', 'allow'].includes(action)) policy.action = action;
    if (typeof active === 'boolean') policy.active = active;

    return { success: true, policy };
  });

  // DELETE /api/v1/policies/:id
  fastify.delete('/policies/:id', async (req, reply) => {
    const { id } = req.params;
    const initialLen = policyState.policies.length;
    policyState.policies = policyState.policies.filter((p) => p.id !== id);

    if (policyState.policies.length === initialLen) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Policy not found' },
      });
    }

    return { success: true, deletedId: id };
  });

  // POST /api/v1/policies/temporary-approvals (Parent grants temporary bypass)
  fastify.post('/policies/temporary-approvals', async (req, reply) => {
    const { target, durationMinutes = 30, approvedBy = 'Parent' } = req.body || {};
    if (!target) {
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'Target domain or application is required' },
      });
    }
    const cleanTarget = String(target).toLowerCase().trim();
    const duration = Math.max(5, Math.min(240, Number(durationMinutes)));
    const expiresAt = new Date(Date.now() + duration * 60 * 1000);

    policyState.temporaryApprovals.set(cleanTarget, { expiresAt, approvedBy });

    return {
      success: true,
      target: cleanTarget,
      durationMinutes: duration,
      expiresAt: expiresAt.toISOString(),
      message: `Temporary approval active for ${duration} minutes.`,
    };
  });

  // POST /api/v1/policies/check (Evaluates live domain/app against active policies with precedence)
  fastify.post('/policies/check', async (req, reply) => {
    const { domain, applicationName, memberId = null, deviceId = null } = req.body ?? {};
    if (!domain && !applicationName) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'domain or applicationName is required' },
      });
    }

    const cleanDomain = domain ? String(domain).toLowerCase().trim() : null;
    const cleanApp = applicationName ? String(applicationName).toLowerCase().trim() : null;
    const targetKey = cleanDomain || cleanApp;

    // 1. HIGHEST PRECEDENCE: Check temporary approval override
    const tempApproval = policyState.temporaryApprovals.get(targetKey);
    if (tempApproval) {
      if (new Date(tempApproval.expiresAt) > new Date()) {
        return {
          restricted: false,
          action: 'allow',
          policy: 'Temporary Parental Approval',
          temporaryApprovalActive: true,
          expiresAt: tempApproval.expiresAt.toISOString(),
        };
      } else {
        policyState.temporaryApprovals.delete(targetKey);
      }
    }

    // 2. Load and sort policies by precedence:
    // (a) Member-specific policy (priority 1)
    // (b) Device-specific policy (priority 2)
    // (c) Household-wide default policy (priority 3)
    const activePolicies = policyState.policies
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

    if (isRestricted && matchedPolicy) {
      const violation = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        policyName: matchedPolicy.name,
        target: cleanDomain || cleanApp,
        targetType: cleanDomain ? 'website' : 'application',
        severity: matchedPolicy.action === 'block' ? 'critical' : 'warning',
        actionTaken: matchedPolicy.action === 'block' ? 'access_blocked' : 'soft_warning_issued',
        warningMessage: `Access to ${cleanDomain || cleanApp} is ${matchedPolicy.action === 'block' ? 'blocked' : 'flagged'} under "${matchedPolicy.name}".`,
        acknowledged: false,
      };

      policyState.violations.unshift(violation);
      if (policyState.violations.length > 500) policyState.violations.pop();

      return {
        restricted: true,
        action: matchedPolicy.action, // 'warn' or 'block'
        policy: matchedPolicy.name,
        warningMessage: violation.warningMessage,
        violation,
      };
    }

    return {
      restricted: false,
      action: 'allow',
      policy: null,
      violation: null,
    };
  });

  // GET /api/v1/policies/declarative-rules (Exports Chrome/Edge MV3 declarativeNetRequest rules)
  fastify.get('/policies/declarative-rules', async () => {
    const rules = [];
    let ruleId = 1;

    for (const policy of policyState.policies) {
      if (!policy.active || policy.action !== 'block') continue;

      for (const domain of policy.restrictedDomains) {
        rules.push({
          id: ruleId++,
          priority: 1,
          action: {
            type: 'redirect',
            redirect: { url: `http://localhost:5173/blocked?domain=${encodeURIComponent(domain)}&policy=${encodeURIComponent(policy.name)}` },
          },
          condition: {
            urlFilter: `||${domain}`,
            resourceTypes: ['main_frame'],
          },
        });
      }
    }

    return {
      rules,
      count: rules.length,
      version: 1,
    };
  });

  // GET /api/v1/policies/violations
  fastify.get('/policies/violations', async () => {
    return {
      violations: policyState.violations,
      totalCount: policyState.violations.length,
      unacknowledgedCount: policyState.violations.filter((v) => !v.acknowledged).length,
    };
  });

  // POST /api/v1/policies/violations/:id/acknowledge
  fastify.post('/policies/violations/:id/acknowledge', async (req, reply) => {
    const { id } = req.params;
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

  // GET /api/v1/alerts (Consolidated alerts feed)
  fastify.get('/alerts', async () => {
    const unacknowledgedViolations = policyState.violations.filter((v) => !v.acknowledged);
    const alerts = unacknowledgedViolations.map((v) => ({
      id: v.id,
      timestamp: v.timestamp,
      type: 'policy_violation',
      severity: v.severity,
      title: `Policy Warning: ${v.policyName}`,
      description: v.warningMessage,
      target: v.target,
    }));

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
}
