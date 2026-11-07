export const SYNC_ALARM_NAME = 'dp_sync';

// Preserve every tab/focus/idle transition while asynchronous session storage
// and upload acknowledgement are in progress. Unlike singleFlight, none are dropped.
export function serializeTasks() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

/**
 * Keep the periodic alarm stable across Manifest V3 worker restarts.
 * Recreating an alarm with the same name replaces it and moves its next run,
 * which can indefinitely postpone synchronization when other extension events
 * repeatedly wake the worker.
 */
export async function ensureSyncAlarm(chromeApi, intervalSeconds) {
  if (!chromeApi?.alarms?.get || !chromeApi.alarms.create) return null;

  const existing = await chromeApi.alarms.get(SYNC_ALARM_NAME);
  if (existing) return existing;

  const periodInMinutes = Math.max(0.5, Number(intervalSeconds || 30) / 60);
  await chromeApi.alarms.create(SYNC_ALARM_NAME, { periodInMinutes });
  return chromeApi.alarms.get(SYNC_ALARM_NAME);
}

/**
 * Coalesce alarm, startup and popup requests into one synchronization run.
 * This prevents concurrent queue snapshots from uploading the same batch.
 */
export function singleFlight(task) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => task(...args))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}
