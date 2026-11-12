import { resolveBackendUrl } from '../shared/backend-settings.js';

export function createSyncClient({ chromeApi, fetchImpl, config, browserName }) {
  const notEnrolledMessage = 'Enroll this device with the one-time token from your DigitalPulse account before monitoring can start.';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const lifecycleCodes = new Set(['DEVICE_REVOKED', 'DEVICE_ARCHIVED']);
  const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));

  function hasValidEventShape(event, deviceId) {
    if (!(event && event.schemaVersion === config.SCHEMA_VERSION && uuidPattern.test(event.eventId || '') &&
      event.deviceId === deviceId && uuidPattern.test(event.deviceId || '') && event.source === 'browser_extension' &&
      ['app_session', 'web_session', 'idle_session'].includes(event.type) &&
      hasOnlyKeys(event, new Set(['schemaVersion', 'eventId', 'deviceId', 'source', 'type', 'startedAt', 'endedAt', 'durationSeconds', 'app', 'web'])))) return false;
    if (event.type === 'web_session') {
      return !event.app && event.web && hasOnlyKeys(event.web, new Set(['domain', 'browser'])) &&
        typeof event.web.domain === 'string' && event.web.domain.length <= 253 && /^[a-z0-9.-]+$/.test(event.web.domain) &&
        ['chrome', 'edge'].includes(event.web.browser);
    }
    if (event.type === 'app_session') {
      return !event.web && event.app && hasOnlyKeys(event.app, new Set(['name', 'executable', 'processId'])) &&
        typeof event.app.name === 'string' && event.app.name.length >= 1 && event.app.name.length <= 256 &&
        typeof event.app.executable === 'string' && event.app.executable.length >= 1 && event.app.executable.length <= 260 &&
        (event.app.processId === undefined || (Number.isInteger(event.app.processId) && event.app.processId >= 0));
    }
    return !event.app && !event.web;
  }

  async function recordLifecycleRejection(code, message) {
    const lifecycleStatus = code === 'DEVICE_REVOKED' ? 'REVOKED' : 'ARCHIVED';
    await chromeApi.storage.local.set({
      dp_device_lifecycle_status: lifecycleStatus,
      dp_enrollment_status: lifecycleStatus.toLowerCase(),
      dp_device_connection_status: 'stopped',
      dp_backend_connection_status: 'connected',
      dp_monitoring_allowed: false,
      dp_monitoring_allowed_until: null,
      dp_monitoring_reason: code,
      dp_sync_error: message,
    });
    return { ok: false, lifecycleStatus, monitoring: { allowed: false, reason: code }, error: message };
  }

  async function resetRejectedEnrollment(message) {
    await chromeApi.storage.local.remove('dp_device_secret');
    await chromeApi.storage.local.set({
      dp_enrollment_status: 'pending',
      dp_device_connection_status: 'pending',
      dp_backend_connection_status: 'connected',
      dp_monitoring_allowed: false,
      dp_monitoring_allowed_until: null,
      dp_monitoring_reason: 'DEVICE_NOT_ENROLLED',
      dp_sync_error: message,
    });
  }

  function prepareQueue(queue, deviceId, rejectedIds = []) {
    const rejected = new Set(rejectedIds);
    const unique = new Map();
    const conflicting = new Set();
    const normalizedQueue = [];
    const quarantine = [];
    const repairs = [];
    let malformed = 0;
    let duplicate = 0;
    let wrongDevice = 0;
    for (const event of queue) {
      if (!uuidPattern.test(event?.eventId || '')) continue;
      const serialized = JSON.stringify(event);
      const previous = unique.get(event.eventId);
      if (previous) {
        duplicate += 1;
        if (previous.serialized !== serialized) conflicting.add(event.eventId);
      } else unique.set(event.eventId, { event, serialized });
    }

    const candidates = new Map();
    for (const original of queue) {
      let reason = null;
      if (conflicting.has(original?.eventId)) reason = 'CONFLICTING_EVENT_ID';
      else if (original?.deviceId && original.deviceId !== deviceId) {
        reason = 'WRONG_DEVICE';
        wrongDevice += 1;
      } else if (!hasValidEventShape(original, deviceId)) {
        reason = 'MALFORMED_EVENT';
        malformed += 1;
      }

      const startedMs = Date.parse(original?.startedAt);
      const endedMs = Date.parse(original?.endedAt);
      const derivedSeconds = Math.round(endedMs - startedMs) / 1000;
      if (!reason && (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || derivedSeconds <= 0)) {
        reason = 'INVALID_TIMESTAMP_INTERVAL';
        malformed += 1;
      } else if (!reason && derivedSeconds > config.MAX_EVENT_DURATION_SECS) {
        reason = 'TIMESTAMP_INTERVAL_EXCEEDS_24_HOURS';
        malformed += 1;
      }

      if (reason) {
        quarantine.push({ event: original, reason, quarantinedAt: new Date().toISOString() });
        continue;
      }

      let event = original;
      const submittedDuration = Number(original.durationSeconds);
      if (!Number.isFinite(submittedDuration) || submittedDuration <= 0 || submittedDuration > config.MAX_EVENT_DURATION_SECS || Math.abs(submittedDuration - derivedSeconds) > 0.001) {
        event = { ...original, durationSeconds: derivedSeconds };
        repairs.push({
          eventId: original.eventId,
          reason: 'DURATION_REBUILT_FROM_TIMESTAMPS',
          previousDurationSeconds: Number.isFinite(submittedDuration) ? submittedDuration : null,
          repairedDurationSeconds: derivedSeconds,
          repairedAt: new Date().toISOString(),
        });
      }
      normalizedQueue.push(event);
      if (!candidates.has(event.eventId) && !rejected.has(event.eventId)) candidates.set(event.eventId, event);
    }
    return {
      queue: normalizedQueue,
      candidates: [...candidates.values()],
      quarantine,
      repairs,
      malformed,
      duplicate,
      wrongDevice,
      conflicting: conflicting.size,
      rejected: rejected.size,
    };
  }

  async function persistRecovery(prepared, stored) {
    if (!prepared.quarantine.length && !prepared.repairs.length) return;
    await chromeApi.storage.local.set({
      [config.SYNC_QUEUE_STORAGE_KEY]: prepared.queue,
      [config.QUARANTINE_STORAGE_KEY]: [...(stored[config.QUARANTINE_STORAGE_KEY] || []), ...prepared.quarantine],
      [config.QUEUE_REPAIR_LOG_STORAGE_KEY]: [...(stored[config.QUEUE_REPAIR_LOG_STORAGE_KEY] || []), ...prepared.repairs],
    });
  }

  let enrollmentInFlight = null;
  function enrollBrowserDevice(token, deviceId) {
    if (enrollmentInFlight) return enrollmentInFlight;
    enrollmentInFlight = performEnrollment(token, deviceId).finally(() => { enrollmentInFlight = null; });
    return enrollmentInFlight;
  }

  async function performEnrollment(token, deviceId) {
    const stored = await chromeApi.storage.local.get([config.SETTINGS_STORAGE_KEY, config.DEVICE_STORAGE_KEY, 'dp_device_secret']);
    if (stored.dp_device_secret && stored[config.DEVICE_STORAGE_KEY]) {
      return { success: true, deviceId: stored[config.DEVICE_STORAGE_KEY], alreadyEnrolled: true };
    }
    const backendUrl = resolveBackendUrl(stored, config);
    let response;
    try {
      response = await fetchImpl(`${backendUrl}/api/v1/devices/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          token,
          deviceId,
          name: `${browserName === 'edge' ? 'Edge' : 'Chrome'} Extension`,
          platform: 'windows',
          browser: browserName,
          agentVersion: chromeApi.runtime.getManifest().version,
        }),
      });
    } catch (error) {
      throw new Error(`Enrollment request did not reach ${backendUrl}: ${error.message || error}`);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.deviceSecret) throw new Error(result.error?.message || `Enrollment was rejected by the backend (HTTP ${response.status}).`);
    await chromeApi.storage.local.set({
      [config.DEVICE_STORAGE_KEY]: result.deviceId,
      [config.SETTINGS_STORAGE_KEY]: { ...stored[config.SETTINGS_STORAGE_KEY], backendUrl },
      dp_device_secret: result.deviceSecret,
      dp_enrollment_status: 'enrolled',
      dp_device_lifecycle_status: 'ACTIVE',
      dp_device_connection_status: 'waiting',
      dp_sync_error: '',
    });
    // The long-lived secret remains in the background worker's storage path;
    // never return it through the popup message channel.
    return { success: true, deviceId: result.deviceId };
  }

  async function sendHeartbeat() {
    const stored = await chromeApi.storage.local.get([
      config.DEVICE_STORAGE_KEY,
      config.SETTINGS_STORAGE_KEY,
      'dp_device_secret',
      'dp_monitoring_allowed',
      'dp_monitoring_allowed_until',
      'dp_monitoring_reason',
      'dp_device_lifecycle_status',
    ]);
    const deviceId = stored[config.DEVICE_STORAGE_KEY];
    const deviceSecret = stored.dp_device_secret;
    let backendUrl;
    try { backendUrl = resolveBackendUrl(stored, config); }
    catch (error) {
      await chromeApi.storage.local.set({ dp_monitoring_allowed: false, dp_monitoring_allowed_until: null, dp_device_connection_status: 'offline', dp_sync_error: error.message });
      return { ok: false, error: error.message };
    }
    if (!deviceId || !deviceSecret) {
      await chromeApi.storage.local.set({
        dp_device_connection_status: 'pending',
        dp_enrollment_status: 'pending',
        dp_sync_error: '',
        dp_monitoring_allowed: false,
        dp_monitoring_allowed_until: null,
        dp_monitoring_reason: 'DEVICE_NOT_ENROLLED',
      });
      return { ok: false, deferred: true, monitoring: { allowed: false, reason: 'DEVICE_NOT_ENROLLED' }, error: notEnrolledMessage };
    }
    await chromeApi.storage.local.set({ dp_enrollment_status: 'enrolled' });
    try {
      const response = await fetchImpl(`${backendUrl}/api/v1/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Device-Secret': deviceSecret },
        body: JSON.stringify({ agentVersion: chromeApi.runtime.getManifest().version, metrics: { collector: 'browser-extension' } }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.status !== 'healthy') {
        const code = result.error?.code;
        const message = result.error?.message || `Heartbeat failed (${response.status}).`;
        if (lifecycleCodes.has(code)) return recordLifecycleRejection(code, message);
        throw new Error(message);
      }
      const at = new Date().toISOString();
      await chromeApi.storage.local.set({
        dp_device_connection_status: 'connected',
        dp_backend_connection_status: 'connected',
        dp_last_heartbeat_at: at,
        dp_sync_error: '',
        dp_device_lifecycle_status: 'ACTIVE',
        dp_enrollment_status: 'enrolled',
        dp_monitoring_allowed: result.monitoring?.allowed === true && Date.parse(result.monitoring?.allowedUntil || '') > Date.now(),
        dp_monitoring_allowed_until: result.monitoring?.allowedUntil || null,
        dp_monitoring_reason: result.monitoring?.reason || (result.monitoring?.allowed ? '' : 'MONITORING_CONFIGURATION_UNAVAILABLE'),
      });
      return { ok: true, at, monitoring: result.monitoring || { allowed: false, reason: 'MONITORING_CONFIGURATION_UNAVAILABLE' } };
    } catch (error) {
      await chromeApi.storage.local.set({ dp_device_connection_status: 'offline', dp_backend_connection_status: 'offline', dp_monitoring_allowed: false, dp_monitoring_allowed_until: null, dp_monitoring_reason: 'HEARTBEAT_UNAVAILABLE', dp_sync_error: error.message || 'Heartbeat failed.' });
      return { ok: false, error: error.message || 'Heartbeat failed.' };
    }
  }

  async function syncQueue() {
    const stored = await chromeApi.storage.local.get([
      config.SYNC_QUEUE_STORAGE_KEY,
      config.DEVICE_STORAGE_KEY,
      config.SETTINGS_STORAGE_KEY,
      'dp_device_secret',
      'dp_monitoring_allowed',
      'dp_monitoring_allowed_until',
      'dp_monitoring_reason',
      'dp_rejected_event_ids',
      'dp_device_lifecycle_status',
      config.QUARANTINE_STORAGE_KEY,
      config.QUEUE_REPAIR_LOG_STORAGE_KEY,
    ]);
    let queue = stored[config.SYNC_QUEUE_STORAGE_KEY] || [];
    const deviceId = stored[config.DEVICE_STORAGE_KEY];
    const deviceSecret = stored.dp_device_secret || '';
    if (!deviceId || !deviceSecret) {
      await chromeApi.storage.local.set({ dp_enrollment_status: 'pending', dp_sync_error: '', dp_monitoring_allowed: false });
      return { ok: false, deferred: true, error: notEnrolledMessage, queued: queue.length };
    }
    if (['REVOKED', 'ARCHIVED'].includes(stored.dp_device_lifecycle_status)) {
      return { ok: false, lifecyclePaused: true, lifecycleStatus: stored.dp_device_lifecycle_status, reason: `DEVICE_${stored.dp_device_lifecycle_status}`, queued: queue.length };
    }
    const prepared = prepareQueue(queue, deviceId, stored.dp_rejected_event_ids || []);
    await persistRecovery(prepared, stored);
    queue = prepared.queue;
    const audit = {
      total: queue.length,
      malformed: prepared.malformed,
      duplicates: prepared.duplicate,
      wrongDevice: prepared.wrongDevice,
      conflicting: prepared.conflicting,
      rejected: prepared.rejected,
      repaired: prepared.repairs.length,
      quarantined: (stored[config.QUARANTINE_STORAGE_KEY] || []).length + prepared.quarantine.length,
      eligible: prepared.candidates.length,
    };
    await chromeApi.storage.local.set({ dp_queue_audit: audit });
    const allowedUntilMs = Date.parse(stored.dp_monitoring_allowed_until || '');
    if (stored.dp_monitoring_allowed !== true || !Number.isFinite(allowedUntilMs) || Date.now() >= allowedUntilMs) {
      await chromeApi.storage.local.set({ dp_monitoring_allowed: false });
      return { ok: false, monitoringPaused: true, reason: stored.dp_monitoring_reason || 'MONITORING_NOT_AUTHORIZED', queued: queue.length };
    }
    if (queue.length === 0) return { ok: true, queued: 0, synced: 0, audit };
    if (prepared.candidates.length === 0) return { ok: queue.length === 0, queued: queue.length, synced: 0, audit, error: queue.length ? 'No pending events are currently eligible for upload. Skipped records remain available for review.' : undefined };

    let backendUrl;
    try { backendUrl = resolveBackendUrl(stored, config); }
    catch (error) { return { ok: false, error: error.message }; }
    const events = prepared.candidates.slice(0, 50);
    const batch = {
      device: {
        id: deviceId,
        kind: 'browser_extension',
        name: `${browserName.toUpperCase()} Extension`,
        platform: 'windows',
        browser: browserName,
        agentVersion: chromeApi.runtime.getManifest().version,
      },
      events,
    };

    try {
      const response = await fetchImpl(`${backendUrl}/api/v1/activity/events/batch`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Device-Secret': deviceSecret },
        body: JSON.stringify(batch),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = result.error?.message || `Event sync failed (${response.status}).`;
        const code = result.error?.code;
        if (lifecycleCodes.has(code)) {
          await recordLifecycleRejection(code, message);
        } else if (response.status === 401 || response.status === 403) {
          await resetRejectedEnrollment(`Device credential was rejected. Create a new browser-extension token and enroll again. Pending events were preserved. (${message})`);
        }
        throw new Error(message);
      }
      const sentIds = new Set(events.map((event) => event.eventId));
      const acknowledgedIds = [
        ...(Array.isArray(result.acceptedEventIds) ? result.acceptedEventIds : []),
        ...(Array.isArray(result.deduplicatedEventIds) ? result.deduplicatedEventIds : []),
      ];
      const rejectedIds = Array.isArray(result.rejectedEventIds) ? result.rejectedEventIds : [];
      if ([...acknowledgedIds, ...rejectedIds].some((id) => !sentIds.has(id)) || new Set(acknowledgedIds).size !== acknowledgedIds.length || new Set(rejectedIds).size !== rejectedIds.length || rejectedIds.some((id) => acknowledgedIds.includes(id))) {
        throw new Error('Backend returned an invalid event acknowledgement; the queue was preserved.');
      }
      const acknowledged = acknowledgedIds.length;
      if (acknowledged === 0 && rejectedIds.length === 0) throw new Error('Backend did not acknowledge any events; the queue was preserved.');

      // Re-read before removing the acknowledged batch. Concurrent syncs or
      // newly queued events must never cause unacknowledged rows to disappear.
      const latest = await chromeApi.storage.local.get([config.SYNC_QUEUE_STORAGE_KEY]);
      const currentQueue = latest[config.SYNC_QUEUE_STORAGE_KEY] || [];
      const acknowledgedSet = new Set(acknowledgedIds);
      const remaining = currentQueue.filter((event) => !acknowledgedSet.has(event.eventId));
      const currentRejected = await chromeApi.storage.local.get(['dp_rejected_event_ids']);
      const rejectionSet = new Set(currentRejected.dp_rejected_event_ids || []);
      rejectedIds.forEach((id) => rejectionSet.add(id));
      await chromeApi.storage.local.set({ [config.SYNC_QUEUE_STORAGE_KEY]: remaining, dp_rejected_event_ids: [...rejectionSet] });

      const at = new Date().toISOString();
      const complete = acknowledged === events.length;
      const syncError = complete ? '' : rejectedIds.length
        ? `${rejectedIds.length} event(s) were outside the authorized consent or schedule window and remain queued for review.`
        : `Backend acknowledged ${acknowledged} of ${events.length} events; remaining events are retained for retry.`;
      await chromeApi.storage.local.set({ dp_last_successful_sync_at: at, dp_sync_error: syncError });
      return { ok: complete, queued: remaining.length, synced: acknowledged, rejected: rejectedIds.length, audit, at, error: syncError || undefined };
    } catch (error) {
      // Retain the complete batch until the backend acknowledges every event.
      await chromeApi.storage.local.set({ dp_sync_error: error.message || 'Sync deferred.' });
      return { ok: false, error: error.message || 'Sync deferred.', queued: queue.length };
    }
  }

  async function auditQueueState() {
    const stored = await chromeApi.storage.local.get([config.SYNC_QUEUE_STORAGE_KEY, config.DEVICE_STORAGE_KEY, 'dp_rejected_event_ids', config.QUARANTINE_STORAGE_KEY]);
    const queue = stored[config.SYNC_QUEUE_STORAGE_KEY] || [];
    const audit = prepareQueue(queue, stored[config.DEVICE_STORAGE_KEY] || '', stored.dp_rejected_event_ids || []);
    const result = { total: queue.length, malformed: audit.malformed, duplicates: audit.duplicate, wrongDevice: audit.wrongDevice, conflicting: audit.conflicting, rejected: audit.rejected, repaired: audit.repairs.length, quarantined: (stored[config.QUARANTINE_STORAGE_KEY] || []).length, pendingQuarantine: audit.quarantine.length, eligible: audit.candidates.length };
    await chromeApi.storage.local.set({ dp_queue_audit: result });
    return result;
  }

  async function getActivityQuarantine() {
    const stored = await chromeApi.storage.local.get([config.QUARANTINE_STORAGE_KEY]);
    return { records: stored[config.QUARANTINE_STORAGE_KEY] || [] };
  }

  return { enrollBrowserDevice, sendHeartbeat, syncQueue, auditQueueState, getActivityQuarantine };
}
