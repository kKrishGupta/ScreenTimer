import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { activityEventSchema } from '@digitalpulse/contracts';
import { extractDomain } from '../shared/constants.js';
import { TabManager, reconcileActiveTab } from '../background/tab-manager.js';
import { serializeTasks } from '../background/sync-scheduler.js';
import { ActivityManager } from '../background/activity-manager.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateEvent = ajv.compile(activityEventSchema);

test('automatic tab reconciliation resumes same-domain tracking and respects idle/focus', async () => {
  const activity = new ActivityManager({ deviceId: '11111111-2222-3333-4444-555555555555', browser: 'chrome' });
  const tabs = new TabManager({ onActiveDomainChanged: domain => activity.switchDomain(domain) });
  let focused = true;
  let idle = 'active';
  let url = 'https://erp.akgec.ac.in/Dual_Auth_Login';
  const chromeApi = {
    windows: { getLastFocused: async () => ({ focused }) },
    idle: { queryState: async () => idle },
    tabs: { query: async () => [{ url }] },
  };
  const allow = { allowed: true, allowedUntil: new Date(Date.now() + 600000).toISOString() };
  await activity.setMonitoringState(allow);
  await reconcileActiveTab(chromeApi, activity, tabs, 60);
  assert.equal(activity.activeSession.domain, 'erp.akgec.ac.in');
  await activity.setMonitoringState({ allowed: false });
  await activity.setMonitoringState(allow);
  await reconcileActiveTab(chromeApi, activity, tabs, 60);
  assert.equal(activity.activeSession.domain, 'erp.akgec.ac.in');
  idle = 'idle';
  await reconcileActiveTab(chromeApi, activity, tabs, 60);
  assert.equal(activity.activeSession, null);
  idle = 'active'; focused = false;
  await reconcileActiveTab(chromeApi, activity, tabs, 60);
  assert.equal(activity.activeSession, null);
  focused = true; url = 'http://localhost:5173/employee-portal';
  await reconcileActiveTab(chromeApi, activity, tabs, 60);
  assert.equal(activity.activeSession.domain, 'localhost');
});

test('tab transitions wait for session persistence before the automatic checkpoint', async () => {
  const run = serializeTasks();
  const events = [];
  let now = Date.now() - 60000;
  const activity = new ActivityManager({ deviceId: '11111111-2222-3333-4444-555555555555', browser: 'chrome',
    onSessionCompleted: async event => { await new Promise(resolve => setTimeout(resolve, 10)); events.push(event); } });
  await activity.setMonitoringState({ allowed: true, allowedUntil: new Date(now + 600000).toISOString() }, now);
  const tabs = new TabManager({ onActiveDomainChanged: domain => activity.switchDomain(domain, now) });
  await tabs.handleTabActivated({ url: 'https://first.example' });
  now += 10000;
  await Promise.all([
    run(() => tabs.handleTabActivated({ url: 'https://second.example' })),
    run(() => activity.checkpoint(now + 10000)),
  ]);
  assert.deepEqual(events.map(event => [event.web.domain, event.durationSeconds]), [['first.example', 10], ['second.example', 10]]);
});

test('extractDomain correctly normalizes domains without paths or queries', () => {
  assert.equal(extractDomain('https://github.com/microsoft/vscode'), 'github.com');
  assert.equal(extractDomain('http://docs.rs/windows/latest'), 'docs.rs');
  assert.equal(extractDomain('https://sub.domain.co.uk:8080/test?foo=bar#hash'), 'sub.domain.co.uk');
  assert.equal(extractDomain('chrome://extensions'), null);
  assert.equal(extractDomain('chrome-extension://abcdef/popup.html'), null);
  assert.equal(extractDomain('about:blank'), null);
  assert.equal(extractDomain('edge://settings'), null);
  assert.equal(extractDomain('file:///C:/Users/dell/doc.pdf'), null);
  assert.equal(extractDomain('view-source:https://example.com'), null);
  assert.equal(extractDomain(null), null);
});

test('TabManager emits domain change on tab switch', () => {
  let activeDomain = null;
  const manager = new TabManager({
    onActiveDomainChanged: (domain) => {
      activeDomain = domain;
    },
  });

  manager.handleTabActivated({ url: 'https://developer.mozilla.org/en-US/docs/Web' });
  assert.equal(activeDomain, 'developer.mozilla.org');

  manager.handleTabActivated({ url: 'https://news.ycombinator.com/' });
  assert.equal(activeDomain, 'news.ycombinator.com');

  // When window loses focus, domain is cleared
  manager.handleWindowFocusChanged(false);
  assert.equal(activeDomain, null);

  // When window regains focus, domain is restored
  manager.handleWindowFocusChanged(true, 'https://news.ycombinator.com/');
  assert.equal(activeDomain, 'news.ycombinator.com');
});

