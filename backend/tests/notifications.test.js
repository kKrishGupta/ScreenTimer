import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Advanced Notifications & Alert Management (Milestone 5)', () => {
  it('creates notifications, applies cooldown deduplication, and manages read status', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const app = await buildApp({ config, prisma: {}, logger: false });
    const auth = await app.authService.createTestSession();
    const headers = auth.headers;

    // 1. Create a notification
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications',
      headers,
      payload: {
        type: 'restricted_website_warning',
        severity: 'warning',
        title: 'Restricted Domain Detected',
        message: 'A visit to tiktok.com was attempted on Living Room PC.',
        target: 'tiktok.com',
        cooldownMinutes: 5,
      },
    });
    assert.equal(res1.statusCode, 201);
    const body1 = res1.json();
    assert.equal(body1.suppressed, false);
    assert.equal(body1.notification.title, 'Restricted Domain Detected');
    const notifId = body1.notification.id;

    // 2. Immediately create duplicate with same target -> suppressed by cooldown
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications',
      headers,
      payload: {
        type: 'restricted_website_warning',
        severity: 'warning',
        title: 'Restricted Domain Detected',
        message: 'A visit to tiktok.com was attempted on Living Room PC.',
        target: 'tiktok.com',
        cooldownMinutes: 5,
      },
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json().suppressed, true);

    // 3. Check summary
    const sumRes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/summary',
      headers,
    });
    assert.equal(sumRes.statusCode, 200);
    assert.ok(sumRes.json().totalUnread >= 1);

    // 4. Mark single as read
    const markRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notifications/${notifId}/read`,
      headers,
    });
    assert.equal(markRes.statusCode, 200);
    assert.equal(markRes.json().notification.read, true);

    // 5. Delete notification
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notifications/${notifId}`,
      headers,
    });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.json().success, true);
  });
});

