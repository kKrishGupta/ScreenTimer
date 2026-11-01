// Unit tests for the HTTP layer using a fake Prisma client (no database required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db', LOG_LEVEL: 'silent' });

const fakePrisma = (healthy) => ({
  $queryRaw: async () => {
    if (!healthy) throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
    return [{ '?column?': 1 }];
  },
});

test('GET /api/v1/health returns ok when the database is reachable', async (t) => {
  const app = await buildApp({ config, prisma: fakePrisma(true), logger: false });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.database.status, 'up');
  assert.equal(body.service, 'digitalpulse-backend');
  assert.ok(!Number.isNaN(Date.parse(body.time)));
  assert.ok(body.time.endsWith('Z'), 'timestamps are UTC');
});

test('GET /api/v1/health returns 503 degraded when the database is down', async (t) => {
  const app = await buildApp({ config, prisma: fakePrisma(false), logger: false });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.database.status, 'down');
  assert.match(body.database.error, /ECONNREFUSED/);
});

test('unknown routes return the uniform error envelope', async (t) => {
  const app = await buildApp({ config, prisma: fakePrisma(true), logger: false });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
  assert.ok(body.error.requestId);
});

test('security headers are applied and CORS allows only the dashboard origin', async (t) => {
  const app = await buildApp({ config, prisma: fakePrisma(true), logger: false });
  t.after(() => app.close());

  const allowed = await app.inject({
    method: 'GET',
    url: '/api/v1/health',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(allowed.headers['x-content-type-options'], 'nosniff');

  const denied = await app.inject({
    method: 'GET',
    url: '/api/v1/health',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