test('ActivityManager records session duration and emits schema-compliant event', async () => {
  const events = [];
  const manager = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555',
    browser: 'chrome',
    onSessionCompleted: async (event) => {
      events.push(event);
    },
  });

  const t0 = 1700000000000;
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(t0 + 600000).toISOString() }, t0);
  await manager.switchDomain('github.com', t0);

  // 15 seconds later, switch to stackoverflow.com
  const t1 = t0 + 15000;
  await manager.switchDomain('stackoverflow.com', t1);

  assert.equal(events.length, 1);
  const session1 = events[0];
  assert.equal(session1.web.domain, 'github.com');
  assert.equal(session1.web.browser, 'chrome');
  assert.equal(session1.durationSeconds, 15);
  assert.equal(session1.source, 'browser_extension');
  assert.equal(session1.type, 'web_session');
  assert.ok(validateEvent(session1), JSON.stringify(validateEvent.errors));

  // Idle triggers session closure
  const t2 = t1 + 30000;
  await manager.handleIdleState('idle', t2);
  assert.equal(events.length, 2);
  const session2 = events[1];
  assert.equal(session2.web.domain, 'stackoverflow.com');
  assert.equal(session2.durationSeconds, 30);
  assert.ok(validateEvent(session2), JSON.stringify(validateEvent.errors));
});

test('ActivityManager tags Edge browser sessions correctly', async () => {
  const events = [];
  const manager = new ActivityManager({
    deviceId: '22222222-3333-4444-5555-666666666666',
    browser: 'edge',
    onSessionCompleted: async (event) => {
      events.push(event);
    },
  });

  const t0 = 1700000000000;
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(t0 + 600000).toISOString() }, t0);
  await manager.switchDomain('microsoft.com', t0);
  await manager.switchDomain('learn.microsoft.com', t0 + 20000);

  assert.equal(events.length, 1);
  assert.equal(events[0].web.browser, 'edge');
  assert.equal(events[0].web.domain, 'microsoft.com');
  assert.ok(validateEvent(events[0]), JSON.stringify(validateEvent.errors));
});

test('ActivityManager suppresses sub-second flickers', async () => {
  const events = [];
  const manager = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555',
    browser: 'chrome',
    onSessionCompleted: async (event) => {
      events.push(event);
    },
  });

  const t0 = 1700000000000;
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(t0 + 600000).toISOString() }, t0);
  await manager.switchDomain('google.com', t0);

  // Switch after 400ms (momentary tab click)
  await manager.switchDomain('example.com', t0 + 400);

  // google.com should be ignored because duration < 1s
  assert.equal(events.length, 0);
});

test('does not collect without verified monitoring authorization and stops at schedule end', async () => {
  const events = [];
  const manager = new ActivityManager({ deviceId: '11111111-2222-3333-4444-555555555555', browser: 'chrome', onSessionCompleted: async (event) => events.push(event) });
  const start = 1700000000000;
  await manager.switchDomain('private.example', start);
  assert.equal(manager.activeSession, null);
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(start + 5000).toISOString() }, start);
  await manager.switchDomain('example.com', start);
  await manager.checkpoint(start + 6000);
  assert.equal(manager.monitoringAllowed, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].durationSeconds, 5);
});

test('ActivityManager persists an open session and restores the selected domain after idle', async () => {
  const states = [];
  const start = Date.now() - 10_000;
  const manager = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555', browser: 'chrome',
    onSessionChanged: (session) => states.push(session),
  });
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(Date.now() + 600000).toISOString() }, start);
  await manager.switchDomain('example.com', start);
  assert.deepEqual(states.at(-1), { domain: 'example.com', startedAt: start });
  await manager.handleIdleState('idle', start + 2000);
  assert.equal(states.at(-1), null);
  await manager.handleIdleState('active', start + 3000, 'example.com');
  assert.equal(manager.activeSession.domain, 'example.com');

  const restarted = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555', browser: 'chrome',
    initialSession: { domain: 'example.com', startedAt: start + 3000 },
  });
  await restarted.setMonitoringState({ allowed: true, allowedUntil: new Date(Date.now() + 600000).toISOString() });
  assert.equal(restarted.activeSession.domain, 'example.com');
});

test('ActivityManager does not fabricate activity across a sleep/wake or stale-session gap', async () => {
  const events = [];
  const anomalies = [];
  const start = 1700000000000;
  const manager = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555',
    browser: 'chrome',
    initialSession: { domain: 'example.com', startedAt: start },
    onSessionCompleted: async (event) => events.push(event),
    onSessionAnomaly: async (anomaly) => anomalies.push(anomaly),
  });
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(start + 172800000).toISOString() }, start);
  await manager.checkpoint(start + 86400000 + 1000);
  assert.equal(events.length, 0);
  assert.equal(anomalies[0].reason, 'UNOBSERVED_SESSION_GAP');
  assert.equal(manager.activeSession.startedAt, start + 86400000 + 1000, 'the next observed interval starts at wake time');
  await manager.checkpoint(start + 86400000 + 11000);
  assert.equal(events[0].durationSeconds, 10);
});

test('ActivityManager records a real short interval that crosses midnight', async () => {
  const events = [];
  const start = Date.parse('2026-11-11T23:59:50.000Z');
  const manager = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555', browser: 'chrome',
    onSessionCompleted: async (event) => events.push(event),
  });
  await manager.setMonitoringState({ allowed: true, allowedUntil: new Date(start + 600000).toISOString() }, start);
  await manager.switchDomain('example.com', start);
  await manager.checkpoint(start + 20000);
  assert.equal(events[0].startedAt, '2026-11-11T23:59:50.000Z');
  assert.equal(events[0].endedAt, '2026-11-12T00:00:10.000Z');
  assert.equal(events[0].durationSeconds, 20);
});
