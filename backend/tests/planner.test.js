import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

function createMockPrisma() {
  return {
    $connect: async () => {},
    $disconnect: async () => {},
    $queryRaw: async () => [{ '?column?': 1 }],
    activitySession: {
      findMany: async ({ where }) => [{
        startedAt: new Date(where.startedAt.lt.getTime() - 3600000),
        endedAt: where.startedAt.lt,
      }],
    },
  };
}

test('Family Planner & Digital Wellbeing API (Milestone 8)', async (t) => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5433/test',
    HOST: '127.0.0.1',
    PORT: '3001',
  });
  const app = await buildApp({ config, prisma: createMockPrisma(), logger: false });
  const auth = await app.authService.createTestSession();
  const headers = auth.headers;

  let createdTaskId;
  await t.test('POST /api/v1/planner/tasks creates a task', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/planner/tasks',
      headers,
      payload: {
        title: 'Study History Exam',
        category: 'study',
        targetMinutes: 45,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.task.title, 'Study History Exam');
    assert.equal(body.task.completed, false);
    createdTaskId = body.task.id;
  });

  await t.test('PATCH /api/v1/planner/tasks/:id toggles task completion', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/planner/tasks/${createdTaskId}`,
      headers,
      payload: { completed: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.task.completed, true);
  });

  await t.test('GET /api/v1/planner/tasks lists all tasks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/planner/tasks',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.totalCount >= 1);
    assert.ok(body.completedCount >= 1);
  });

  await t.test('GET and POST /api/v1/planner/goals manages daily screen-time limits', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/planner/goals',
      headers,
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().count, 0, 'no screen goals are invented for a new organization');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/planner/goals',
      headers,
      payload: {
        title: 'Creative Coding Goal',
        category: 'coding',
        maxMinutesPerDay: 120,
      },
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.json().goal.category, 'coding');
  });

  await t.test('POST /api/v1/planner/focus-sessions/start and stop manages focus session', async () => {
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/v1/planner/focus-sessions/start',
      headers,
      payload: {
        title: 'Math Sprint',
        durationMinutes: 20,
      },
    });
    assert.equal(startRes.statusCode, 200);
    const startBody = startRes.json();
    assert.equal(startBody.session.title, 'Math Sprint');
    assert.equal(startBody.session.status, 'active');

    const stopRes = await app.inject({
      method: 'POST',
      url: '/api/v1/planner/focus-sessions/stop',
      headers,
    });
    assert.equal(stopRes.statusCode, 200);
    assert.equal(stopRes.json().session.status, 'stopped_early');
  });

  await t.test('GET /api/v1/planner/analytics calculates planned vs actual time', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/planner/analytics',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.plannedTaskMinutes, 45);
    assert.equal(body.realActiveMinutes, 60); // 3600 seconds aggregated from mock
    assert.deepEqual(body.goalComparisons, []);
    assert.equal(body.actualProductiveMinutes, null);
  });

  await t.test('GET /api/v1/wellbeing/status returns break intervals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wellbeing/status',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.breakIntervalMinutes, 20);
    assert.ok(body.breaksCompletedToday >= 0);
  });

  await t.test('DELETE /api/v1/planner/tasks/:id deletes task', async () => {
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/planner/tasks/${createdTaskId}`,
      headers,
    });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.json().deletedId, createdTaskId);
  });

  await app.close();
});

