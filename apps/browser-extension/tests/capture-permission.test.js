import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initializeCapturePermission } from '../popup/capture-permission.js';

test('permission onboarding requests only from a click and handles denial, grant and removal', async () => {
  const dom = new JSDOM(await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8'));
  try {
    let allowed = false;
    let accept = false;
    let requests = 0;
    const api = { permissions: {
      contains: async () => allowed,
      request: async (permission) => { requests++; assert.deepEqual(permission, { origins: ['<all_urls>'] }); allowed = accept; return allowed; },
      remove: async () => { allowed = false; return true; },
    } };
    const doc = dom.window.document;
    initializeCapturePermission(doc, api);
    await new Promise(setImmediate);
    assert.equal(requests, 0);
    const grant = doc.getElementById('capture-permission-grant');
    grant.click();
    assert.equal(requests, 1, 'request begins synchronously in the click gesture');
    await new Promise(setImmediate);
    assert.match(doc.getElementById('capture-permission-status').textContent, /declined/);
    accept = true;
    grant.click();
    await new Promise(setImmediate);
    assert.equal(grant.hidden, true);
    doc.getElementById('capture-permission-revoke').click();
    await new Promise(setImmediate);
    assert.equal(allowed, false);
    assert.equal(grant.hidden, false);
  } finally { dom.window.close(); }
});

test('manifest declares optional all-URL access, not an automatic broad grant', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
  assert.equal(manifest.permissions.includes('activeTab'), false);
  assert.equal(manifest.background.service_worker, 'background/service-worker.js');
});
