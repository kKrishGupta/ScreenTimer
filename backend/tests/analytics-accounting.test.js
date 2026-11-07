import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../src/modules/analytics/analytics.service.js';

describe('analytics interval accounting and scope', () => {
  it('counts overlapping application and browser intervals once as active time', async () => {
    let query;
    const prisma = {
      activitySession: {
        findMany: async ({ where }) => {
          query = where;
          return [
            {
              type: 'APP_SESSION',
              startedAt: new Date('2026-11-02T09:00:00.000Z'),
              endedAt: new Date('2026-11-02T10:00:00.000Z'),
              durationSeconds: 3600,
              application: { executableName: 'editor.exe' },
              website: null,
            },
            {
              type: 'WEB_SESSION',
              startedAt: new Date('2026-11-02T09:30:00.000Z'),
              endedAt: new Date('2026-11-02T10:30:00.000Z'),
              durationSeconds: 3600,
              application: null,
              website: { domain: 'work.example' },
            },
          ];
        },
      },
    };
    const service = new AnalyticsService(prisma, { error() {} });
    const result = await service.getDailyAnalytics({
      organizationId: 'org-1',
      userId: 'manager-1',
      role: 'MANAGER',
      date: '2026-11-02',
    });

    assert.equal(result.totalActiveMinutes, 90);
    assert.equal(result.breakdown.neutralMinutes, 120, 'app and domain usage remain separate, overlapping measurements');
    assert.equal(query.organizationId, 'org-1');
    // The canonical role model scopes managers as organization administrators;
    // the query is therefore tenant-scoped rather than manager-report scoped.
    assert.equal(query.device, undefined);
  });
});
