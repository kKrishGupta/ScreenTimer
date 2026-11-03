const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function dateKey({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addLocalDays(parts, amount) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localParts(instant, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: values.weekday,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

// Convert a local wall-clock time to UTC by iteratively accounting for the
// time-zone offset. The schedule is saved in the organization's IANA zone.
function localWallTimestamp(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(parts.minutes / 60), parts.minutes % 60);
}

function localTimeToUtc(date, minuteOfDay, timezone, edge = 'earlier') {
  const desiredWallTime = Date.UTC(date.year, date.month - 1, date.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = desiredWallTime + hours * 60 * 60 * 1000;
    offsets.add(localWallTimestamp(localParts(new Date(sample), timezone)) - sample);
  }

  const exactCandidates = (wallTime) => {
    const candidates = [];
    for (const offset of offsets) {
      const candidate = new Date(wallTime - offset);
      if (localWallTimestamp(localParts(candidate, timezone)) === wallTime) candidates.push(candidate);
    }
    return candidates.sort((left, right) => left - right);
  };

  // When clocks repeat, use the first instant for a shift start and the last
  // instant for its end. This covers the full repeated local-time window.
  const exact = exactCandidates(desiredWallTime);
  if (exact.length) return edge === 'later' ? exact.at(-1) : exact[0];

  // If a configured wall time does not exist during the spring-forward gap,
  // move to the first real minute after the gap. Never invent an instant.
  for (let minute = 1; minute <= 180; minute += 1) {
    const next = exactCandidates(desiredWallTime + minute * 60 * 1000);
    if (next.length) return edge === 'later' ? next.at(-1) : next[0];
  }
  throw new RangeError('Could not resolve scheduled local time in organization time zone');
}

function scheduleWindow(date, shiftStart, shiftEnd, timezone) {
  const startMinute = Number(shiftStart.slice(0, 2)) * 60 + Number(shiftStart.slice(3));
  const endMinute = Number(shiftEnd.slice(0, 2)) * 60 + Number(shiftEnd.slice(3));
  const overnight = endMinute < startMinute;
  const endDate = overnight ? addLocalDays(date, 1) : date;
  return {
    start: localTimeToUtc(date, startMinute, timezone, 'earlier'),
    end: localTimeToUtc(endDate, endMinute, timezone, 'later'),
  };
}

function validSchedule(user) {
  if (!TIME_RE.test(user?.shiftStart || '') || !TIME_RE.test(user?.shiftEnd || '') || user.shiftStart === user.shiftEnd) return false;
  if (!Array.isArray(user.workingDays) || user.workingDays.length === 0 || user.workingDays.some((day) => !WEEKDAYS.includes(day))) return false;
  if (!user.organization?.timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: user.organization.timezone });
  } catch {
    return false;
  }
  return true;
}

function activeWindow(user, now) {
  const timezone = user.organization.timezone;
  const today = localParts(now, timezone);
  for (const dayOffset of [-1, 0]) {
    const date = addLocalDays(today, dayOffset);
    const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
    if (!user.workingDays.includes(weekday)) continue;
    const window = scheduleWindow(date, user.shiftStart, user.shiftEnd, timezone);
    if (now >= window.start && now < window.end) return window;
  }
  return null;
}

function nextScheduleStart(user, now) {
  const timezone = user.organization.timezone;
  const today = localParts(now, timezone);
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = addLocalDays(today, dayOffset);
    const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
    if (!user.workingDays.includes(weekday)) continue;
    const window = scheduleWindow(date, user.shiftStart, user.shiftEnd, timezone);
    if (window.start > now) return window.start;
  }
  return null;
}

export function getMonitoringAuthorization(user, now = new Date()) {
  const denied = (reason, extra = {}) => ({
    allowed: false,
    reason,
    allowedFrom: null,
    allowedUntil: null,
    nextCheckAt: null,
    schedule: null,
    ...extra,
  });

  if (!user) return denied('EMPLOYEE_NOT_FOUND');
  if (user.employmentStatus !== 'active') return denied('ACCOUNT_INACTIVE');
  if (user.monitoringAuthorized !== true) return denied('ADMIN_AUTHORIZATION_REQUIRED');
  if (!user.monitoringConsentAt || (user.monitoringConsentRevokedAt && user.monitoringConsentRevokedAt >= user.monitoringConsentAt)) {
    return denied('USER_CONSENT_REQUIRED', { consentGranted: false });
  }
  if (!user.organization?.timezone) return denied('ORGANIZATION_TIMEZONE_REQUIRED');
  if (!validSchedule(user)) return denied('SCHEDULE_NOT_CONFIGURED');

  const schedule = {
    shiftStart: user.shiftStart,
    shiftEnd: user.shiftEnd,
    workingDays: user.workingDays,
    timezone: user.organization.timezone,
  };
  const window = activeWindow(user, now);
  if (!window) {
    return {
      allowed: false,
      reason: 'OUTSIDE_SCHEDULE',
      allowedFrom: null,
      allowedUntil: null,
      nextCheckAt: nextScheduleStart(user, now)?.toISOString() || null,
      schedule,
      consentGranted: true,
    };
  }
  return {
    allowed: true,
    reason: null,
    allowedFrom: window.start.toISOString(),
    allowedUntil: window.end.toISOString(),
    nextCheckAt: window.end.toISOString(),
    schedule,
    consentGranted: true,
  };
}

export function isEventWithinSchedule(user, startedAt, endedAt) {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = endedAt instanceof Date ? endedAt : new Date(endedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || !validSchedule(user)) return false;
  const startParts = localParts(start, user.organization.timezone);
  for (const dayOffset of [-1, 0, 1]) {
    const date = addLocalDays(startParts, dayOffset);
    const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
    if (!user.workingDays.includes(weekday)) continue;
    const window = scheduleWindow(date, user.shiftStart, user.shiftEnd, user.organization.timezone);
    if (start >= window.start && start < window.end && end <= window.end) return true;
  }
  return false;
}
