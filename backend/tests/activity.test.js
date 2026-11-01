import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  LOG_LEVEL: 'silent',
});

function createMockPrisma() {
  const events = new Map();
  const devices = new Map();
  const apps = new Map();
  const websites = new Map();
  const sessions = [];

  const org = { id: '00000000-0000-0000-0000-000000000001', slug: 'local-dev' };

  return {
    organization: {
      findUnique: async () => org,
    },
    device: {
      upsert: async ({ where, create, update }) => {
        const id = where.id;
        const current = devices.get(id) || create;
        const merged = { ...current, ...update };
        devices.set(id, merged);
        return merged;
      },
      findMany: async () => Array.from(devices.values()),
    },
    application: {
      upsert: async ({ where, create }) => {
        const key = where.organizationId_executableName.executableName;
        if (!apps.has(key)) {
          apps.set(key, { id: `app-${key}`, ...create });
        }
        return apps.get(key);
      },
    },
    website: {
      upsert: async ({ where, create }) => {
        const key = where.organizationId_domain.domain;
        if (!websites.has(key)) {
          websites.set(key, { id: `web-${key}`, ...create });
        }
        return websites.get(key);
      },
    },
    activityEvent: {
      findUnique: async ({ where }) => {
        const key = `${where.deviceId_eventId.deviceId}:${where.deviceId_eventId.eventId}`;
        return events.get(key) || null;
      },
      create: async ({ data }) => {
        const key = `${data.deviceId}:${data.eventId}`;
        const record = { id: `event-${key}`, ...data };
        events.set(key, record);
        return record;
      },
    },
    activitySession: {
      create: async ({ data }) => {
        const record = {
          id: `session-${sessions.length + 1}`,
          ...data,
          application: data.applicationId ? { displayName: 'Code', executableName: 'code.exe' } : null,
          website: data.websiteId ? { domain: 'github.com' } : null,
          device: { name: 'DevPC', kind: 'DESKTOP_AGENT' },
        };
        sessions.push(record);
        return record;
      },
      findMany: async () => sessions,
      count: async () => sessions.length,
    },
    $transaction: async (fn) => fn(createMockPrisma()),
  };
}

test('POST /api/v1/activity/events/batch accepts valid batch and deduplicates replayed events', async (t) => {
  const mockPrisma = createMockPrisma();
  // Wire transaction callback to use itself
  mockPrisma.$transaction = async (fn) => fn(mockPrisma);

  const app = await buildApp({ config, prisma: mockPrisma, logger: false });
  t.after(() => app.close());

  const event1 = {
    schemaVersion: 1,
    eventId: '6f1c1a52-6b1e-4f7e-9a39-2a8f0f6f2b11',
    deviceId: '0b7d3b0e-2a52-4d8c-8f3e-6a3f8f3d9c21',
    source: 'desktop_agent',
    type: 'app_session',
    startedAt: '2026-11-01T10:00:00.000Z',
    endedAt: '2026-11-01T10:05:30.000Z',
    durationSeconds: 330,
    app: {
      name: 'Visual Studio Code',
      executable: 'Code.exe',
      processId: 4242,
    },
  };

  const batchPayload = {
    device: {
      id: event1.deviceId,
      kind: 'desktop_agent',
      name: 'WIN11-DEV',
      platform: 'windows',
      agentVersion: '0.1.0',
    },
    events: [event1],
  };

  // First ingestion
  const res1 = await app.inject({
    method: 'POST',
    url: '/api/v1/activity/events/batch',
    payload: batchPayload,
  });

  assert.equal(res1.statusCode, 200);
  const body1 = res1.json();
  assert.equal(body1.accepted, 1);
  assert.equal(body1.deduplicated, 0);

  // Replaying identical batch must be deduplicated
  const res2 = await app.inject({
    method: 'POST',
    url: '/api/v1/activity/events/batch',
    payload: batchPayload,
  });

  assert.equal(res2.statusCode, 200);
  const body2 = res2.json();
  assert.equal(body2.accepted, 0);
  assert.equal(body2.deduplicated, 1);
});

test('POST /api/v1/activity/events/batch rejects schema-violating payload', async (t) => {
  const mockPrisma = createMockPrisma();
  const app = await buildApp({ config, prisma: mockPrisma, logger: false });
  t.after(() => app.close());

  // Empty events array violates minItems: 1
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/activity/events/batch',
    payload: {
      device: {
        id: '0b7d3b0e-2a52-4d8c-8f3e-6a3f8f3d9c21',
        kind: 'desktop_agent',
        name: 'WIN11',
        platform: 'windows',
      },
      events: [],
    },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});

test('GET /api/v1/activity/timeline, /apps, /websites, and /devices return structured data', async (t) => {
  const mockPrisma = createMockPrisma();
  mockPrisma.$transaction = async (fn) => fn(mockPrisma);

  const app = await buildApp({ config, prisma: mockPrisma, logger: false });
  t.after(() => app.close());

  // Ingest sample event
  await app.inject({
    method: 'POST',
    url: '/api/v1/activity/events/batch',
    payload: {
      device: {
        id: '0b7d3b0e-2a52-4d8c-8f3e-6a3f8f3d9c21',
        kind: 'desktop_agent',
        name: 'DEV-PC',
        platform: 'windows',
      },
      events: [
        {
          schemaVersion: 1,
          eventId: '11111111-2222-3333-4444-555555555555',
          deviceId: '0b7d3b0e-2a52-4d8c-8f3e-6a3f8f3d9c21',
          source: 'desktop_agent',
          type: 'app_session',
          startedAt: '2026-11-01T10:00:00.000Z',
          endedAt: '2026-11-01T10:01:00.000Z',
          durationSeconds: 60,
          app: {
            name: 'Code',
            executable: 'code.exe',
            processId: 100,
          },
        },
      ],
    },
  });

  const timelineRes = await app.inject({ method: 'GET', url: '/api/v1/activity/timeline' });
  if (timelineRes.statusCode !== 200) console.error('TIMELINE ERROR:', timelineRes.body);
  assert.equal(timelineRes.statusCode, 200);
  const timeline = timelineRes.json();
  assert.equal(timeline.total, 1);
  assert.equal(timeline.sessions[0].application.executable, 'code.exe');

  const appsRes = await app.inject({ method: 'GET', url: '/api/v1/activity/apps' });
  assert.equal(appsRes.statusCode, 200);
  assert.equal(appsRes.json().applications.length, 1);

  const webRes = await app.inject({ method: 'GET', url: '/api/v1/activity/websites' });
  assert.equal(webRes.statusCode, 200);

  const devRes = await app.inject({ method: 'GET', url: '/api/v1/devices' });
  assert.equal(devRes.statusCode, 200);
  assert.equal(devRes.json().devices.length, 1);
});
