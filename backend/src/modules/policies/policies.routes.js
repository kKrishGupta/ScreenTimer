import crypto from 'node:crypto';

// In-memory family policy rules and violation logs (Stage 1 local MVP)
const policyState = {
  policies: [
    {
      id: crypto.randomUUID(),
      name: 'Safe Browsing & Social Limits',
      category: 'social_media',
      restrictedDomains: ['tiktok.com', 'instagram.com', 'facebook.com', 'snapchat.com'],
      allowedDomains: [],
      maxMinutesPerDay: 45,
      warningThresholdPercent: 80,
      action: 'warn',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      name: 'Gaming & High-Distraction Windows',
      category: 'gaming',
      restrictedDomains: ['roblox.com', 'twitch.tv', 'discord.com'],
      allowedDomains: [],
      maxMinutesPerDay: 60,
      warningThresholdPercent: 75,
      action: 'warn',
      active: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      name: 'Educational Whitelist Mode',
      category: 'education',
      restrictedDomains: [],
      allowedDomains: ['khanacademy.org', 'wikipedia.org', 'github.com', 'coursera.org'],
      maxMinutesPerDay: 240,
      warningThresholdPercent: 95,
      action: 'allow',
      active: true,
      createdAt: new Date().toISOString(),
    },
  ],
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
    {
      id: crypto.randomUUID(),
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      policyName: 'Gaming & High-Distraction Windows',
      target: 'roblox.com',
      targetType: 'website',
      severity: 'warning',
      actionTaken: 'soft_warning_issued',
      warningMessage: 'Gaming domain roblox.com triggered a daily limit advisory.',
      acknowledged: false,
    },
  ],
};

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
      allowedDomains = [],
      maxMinutesPerDay = 60,
      warningThresholdPercent = 80,
      action = 'warn',
      active = true,
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
      allowedDomains: Array.isArray(allowedDomains)
        ? allowedDomains.map((d) => String(d).toLowerCase().trim())
        : [],
      maxMinutesPerDay: Math.max(5, Math.min(1440, Number(maxMinutesPerDay))),
      warningThresholdPercent: Math.max(50, Math.min(100, Number(warningThresholdPercent))),
      action: ['warn', 'block', 'allow'].includes(action) ? action : 'warn',
      active: Boolean(active),
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

    const { name, restrictedDomains, allowedDomains, maxMinutesPerDay, warningThresholdPercent, action, active } = req.body ?? {};
    if (name) policy.name = name.trim().slice(0, 100);
    if (Array.isArray(restrictedDomains)) policy.restrictedDomains = restrictedDomains.map((d) => String(d).toLowerCase().trim());
    if (Array.isArray(allowedDomains)) policy.allowedDomains = allowedDomains.map((d) => String(d).toLowerCase().trim());
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

  // POST /api/v1/policies/check (Evaluates live domain/app against active policies)
  fastify.post('/policies/check', async (req, reply) => {
    const { domain, applicationName } = req.body ?? {};
    if (!domain && !applicationName) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'domain or applicationName is required' },
      });
    }

    const cleanDomain = domain ? String(domain).toLowerCase().trim() : null;
    const cleanApp = applicationName ? String(applicationName).toLowerCase().trim() : null;

    let matchedPolicy = null;
    let isRestricted = false;

    for (const policy of policyState.policies) {
      if (!policy.active) continue;

      if (cleanDomain && policy.restrictedDomains.some((rd) => cleanDomain === rd || cleanDomain.endsWith(`.${rd}`))) {
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
        severity: 'warning',
        actionTaken: 'soft_warning_issued',
        warningMessage: `Access to ${cleanDomain || cleanApp} is flagged under "${matchedPolicy.name}".`,
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

    // Add baseline system alert if any
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
