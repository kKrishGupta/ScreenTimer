// PostgreSQL integration checks must target an isolated TEST_DATABASE_URL.
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig, resolveDatabaseUrl } from '../src/shared/config.js';
import { createPrismaClient, probeDatabase } from '../src/database/prisma.js';

let skipReason = false;

if (!process.env.TEST_DATABASE_URL) {
  skipReason = 'TEST_DATABASE_URL not set (configure an isolated PostgreSQL test database)';
} else if (process.env.RUN_INTEGRATION_TESTS !== 'true') {
  skipReason = 'Integration tests disabled by default; set RUN_INTEGRATION_TESTS=true to use TEST_DATABASE_URL';
}

function assertTestDatabaseIsIsolated() {
  const applicationDatabaseUrl = resolveDatabaseUrl(process.env);
  if (!process.env.TEST_DATABASE_URL || !applicationDatabaseUrl) return;
  const target = (value) => {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}${decodeURIComponent(url.pathname).replace(/\/+$/, '')}`;
  };
  assert.notEqual(
    target(process.env.TEST_DATABASE_URL),
    target(applicationDatabaseUrl),
    'TEST_DATABASE_URL must point to a dedicated database, not the application database',
  );
}

test('health endpoint reaches the real PostgreSQL database', { skip: skipReason }, async (t) => {
  assertTestDatabaseIsIsolated();
  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, LOG_LEVEL: 'silent' });
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
  assertTestDatabaseIsIsolated();
  const prisma = createPrismaClient(loadConfig({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }));
  t.after(() => prisma.$disconnect());

  const org = await prisma.organization.findUnique({
    where: { slug: process.env.DEV_ORG_SLUG ?? 'local-dev' },
  });
  assert.ok(org, 'run `npm run db:seed` to create the local development organization');
  assert.equal(typeof (await prisma.activitySession.count()), 'number');
  assert.equal(typeof (await prisma.activityEvent.count()), 'number');
});
