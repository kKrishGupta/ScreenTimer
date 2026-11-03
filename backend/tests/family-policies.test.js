import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

function createMockPrisma() {
  return {
    $connect: async () => {},
    $disconnect: async () => {},
    $queryRaw: async () => [{ '?column?': 1 }],
    device: {
      findMany: async () => [
        { id: 'dev-1', name: 'Child Laptop', kind: 'desktop_agent' },
      ],
    },
  };
}

test('Family Management & Policy Engine API (Milestone 9)', async (t) => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5433/test',
    HOST: '127.0.0.1',
    PORT: '3001',
  });
  const app = await buildApp({ config, prisma: createMockPrisma(), logger: false });
  const auth = await app.authService.createTestSession();
  const headers = auth.headers;

  let createdMemberId;
  await t.test('refuses fake family member creation when employee storage is unavailable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/family/members',
      headers,
      payload: {
        displayName: 'Taylor (Teen)',
        email: 'taylor@family.local',
        role: 'member',
        ageBracket: 'teen',
        consentGranted: true,
      },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'INVITATION_FAILED');
  });

  await t.test('device assignment reports unavailable employee storage', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/family/members/${createdMemberId}/devices`,
      headers,
      payload: { deviceId: 'dev-1' },
    });
    assert.equal(res.statusCode, 503);
  });

  await t.test('GET /api/v1/family/members does not return fake people', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/family/members',
      headers,
    });
    assert.equal(res.statusCode, 503);
  });

  let createdPolicyId;
  await t.test('POST /api/v1/policies creates restricted domain policy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/policies',
      headers,
      payload: {
        name: 'Video Streaming Restrictions',
        category: 'streaming',
        restrictedDomains: ['netflix.com', 'youtube.com'],
        maxMinutesPerDay: 45,
        action: 'warn',
        active: true,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.policy.name, 'Video Streaming Restrictions');
    createdPolicyId = body.policy.id;
  });

  await t.test('POST /api/v1/policies/check triggers soft warning and logs violation', async () => {
    // 1. Safe domain (no violation)
    const safeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/policies/check',
      headers,
      payload: { domain: 'wikipedia.org' },
    });
    assert.equal(safeRes.statusCode, 200);
    assert.equal(safeRes.json().restricted, false);

    // 2. Restricted domain (triggers soft warning & violation event)
    const restrictedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/policies/check',
      headers,
      payload: { domain: 'youtube.com' },
    });
    assert.equal(restrictedRes.statusCode, 200);
    const body = restrictedRes.json();
    assert.equal(body.restricted, true);
    assert.equal(body.action, 'warn');
    assert.ok(body.violation);
    assert.equal(body.violation.target, 'youtube.com');
  });

  await t.test('GET /api/v1/policies/violations lists recorded policy violations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/policies/violations',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.totalCount >= 1);
    const youtubeViolation = body.violations.find((v) => v.target === 'youtube.com');
    assert.ok(youtubeViolation);
    assert.equal(youtubeViolation.acknowledged, false);

    // Acknowledge violation
    const ackRes = await app.inject({
      method: 'POST',
      url: `/api/v1/policies/violations/${youtubeViolation.id}/acknowledge`,
      headers,
    });
    assert.equal(ackRes.statusCode, 200);
    assert.equal(ackRes.json().violation.acknowledged, true);
  });

  await t.test('GET /api/v1/alerts returns consolidated alert feed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts',
      headers,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.count >= 1);
    assert.ok(body.alerts.some((a) => a.type === 'system_notice'));
  });

  await t.test('deactivation reports unavailable employee storage and policy cleanup still works', async () => {
    const delMember = await app.inject({
      method: 'DELETE',
      url: `/api/v1/family/members/${createdMemberId}`,
      headers,
    });
    assert.equal(delMember.statusCode, 503);

    const delPolicy = await app.inject({
      method: 'DELETE',
      url: `/api/v1/policies/${createdPolicyId}`,
      headers,
    });
    assert.equal(delPolicy.statusCode, 200);
  });

  await app.close();
});

