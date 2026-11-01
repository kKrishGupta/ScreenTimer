import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

function createMockPrisma() {
  return {
    $connect: async () => {},
    $disconnect: async () => {},
    $queryRaw: async () => [{ '?column?': 1 }],
  };
}

test('Screen Monitoring API (Milestone 7)', async (t) => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5433/test',
    HOST: '127.0.0.1',
    PORT: '3001',
  });
  const app = await buildApp({ config, prisma: createMockPrisma(), logger: false });

  await t.test('GET /api/v1/screen/config returns initial state requiring consent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/screen/config',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.consentGranted, false);
    assert.equal(body.status, 'stopped');
  });

  await t.test('POST /api/v1/screen/capture rejected when consent is not granted (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/capture',
      payload: { applicationName: 'Test App' },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.equal(body.error.code, 'CONSENT_REQUIRED');
  });

  await t.test('POST /api/v1/screen/consent enables monitoring and grants consent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/consent',
      payload: { consent: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.consentGranted, true);
    assert.equal(body.status, 'active');
  });

  let captureId;
  await t.test('POST /api/v1/screen/capture succeeds when consent is granted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/capture',
      payload: { applicationName: 'Notepad' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.capture.applicationName, 'Notepad');
    assert.ok(body.capture.id);
    captureId = body.capture.id;
  });

  await t.test('GET /api/v1/screen/captures returns captured screenshot', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/screen/captures',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.count >= 1);
    const found = body.captures.find((c) => c.id === captureId);
    assert.ok(found);
    assert.equal(found.applicationName, 'Notepad');
  });

  await t.test('POST /api/v1/screen/state pauses and resumes monitoring', async () => {
    const pauseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/state',
      payload: { action: 'pause', pauseMinutes: 15 },
    });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.json().status, 'paused');

    // While paused, capture is rejected with 409
    const captureWhilePaused = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/capture',
      payload: { applicationName: 'Notepad' },
    });
    assert.equal(captureWhilePaused.statusCode, 409);

    // Resume
    const resumeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/state',
      payload: { action: 'resume' },
    });
    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeRes.json().status, 'active');
  });

  await t.test('POST /api/v1/screen/live-session/start and stop manages temporary session', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/live-session/start',
      payload: { durationMinutes: 10 },
    });
    assert.equal(startRes.statusCode, 200);
    const startBody = startRes.json();
    assert.equal(startBody.liveSession.active, true);
    assert.ok(startBody.liveSession.sessionId);

    const stopRes = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/live-session/stop',
    });
    assert.equal(stopRes.statusCode, 200);
    assert.equal(stopRes.json().active, false);
  });

  await t.test('DELETE /api/v1/screen/captures/:id removes screenshot', async () => {
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/screen/captures/${captureId}`,
    });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.json().deletedId, captureId);
  });

  await app.close();
});
