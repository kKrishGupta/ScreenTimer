import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDomain } from '../shared/constants.js';
import { TabManager } from '../background/tab-manager.js';
import { ActivityManager } from '../background/activity-manager.js';

test('extractDomain correctly normalizes domains without paths or queries', () => {
  assert.equal(extractDomain('https://github.com/microsoft/vscode'), 'github.com');
  assert.equal(extractDomain('http://docs.rs/windows/latest'), 'docs.rs');
  assert.equal(extractDomain('https://sub.domain.co.uk:8080/test?foo=bar#hash'), 'sub.domain.co.uk');
  assert.equal(extractDomain('chrome://extensions'), null);
  assert.equal(extractDomain('about:blank'), null);
  assert.equal(extractDomain('edge://settings'), null);
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

test('ActivityManager records session duration and emits compliant event', async () => {
  const events = [];
  const manager = new ActivityManager({
    deviceId: '11111111-2222-3333-4444-555555555555',
    browser: 'chrome',
    onSessionCompleted: async (event) => {
      events.push(event);
    },
  });

  const t0 = 1700000000000;
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

  // Idle triggers session closure
  const t2 = t1 + 30000;
  await manager.handleIdleState('idle', t2);
  assert.equal(events.length, 2);
  const session2 = events[1];
  assert.equal(session2.web.domain, 'stackoverflow.com');
  assert.equal(session2.durationSeconds, 30);
});

