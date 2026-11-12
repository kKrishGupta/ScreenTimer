import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateIntervals, exclusiveUsage } from '../src/modules/activity/activity-aggregation.js';
import { normalizeDomain } from '../src/modules/activity/activity.routes.js';
import { reportingDayRange } from '../src/modules/devices/monitoring-authorization.js';

const start = new Date('2026-11-10T00:00:00.000Z');
const end = new Date('2026-11-11T00:00:00.000Z');

function session(id, type, from, to, extra = {}) {
  return { id, activityEventId: id, deviceId: 'device-1', type, startedAt: from, endedAt: to, ...extra };
}

test('active and idle totals union duplicates and make idle exclusive of recorded active time', () => {
  const sessions = [
    session('app-a', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z'),
    session('app-b', 'APP_SESSION', '2026-11-10T00:05:00Z', '2026-11-10T00:15:00Z'),
    session('duplicate-row', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z'),
    session('idle', 'IDLE_SESSION', '2026-11-10T00:08:00Z', '2026-11-10T00:20:00Z'),
  ];
  const totals = aggregateIntervals(sessions, start, end);
  assert.deepEqual(totals, { activeSeconds: 900, idleSeconds: 300, monitoredSeconds: 1200 });
});

test('application breakdown attributes overlapping foreground intervals once and deduplicates event replay', () => {
  const appA = { executableName: 'EDITOR.EXE', displayName: 'Editor' };
  const appB = { executableName: 'terminal.exe', displayName: 'Terminal' };
  const sessions = [
    session('event-a', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z', { application: appA }),
    { ...session('duplicate-db-row', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z', { application: appA }), activityEventId: 'event-a' },
    { ...session('legacy-copy-a', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z', { application: appA }), activityEventId: undefined },
    { ...session('legacy-copy-b', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z', { application: appA }), activityEventId: undefined },
    session('event-b', 'APP_SESSION', '2026-11-10T00:05:00Z', '2026-11-10T00:15:00Z', { application: appB }),
  ];
  const usage = exclusiveUsage(sessions, {
    type: 'APP_SESSION', start, end,
    identity: (item) => item.application.executableName.toLowerCase(),
    describe: (item, executable) => ({ name: item.application.displayName, executable }),
  });
  assert.equal(usage.totalSeconds, 900);
  assert.deepEqual(usage.items.map(({ name, totalSeconds }) => ({ name, totalSeconds })), [
    { name: 'Terminal', totalSeconds: 600 },
    { name: 'Editor', totalSeconds: 300 },
  ]);
  assert.equal(usage.items.reduce((sum, item) => sum + item.percentage, 0), 100);
});

test('website usage normalizes repeated domains without inferring browser executable time', () => {
  assert.equal(normalizeDomain('HTTPS://WWW.GitHub.com:443/org/repo?tab=readme'), 'github.com');
  assert.equal(normalizeDomain('gist.github.com.'), 'github.com');
  const sessions = [
    session('web-a', 'WEB_SESSION', '2026-11-10T01:00:00Z', '2026-11-10T01:02:00Z', { website: { domain: 'www.github.com' } }),
    session('web-b', 'WEB_SESSION', '2026-11-10T01:02:00Z', '2026-11-10T01:03:00Z', { website: { domain: 'gist.github.com' } }),
    session('desktop', 'APP_SESSION', '2026-11-10T01:00:00Z', '2026-11-10T02:00:00Z', { application: { executableName: 'chrome.exe' } }),
  ];
  const usage = exclusiveUsage(sessions, {
    type: 'WEB_SESSION', start, end,
    identity: (item) => normalizeDomain(item.website.domain),
    describe: (_item, domain) => ({ name: domain, domain }),
  });
  assert.equal(usage.totalSeconds, 180);
  assert.deepEqual(usage.items.map((item) => item.domain), ['github.com']);
});

test('cross-midnight sessions are clipped to the reporting window and empty usage is safe', () => {
  const usage = exclusiveUsage([
    session('cross-midnight', 'WEB_SESSION', '2026-11-09T23:55:00Z', '2026-11-10T00:05:00Z', { website: { domain: 'example.test' } }),
  ], {
    type: 'WEB_SESSION', start, end,
    identity: (item) => item.website.domain,
    describe: (_item, domain) => ({ name: domain, domain }),
  });
  assert.equal(usage.totalSeconds, 300);
  assert.deepEqual(exclusiveUsage([], { type: 'WEB_SESSION', start, end, identity: () => '', describe: () => ({}) }), { totalSeconds: 0, items: [] });
});

test('reporting day follows the organization time zone including DST-length days', () => {
  const india = reportingDayRange(new Date('2026-11-10T20:00:00Z'), 'Asia/Kolkata');
  assert.equal(india.date, '2026-11-11');
  assert.equal(india.start.toISOString(), '2026-11-10T18:30:00.000Z');
  assert.equal(india.end.toISOString(), '2026-11-11T18:30:00.000Z');

  const newYorkFallback = reportingDayRange(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
  assert.equal((newYorkFallback.end - newYorkFallback.start) / 3600000, 25);
});

test('multi-device employee activity preserves each device while deduplicating only within a device', () => {
  const editor = { executableName: 'editor.exe', displayName: 'Editor' };
  const terminal = { executableName: 'terminal.exe', displayName: 'Terminal' };
  const sessions = [
    session('shared-event', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z', { application: editor }),
    { ...session('same-device-copy', 'APP_SESSION', '2026-11-10T00:00:00Z', '2026-11-10T00:10:00Z', { application: editor }), activityEventId: 'shared-event' },
    { ...session('device-two-event', 'APP_SESSION', '2026-11-10T00:10:00Z', '2026-11-10T00:20:00Z', { application: terminal }), activityEventId: 'shared-event', deviceId: 'device-2' },
    { ...session('device-two-web', 'WEB_SESSION', '2026-11-10T00:05:00Z', '2026-11-10T00:15:00Z', { website: { domain: 'www.github.com' } }), deviceId: 'device-2' },
    session('idle', 'IDLE_SESSION', '2026-11-10T00:15:00Z', '2026-11-10T00:25:00Z'),
  ];

  assert.deepEqual(aggregateIntervals(sessions, start, end), {
    activeSeconds: 1200,
    idleSeconds: 300,
    monitoredSeconds: 1500,
  });

  const applications = exclusiveUsage(sessions, {
    type: 'APP_SESSION', start, end,
    identity: (item) => item.application.executableName.toLowerCase(),
    describe: (item, executable) => ({ name: item.application.displayName, executable }),
  });
  assert.equal(applications.totalSeconds, 1200);
  assert.deepEqual(applications.items.map(({ name, totalSeconds, percentage }) => ({ name, totalSeconds, percentage })), [
    { name: 'Editor', totalSeconds: 600, percentage: 50 },
    { name: 'Terminal', totalSeconds: 600, percentage: 50 },
  ]);

  const websites = exclusiveUsage(sessions, {
    type: 'WEB_SESSION', start, end,
    identity: (item) => normalizeDomain(item.website.domain),
    describe: (_item, domain) => ({ name: domain, domain }),
  });
  assert.equal(websites.totalSeconds, 600);
  assert.deepEqual(websites.items.map(({ domain, totalSeconds, percentage }) => ({ domain, totalSeconds, percentage })), [
    { domain: 'github.com', totalSeconds: 600, percentage: 100 },
  ]);
});

test('truly simultaneous apps on two devices remain one person-time interval with exclusive attribution', () => {
  const sessions = [
    session('device-one-editor', 'APP_SESSION', '2026-11-10T02:00:00Z', '2026-11-10T02:10:00Z', {
      deviceId: 'device-1',
      application: { executableName: 'editor.exe', displayName: 'Editor' },
    }),
    session('device-two-terminal', 'APP_SESSION', '2026-11-10T02:00:00Z', '2026-11-10T02:10:00Z', {
      deviceId: 'device-2',
      application: { executableName: 'terminal.exe', displayName: 'Terminal' },
    }),
  ];

  assert.deepEqual(aggregateIntervals(sessions, start, end), {
    activeSeconds: 600,
    idleSeconds: 0,
    monitoredSeconds: 600,
  });

  const applications = exclusiveUsage(sessions, {
    type: 'APP_SESSION', start, end,
    identity: (item) => item.application.executableName.toLowerCase(),
    describe: (item, executable) => ({ name: item.application.displayName, executable }),
  });

  // The current person-level contract attributes each instant to one app. For
  // an exact cross-device tie, identity ordering is the deterministic tie-break.
  assert.equal(applications.totalSeconds, 600);
  assert.deepEqual(applications.items.map(({ name, totalSeconds, percentage }) => ({ name, totalSeconds, percentage })), [
    { name: 'Editor', totalSeconds: 600, percentage: 100 },
  ]);
});
