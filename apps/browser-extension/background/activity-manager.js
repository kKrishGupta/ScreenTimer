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
  constructor({ deviceId, browser, onSessionCompleted }) {
    this.deviceId = deviceId;
    this.browser = browser;
    this.onSessionCompleted = onSessionCompleted;
    this.activeSession = null;
  }

  /**
   * Switch the current active domain. Closes the previous domain session if any.
   * @param {string | null} domain
   * @param {number} [nowMs]
   */
  async switchDomain(domain, nowMs = Date.now()) {
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
    }
  }

  /**
   * Handles user becoming idle or active.
   * @param {'active' | 'idle' | 'locked'} idleState
   * @param {number} [nowMs]
   */
  async handleIdleState(idleState, nowMs = Date.now()) {
    if (idleState === 'active') {
      // Return to active; tab manager will restore active domain if focused
    } else {
      // Idle or locked; close active session
      if (this.activeSession) {
        await this._closeSession(nowMs);
      }
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

