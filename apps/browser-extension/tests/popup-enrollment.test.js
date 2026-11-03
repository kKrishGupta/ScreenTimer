import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('an already enrolled popup clears and hides its token controls despite the flex layout', async (t) => {
  const html = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../popup/popup.css', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  const previous = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => { Object.assign(globalThis, previous); dom.window.close(); });
  globalThis.document = dom.window.document;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const state = { dp_device_id: 'existing-browser', dp_device_connection_status: 'connected', dp_last_heartbeat_at: new Date().toISOString() };
  const messages = [];
  globalThis.chrome = {
    storage: { local: { get: async () => state } },
    tabs: { query: async () => [] },
    runtime: { sendMessage: async ({ action }) => {
      messages.push(action);
      if (action === 'get_enrollment_state') return { enrolled: true };
      if (action === 'audit_queue') return {};
      return { heartbeat: { ok: true } };
    } },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok' }));
  await import('../popup/popup.js');
  document.getElementById('enrollment-token').value = 'previously-entered-token';
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  for (let i = 0; i < 20 && !messages.includes('refresh_status'); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(messages.includes('refresh_status'));
  const panel = document.getElementById('enrollment-panel');
  assert.equal(panel.hidden, true);
  assert.equal(dom.window.getComputedStyle(panel).display, 'none');
  assert.equal(document.getElementById('enrollment-token').value, '');
  assert.equal(document.getElementById('enrollment-token').disabled, true);
  assert.equal(document.getElementById('enroll-btn').disabled, true);
  document.getElementById('enroll-btn').click();
  assert.equal(messages.includes('enroll_browser'), false);
});
