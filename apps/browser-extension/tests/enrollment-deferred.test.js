import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONFIG } from '../shared/constants.js';

test('self enrollment is available while activity collection remains server-authorized', async () => {
  const html = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const sync = await readFile(new URL('../background/sync-client.js', import.meta.url), 'utf8');
  const manager = await readFile(new URL('../background/activity-manager.js', import.meta.url), 'utf8');

  assert.equal(CONFIG.ENROLLMENT_UI_ENABLED, true);
  assert.match(html, /id="enrollment-panel" hidden/);
  assert.match(html, /one-time enrollment token/i);
  assert.match(html, /Pending Queue:/);
  assert.match(popup, /enroll_browser/);
  assert.match(worker, /setMonitoringState/);
  assert.match(sync, /dp_monitoring_allowed/);
  assert.match(manager, /monitoringAllowed = false/);
  assert.match(manager, /allowedUntil/);
  assert.doesNotMatch(popup, /Device enrollment is not configured yet/);
});
