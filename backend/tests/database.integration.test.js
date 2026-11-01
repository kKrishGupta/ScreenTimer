// Database integration test: requires the local PostgreSQL configured in backend/.env.
// Skips gracefully when the database credentials are not yet initialized,
// reporting the exact reason instead of failing unit tests.
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { createPrismaClient, probeDatabase } from '../src/database/prisma.js';

let skipReason = false;

if (!process.env.DATABASE_URL) {
  skipReason = 'DATABASE_URL not set (configure backend/.env)';
} else if (process.env.RUN_INTEGRATION_TESTS !== 'true') {
  skipReason = 'Integration tests disabled by default; set RUN_INTEGRATION_TESTS=true after running scripts/setup-database.ps1';
}

test('health endpoint reaches the real PostgreSQL database', { skip: skipReason }, async (t) => {
  const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
  const prisma = createPrismaClient(config);
  const app = await buildApp({ config, prisma, logger: false });
  t.after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().database.status, 'up');
});

test('migrations are applied and the dev organization is seeded', { skip: skipReason }, async (t) => {
  const prisma = createPrismaClient(loadConfig(process.env));
  t.after(() => prisma.$disconnect());

  const org = await prisma.organization.findUnique({
    where: { slug: process.env.DEV_ORG_SLUG ?? 'local-dev' },
  });
  assert.ok(org, 'run `npm run db:seed` to create the local development organization');
  assert.equal(typeof (await prisma.activitySession.count()), 'number');
  assert.equal(typeof (await prisma.activityEvent.count()), 'number');
});
