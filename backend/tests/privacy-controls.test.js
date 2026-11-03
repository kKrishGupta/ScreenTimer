import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Security Hardening & Privacy Controls (Milestone 9)', () => {
  it('serves privacy disclosure charter and enforces confirmed deletion workflow', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const app = await buildApp({ config, prisma: {}, logger: false });
    const auth = await app.authService.createTestSession();
    const headers = auth.headers;

    // 1. Privacy overview
    const overviewRes = await app.inject({
      method: 'GET',
      url: '/api/v1/privacy/overview',
    });
    assert.equal(overviewRes.statusCode, 200);
    const overview = overviewRes.json();
    assert.ok(overview.dataMinimizationGuarantees.length >= 5);
    assert.ok(overview.activePermissions.length >= 4);

    // 2. Deletion without confirmation flag is rejected
    const unconfirmedDel = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers,
      payload: {},
    });
    assert.equal(unconfirmedDel.statusCode, 400);

    // 3. Confirmed deletion succeeds
    const confirmedDel = await app.inject({
      method: 'POST',
      url: '/api/v1/privacy/delete-data',
      headers,
      payload: { confirmDelete: true },
    });
    assert.equal(confirmedDel.statusCode, 200);
    assert.equal(confirmedDel.json().success, true);
  });
});

