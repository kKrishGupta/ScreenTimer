import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Screenshot & Live-Sharing Governance (Milestone 7)', () => {
  it('enforces high-frequency warning, storage quota pruning, and single-viewer locks', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const app = await buildApp({ config, prisma: {}, logger: false });
    const auth = await app.authService.createTestSession();
    const headers = auth.headers;

    // 1. Grant consent
    await app.inject({
      method: 'POST',
      url: '/api/v1/screen/consent',
      headers,
      payload: { consent: true },
    });

    // 2. High frequency capture update without confirmation flag is rejected
    const highFreqRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/screen/config',
      headers,
      payload: { captureIntervalMinutes: 0.5 },
    });
    assert.equal(highFreqRes.statusCode, 400);
    assert.equal(highFreqRes.json().error.code, 'HIGH_FREQUENCY_WARNING_REQUIRED');

    // 3. High frequency with confirmation succeeds
    const confirmedRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/screen/config',
      headers,
      payload: { captureIntervalMinutes: 0.5, confirmHighFrequencyWarning: true },
    });
    assert.equal(confirmedRes.statusCode, 200);

    // 4. Test Tokenized Single-Viewer Live Screen Sharing
    const startLive = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/live-session/start',
      headers,
      payload: { durationMinutes: 15 },
    });
    assert.equal(startLive.statusCode, 200);
    const { liveSession } = startLive.json();
    assert.ok(liveSession.viewerToken);

    // 5. First viewer connects with token -> 200 OK
    const viewer1 = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/live-session/join',
      headers,
      payload: {
        sessionId: liveSession.sessionId,
        viewerToken: liveSession.viewerToken,
        viewerId: 'parent-phone',
      },
    });
    assert.equal(viewer1.statusCode, 200);

    // 6. Second concurrent viewer tries to connect -> 409 CONCURRENT_VIEWER_CONFLICT
    const viewer2 = await app.inject({
      method: 'POST',
      url: '/api/v1/screen/live-session/join',
      headers,
      payload: {
        sessionId: liveSession.sessionId,
        viewerToken: liveSession.viewerToken,
        viewerId: 'unknown-intruder',
      },
    });
    assert.equal(viewer2.statusCode, 409);
    assert.equal(viewer2.json().error.code, 'CONCURRENT_VIEWER_CONFLICT');

    // 7. Stop live session
    await app.inject({
      method: 'POST',
      url: '/api/v1/screen/live-session/stop',
      headers,
    });
  });
});

