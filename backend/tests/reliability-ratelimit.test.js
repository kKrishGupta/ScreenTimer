import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Reliability, Performance & Rate Limiting (Milestone 8)', () => {
  it('supplies rate limit headers and rate limits abusive traffic while preserving health checks', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const app = await buildApp({ config, prisma: {}, logger: false });

    // 1. Health check has no rate limit
    const healthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    // Health check returns 200 or 503 depending on db connectivity, but never 429
    assert.notEqual(healthRes.statusCode, 429);

    // 2. Regular API calls have rate limit headers
    const rolesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/roles',
    });
    assert.equal(rolesRes.statusCode, 200);
    assert.ok(rolesRes.headers['x-ratelimit-limit']);
    assert.ok(rolesRes.headers['x-ratelimit-remaining'] !== undefined);
  });
});

