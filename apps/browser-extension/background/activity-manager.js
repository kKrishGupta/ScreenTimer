import { CONFIG } from '../shared/constants.js';

/**
 * ActivityManager manages session timing, duration calculation, and local batching.
 */
export class ActivityManager {
  /**
   * @param {object} options
   * @param {string} options.deviceId
   * @param {'chrome' | 'edge'} options.browser
   * @param {(event: object) => Promise<void>} options.onSessionCompleted
   */
  constructor({ deviceId, browser, onSessionCompleted, initialSession = null, onSessionChanged = null }) {
    this.deviceId = deviceId;
    this.browser = browser;
    this.onSessionCompleted = onSessionCompleted;
    this.activeSession = this._validSession(initialSession) ? { ...initialSession } : null;
    this.onSessionChanged = onSessionChanged;
    this.monitoringAllowed = false;
    this.allowedUntil = null;
  }

  _validSession(session) {
    return Boolean(session
      && typeof session.domain === 'string'
      && session.domain.length > 0
      && Number.isFinite(session.startedAt)
      && session.startedAt <= Date.now());
  }

  _notifySessionChanged() {
    if (!this.onSessionChanged) return;
    Promise.resolve(this.onSessionChanged(this.activeSession ? { ...this.activeSession } : null)).catch(() => {
      // Persistence is best effort; telemetry collection must remain usable.
    });
  }

  async restoreSession(session, nowMs = Date.now()) {
    if (!this._canCollect(nowMs) || !this._validSession(session)) return false;
    this.activeSession = { ...session };
    this._notifySessionChanged();
    return true;
  }

  async setMonitoringState({ allowed = false, allowedUntil = null, reason = null } = {}, nowMs = Date.now()) {
    const expiry = allowedUntil ? Date.parse(allowedUntil) : NaN;
    const canRun = Boolean(allowed && Number.isFinite(expiry) && nowMs < expiry);
    const previousEnd = this.allowedUntil;
    this.allowedUntil = canRun ? expiry : null;
    if (!canRun && this.activeSession) {
      const scheduleEnded = reason === 'OUTSIDE_SCHEDULE';
      const stopAt = scheduleEnded && previousEnd && previousEnd > this.activeSession.startedAt
        ? previousEnd
        : nowMs;
      await this._closeSession(stopAt);
    }
    this.monitoringAllowed = canRun;
  }

  _canCollect(nowMs = Date.now()) {
    if (!this.monitoringAllowed) return false;
    if (this.allowedUntil && nowMs >= this.allowedUntil) {
      this.monitoringAllowed = false;
      return false;
    }
    return true;
  }

  /**
   * Switch the current active domain. Closes the previous domain session if any.
   * @param {string | null} domain
   * @param {number} [nowMs]
   */
  async switchDomain(domain, nowMs = Date.now()) {
    if (!this._canCollect(nowMs)) {
      if (this.activeSession) {
        const stopAt = this.allowedUntil && this.allowedUntil > this.activeSession.startedAt ? this.allowedUntil : nowMs;
        await this._closeSession(stopAt);
      }
      return;
    }
    if (this.activeSession?.domain === domain) {
      return;
    }

    if (this.activeSession) {
      await this._closeSession(nowMs);
    }

    if (domain) {
      this.activeSession = {
        domain,
        startedAt: nowMs,
      };
      this._notifySessionChanged();
    }
  }

  /**
   * Handles user becoming idle or active.
   * @param {'active' | 'idle' | 'locked'} idleState
   * @param {number} [nowMs]
   */
  async handleIdleState(idleState, nowMs = Date.now(), activeDomain = null) {
    if (!this._canCollect(nowMs)) {
      if (this.activeSession) {
        const stopAt = this.allowedUntil && this.allowedUntil > this.activeSession.startedAt ? this.allowedUntil : nowMs;
        await this._closeSession(stopAt);
      }
      return;
    }
    if (idleState === 'active') {
      // Browser idle events do not reliably produce a tab-focus event. Restore
      // the currently focused domain when the caller has it available.
      if (activeDomain) await this.switchDomain(activeDomain, nowMs);
    } else {
      // Idle or locked; close active session
      if (this.activeSession) {
        await this._closeSession(nowMs);
      }
    }
  }

  /**
   * Checkpoints continuous in-progress session so time is saved incrementally (e.g. every 30s)
   * without needing the user to switch tabs.
   * @param {number} [nowMs]
   */
  async checkpoint(nowMs = Date.now()) {
    if (!this._canCollect(nowMs)) {
      if (this.activeSession) {
        const stopAt = this.allowedUntil && this.allowedUntil > this.activeSession.startedAt ? this.allowedUntil : nowMs;
        await this._closeSession(stopAt);
      }
      return;
    }
    if (!this.activeSession) return;
    const { domain, startedAt } = this.activeSession;
    const durationSeconds = Math.max(0, Math.round((nowMs - startedAt) / 1000));
    if (durationSeconds < 1) return;

    this.activeSession.startedAt = nowMs;
    this._notifySessionChanged();
    const eventId = crypto.randomUUID();
    const event = {
      schemaVersion: CONFIG.SCHEMA_VERSION,
      eventId,
      deviceId: this.deviceId,
      source: 'browser_extension',
      type: 'web_session',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(nowMs).toISOString(),
      durationSeconds,
      web: {
        domain,
        browser: this.browser,
      },
    };

    if (this.onSessionCompleted) {
      await this.onSessionCompleted(event);
    }
  }

  /**
   * Finalizes the active session.
   * @param {number} nowMs
   */
  async _closeSession(nowMs) {
    if (!this.activeSession) return;
    const { domain, startedAt } = this.activeSession;
    this.activeSession = null;
    this._notifySessionChanged();

    const durationSeconds = Math.max(0, Math.round((nowMs - startedAt) / 1000));
    // Filter out momentary clicks / 0-second transients
    if (durationSeconds < 1) return;

    const eventId = crypto.randomUUID();
    const event = {
      schemaVersion: CONFIG.SCHEMA_VERSION,
      eventId,
      deviceId: this.deviceId,
      source: 'browser_extension',
      type: 'web_session',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(nowMs).toISOString(),
      durationSeconds,
      web: {
        domain,
        browser: this.browser,
      },
    };

    if (this.onSessionCompleted) {
      await this.onSessionCompleted(event);
    }
  }
}

