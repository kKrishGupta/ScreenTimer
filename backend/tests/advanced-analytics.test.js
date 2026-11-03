import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Advanced Digital Wellbeing & Analytics (Milestone 6)', () => {
  it('computes daily and weekly trends, customizes categories, and exports CSV', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const scopedQueries = [];
    const prisma = {
      activitySession: { findMany: async ({ where }) => { scopedQueries.push(where); return []; } },
      usageCategory: {
        upsert: async ({ create }) => create,
        findUnique: async () => null,
      },
    };
    const app = await buildApp({ config, prisma, logger: false });
    const auth = await app.authService.createTestSession();
    const headers = auth.headers;

    // 1. Daily analytics endpoint
    const dailyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/daily',
      headers,
    });
    assert.equal(dailyRes.statusCode, 200);
    const daily = dailyRes.json();
    assert.ok(daily.date);
    assert.equal(daily.productivityScore, null, 'empty data must not produce a synthetic score');
    assert.ok(daily.breakdown);
    assert.equal(scopedQueries[0].organizationId, auth.session.user.organizationId);

    // 2. Weekly analytics endpoint
    const weeklyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/weekly',
      headers,
    });
    assert.equal(weeklyRes.statusCode, 200);
    const weekly = weeklyRes.json();
    assert.equal(weekly.days.length, 7);
    assert.ok(weekly.summary);

    // 3. Customize category
    const catRes = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/categories',
      headers,
      payload: { target: 'discord.com', category: 'distracting' },
    });
    assert.equal(catRes.statusCode, 200);
    assert.equal(catRes.json().category, 'distracting');

    // 4. Recommendations
    const recRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/recommendations',
      headers,
    });
    assert.equal(recRes.statusCode, 200);
    assert.deepEqual(recRes.json().recommendations, []);

    // 5. CSV export
    const csvRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/export/csv',
      headers,
    });
    assert.equal(csvRes.statusCode, 200);
    assert.equal(csvRes.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(csvRes.payload, /Timestamp,Type,Target/);
    assert.doesNotMatch(csvRes.payload, /code\.exe|github\.com/);
  });
});

