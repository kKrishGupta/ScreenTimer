import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Advanced Digital Wellbeing & Analytics (Milestone 6)', () => {
  it('computes daily and weekly trends, customizes categories, and exports CSV', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const app = await buildApp({ config, prisma: {}, logger: false });

    // 1. Daily analytics endpoint
    const dailyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/daily',
    });
    assert.equal(dailyRes.statusCode, 200);
    const daily = dailyRes.json();
    assert.ok(daily.date);
    assert.ok(typeof daily.productivityScore === 'number');
    assert.ok(daily.breakdown);

    // 2. Weekly analytics endpoint
    const weeklyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/weekly',
    });
    assert.equal(weeklyRes.statusCode, 200);
    const weekly = weeklyRes.json();
    assert.equal(weekly.days.length, 7);
    assert.ok(weekly.summary);

    // 3. Customize category
    const catRes = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/categories',
      payload: { target: 'discord.com', category: 'distracting' },
    });
    assert.equal(catRes.statusCode, 200);
    assert.equal(catRes.json().category, 'distracting');

    // 4. Recommendations
    const recRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/recommendations',
    });
    assert.equal(recRes.statusCode, 200);
    assert.ok(recRes.json().recommendations.length > 0);

    // 5. CSV export
    const csvRes = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/export/csv',
    });
    assert.equal(csvRes.statusCode, 200);
    assert.equal(csvRes.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(csvRes.payload, /Timestamp,Type,Target/);
  });
});
