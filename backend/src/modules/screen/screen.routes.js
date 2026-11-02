import crypto from 'node:crypto';

// In-memory screen monitoring state with Stage 2 governance
const screenState = {
  consentGranted: false,
  consentGrantedAt: null,
  status: 'stopped', // 'active' | 'paused' | 'stopped'
  pauseUntil: null,
  captureIntervalMinutes: 10,
  retentionDays: 7,
  storageQuotaMb: 2048, // 2 GB local storage quota
  usedStorageBytes: 0,
  liveSession: {
    active: false,
    sessionId: null,
    viewerToken: null,
    connectedViewerId: null,
    expiresAt: null,
    viewerUrl: null,
  },
  captures: [],
  auditLog: [],
};

function recordAudit(action, actor = 'local_user', details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    actor,
    details,
  };
  screenState.auditLog.unshift(entry);
  if (screenState.auditLog.length > 500) screenState.auditLog.pop();
  return entry;
}

// Generates an SVG data URL placeholder for previewing captured windows safely
function generateSamplePreview(appName, width = 640, height = 360) {
  const timestamp = new Date().toLocaleTimeString();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#0f172a"/>
    <rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="8" fill="#1e293b" stroke="#334155" stroke-width="2"/>
    <rect x="20" y="20" width="${width - 40}" height="32" rx="8" fill="#334155"/>
    <circle cx="36" cy="36" r="5" fill="#ef4444"/>
    <circle cx="52" cy="36" r="5" fill="#f59e0b"/>
    <circle cx="68" cy="36" r="5" fill="#10b981"/>
    <text x="90" y="41" fill="#94a3b8" font-family="monospace" font-size="12">${appName} (Captured Screen)</text>
    <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="#38bdf8" font-family="sans-serif" font-weight="bold" font-size="20">DigitalPulse Screen Capture</text>
    <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="13">Active App: ${appName} | ${timestamp}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Enforces storage quota by pruning oldest captures when bytes exceed quota.
 */
function enforceStorageQuota() {
  const maxBytes = screenState.storageQuotaMb * 1024 * 1024;
  let currentBytes = screenState.captures.reduce((acc, c) => acc + (c.sizeBytes || 104850), 0);

  let prunedCount = 0;
  while (currentBytes > maxBytes && screenState.captures.length > 0) {
    const oldest = screenState.captures.pop();
    currentBytes -= (oldest?.sizeBytes || 104850);
    prunedCount++;
  }

  screenState.usedStorageBytes = currentBytes;
  if (prunedCount > 0) {
    recordAudit('storage_quota_pruned', 'system_governor', { prunedCount, currentBytes, maxBytes });
  }
}

export default async function screenRoutes(fastify) {
  // GET /api/v1/screen/config
  fastify.get('/screen/config', async () => {
    // Check if pause expired
    if (screenState.status === 'paused' && screenState.pauseUntil && new Date() > new Date(screenState.pauseUntil)) {
      screenState.status = 'active';
      screenState.pauseUntil = null;
    }

    // Check if live session expired
    if (screenState.liveSession.active && screenState.liveSession.expiresAt && new Date() > new Date(screenState.liveSession.expiresAt)) {
      screenState.liveSession = {
        active: false,
        sessionId: null,
        viewerToken: null,
        connectedViewerId: null,
        expiresAt: null,
        viewerUrl: null,
      };
      recordAudit('live_session_expired', 'system_governor');
    }

    const usedStorageMb = +(screenState.usedStorageBytes / (1024 * 1024)).toFixed(2);

    return {
      consentGranted: screenState.consentGranted,
      consentGrantedAt: screenState.consentGrantedAt,
      status: screenState.status,
      pauseUntil: screenState.pauseUntil,
      captureIntervalMinutes: screenState.captureIntervalMinutes,
      retentionDays: screenState.retentionDays,
      storageQuotaMb: screenState.storageQuotaMb,
      usedStorageMb,
      totalCaptures: screenState.captures.length,
      liveSession: screenState.liveSession,
    };
  });

  // PATCH /api/v1/screen/config (Update settings with high-frequency capture warning)
  fastify.patch('/screen/config', async (req, reply) => {
    const { captureIntervalMinutes, storageQuotaMb, retentionDays, confirmHighFrequencyWarning } = req.body || {};

    if (captureIntervalMinutes != null) {
      const interval = Number(captureIntervalMinutes);
      if (interval < 1 && !confirmHighFrequencyWarning) {
        return reply.code(400).send({
          error: {
            code: 'HIGH_FREQUENCY_WARNING_REQUIRED',
            message: 'Capturing more frequently than once per minute creates significant storage overhead (up to 3,600 images/hr). Pass confirmHighFrequencyWarning: true to proceed.',
          },
        });
      }
      screenState.captureIntervalMinutes = Math.max(0.1, interval);
    }

    if (storageQuotaMb != null) {
      screenState.storageQuotaMb = Math.max(100, Math.min(50000, Number(storageQuotaMb)));
      enforceStorageQuota();
    }

    if (retentionDays != null) {
      screenState.retentionDays = Math.max(1, Math.min(365, Number(retentionDays)));
    }

    recordAudit('screen_config_updated', 'local_user', {
      captureIntervalMinutes: screenState.captureIntervalMinutes,
      storageQuotaMb: screenState.storageQuotaMb,
      retentionDays: screenState.retentionDays,
    });

    return { success: true, config: screenState };
  });

  // POST /api/v1/screen/consent
  fastify.post('/screen/consent', async (req, reply) => {
    const { consent } = req.body ?? {};
    if (typeof consent !== 'boolean') {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'Field "consent" (boolean) is required' },
      });
    }

    screenState.consentGranted = consent;
    screenState.consentGrantedAt = consent ? new Date().toISOString() : null;
    if (!consent) {
      screenState.status = 'stopped';
      screenState.liveSession.active = false;
    } else if (screenState.status === 'stopped') {
      screenState.status = 'active';
    }

    recordAudit(consent ? 'consent_granted' : 'consent_revoked', 'local_user', {
      timestamp: screenState.consentGrantedAt,
    });

    return {
      success: true,
      consentGranted: screenState.consentGranted,
      status: screenState.status,
    };
  });

  // POST /api/v1/screen/state
  fastify.post('/screen/state', async (req, reply) => {
    if (!screenState.consentGranted) {
      return reply.code(403).send({
        error: { code: 'CONSENT_REQUIRED', message: 'User consent must be granted before controlling screen monitoring' },
      });
    }

    const { action, pauseMinutes = 15 } = req.body ?? {};
    if (action === 'resume') {
      screenState.status = 'active';
      screenState.pauseUntil = null;
      recordAudit('monitoring_resumed', 'local_user');
    } else if (action === 'pause') {
      screenState.status = 'paused';
      const until = new Date(Date.now() + Math.max(1, Number(pauseMinutes)) * 60 * 1000);
      screenState.pauseUntil = until.toISOString();
      recordAudit('monitoring_paused', 'local_user', { pauseMinutes, until: screenState.pauseUntil });
    } else if (action === 'stop') {
      screenState.status = 'stopped';
      screenState.pauseUntil = null;
      recordAudit('monitoring_stopped', 'local_user');
    } else {
      return reply.code(400).send({
        error: { code: 'INVALID_ACTION', message: 'Action must be "resume", "pause", or "stop"' },
      });
    }

    return {
      success: true,
      status: screenState.status,
      pauseUntil: screenState.pauseUntil,
    };
  });

  // GET /api/v1/screen/captures
  fastify.get('/screen/captures', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 50)));
    const captures = screenState.captures.slice(0, limit);
    return {
      captures,
      count: captures.length,
      totalCount: screenState.captures.length,
      retentionDays: screenState.retentionDays,
    };
  });

  // GET /api/v1/screen/captures/:id
  fastify.get('/screen/captures/:id', async (req, reply) => {
    const { id } = req.params;
    const capture = screenState.captures.find((c) => c.id === id);
    if (!capture) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Capture not found' },
      });
    }

    recordAudit('screenshot_viewed', 'authorized_viewer', { captureId: id });
    return { success: true, capture };
  });

  // POST /api/v1/screen/capture (Manual or agent-scheduled capture)
  fastify.post('/screen/capture', async (req, reply) => {
    if (!screenState.consentGranted) {
      return reply.code(403).send({
        error: { code: 'CONSENT_REQUIRED', message: 'Screen monitoring consent has not been granted' },
      });
    }

    if (screenState.status === 'paused') {
      return reply.code(409).send({
        error: { code: 'MONITORING_PAUSED', message: 'Screen monitoring is currently paused' },
      });
    }

    const appName = req.body?.applicationName || 'Active Window';
    const sizeBytes = Number(req.body?.sizeBytes || 104850);
    const capture = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      applicationName: String(appName).slice(0, 128),
      previewUrl: generateSamplePreview(appName),
      width: 1920,
      height: 1080,
      sizeBytes,
      blurred: false,
    };

    screenState.captures.unshift(capture);
    screenState.usedStorageBytes += sizeBytes;
    enforceStorageQuota();

    recordAudit('screenshot_captured', 'local_collector', {
      captureId: capture.id,
      applicationName: capture.applicationName,
      sizeBytes,
    });

    return { success: true, capture };
  });

  // DELETE /api/v1/screen/captures/:id
  fastify.delete('/screen/captures/:id', async (req, reply) => {
    const { id } = req.params;
    const initialLen = screenState.captures.length;
    const target = screenState.captures.find((c) => c.id === id);
    screenState.captures = screenState.captures.filter((c) => c.id !== id);

    if (screenState.captures.length === initialLen) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Screenshot capture not found' },
      });
    }

    if (target) {
      screenState.usedStorageBytes = Math.max(0, screenState.usedStorageBytes - (target.sizeBytes || 104850));
    }

    recordAudit('screenshot_deleted', 'local_user', { captureId: id });
    return { success: true, deletedId: id };
  });

  // POST /api/v1/screen/retention/purge
  fastify.post('/screen/retention/purge', async (req) => {
    const olderThanDays = Math.max(1, Number(req.body?.olderThanDays ?? screenState.retentionDays));
    const cutoffTime = new Date(Date.now() - olderThanDays * 86400 * 1000);
    const beforeCount = screenState.captures.length;
    screenState.captures = screenState.captures.filter((c) => new Date(c.timestamp) >= cutoffTime);
    const purgedCount = beforeCount - screenState.captures.length;

    screenState.usedStorageBytes = screenState.captures.reduce((acc, c) => acc + (c.sizeBytes || 104850), 0);
    recordAudit('retention_purged', 'local_user', { olderThanDays, purgedCount });
    return { success: true, purgedCount, remainingCount: screenState.captures.length };
  });

  // POST /api/v1/screen/live-session/start
  fastify.post('/screen/live-session/start', async (req, reply) => {
    if (!screenState.consentGranted) {
      return reply.code(403).send({
        error: { code: 'CONSENT_REQUIRED', message: 'Screen monitoring consent has not been granted' },
      });
    }

    const durationMinutes = Math.min(60, Math.max(1, Number(req.body?.durationMinutes ?? 15)));
    const sessionId = crypto.randomUUID();
    const viewerToken = `dp_view_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

    screenState.liveSession = {
      active: true,
      sessionId,
      viewerToken,
      connectedViewerId: null,
      expiresAt,
      viewerUrl: `http://localhost:5173/screen-monitoring?session=${sessionId}&token=${viewerToken}`,
    };

    recordAudit('live_session_started', 'local_user', { sessionId, durationMinutes, expiresAt });

    return {
      success: true,
      liveSession: screenState.liveSession,
    };
  });

  // POST /api/v1/screen/live-session/join (Tokenized Single-Viewer Authorization)
  fastify.post('/screen/live-session/join', async (req, reply) => {
    const { sessionId, viewerToken, viewerId = 'viewer-1' } = req.body || {};

    if (!screenState.liveSession.active || screenState.liveSession.sessionId !== sessionId) {
      return reply.code(404).send({
        error: { code: 'SESSION_NOT_FOUND', message: 'Active screen share session not found' },
      });
    }

    if (screenState.liveSession.viewerToken !== viewerToken) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED_TOKEN', message: 'Invalid viewer authorization token' },
      });
    }

    // Single-viewer governance check: prevent multiple concurrent viewers
    if (screenState.liveSession.connectedViewerId && screenState.liveSession.connectedViewerId !== viewerId) {
      return reply.code(409).send({
        error: {
          code: 'CONCURRENT_VIEWER_CONFLICT',
          message: 'Another authorized viewer is already connected to this screen sharing session.',
        },
      });
    }

    screenState.liveSession.connectedViewerId = viewerId;
    recordAudit('live_session_viewer_joined', viewerId, { sessionId });

    return { success: true, message: 'Connected to live screen share session', sessionId };
  });

  // POST /api/v1/screen/live-session/stop
  fastify.post('/screen/live-session/stop', async () => {
    const prevSession = screenState.liveSession.sessionId;
    screenState.liveSession = {
      active: false,
      sessionId: null,
      viewerToken: null,
      connectedViewerId: null,
      expiresAt: null,
      viewerUrl: null,
    };

    if (prevSession) {
      recordAudit('live_session_stopped', 'local_user', { sessionId: prevSession });
    }

    return { success: true, active: false };
  });

  // GET /api/v1/screen/audit-log
  fastify.get('/screen/audit-log', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 50)));
    return {
      auditLog: screenState.auditLog.slice(0, limit),
      totalCount: screenState.auditLog.length,
    };
  });
}
