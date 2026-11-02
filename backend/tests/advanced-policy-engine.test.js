import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('Advanced Family Policy Engine (Milestone 4)', () => {
  it('evaluates restricted domains and applications with precedence and temporary bypass', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:5433/dp' });
    const app = await buildApp({ config, prisma: {}, logger: false });

    // 1. Create a member-scoped restricted application policy
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/policies',
      payload: {
        name: 'Teen Gaming Block',
        category: 'gaming',
        restrictedApps: ['minecraft.exe', 'steam.exe'],
        restrictedDomains: ['steampowered.com'],
        action: 'block',
        memberId: 'user-teen-123',
      },
    });
    assert.equal(createRes.statusCode, 200);
    const { policy } = createRes.json();
    assert.equal(policy.name, 'Teen Gaming Block');

    // 2. Check restricted application for target member -> BLOCKED
    const checkBlocked = await app.inject({
      method: 'POST',
      url: '/api/v1/policies/check',
      payload: { applicationName: 'minecraft.exe', memberId: 'user-teen-123' },
    });
    assert.equal(checkBlocked.statusCode, 200);
    const checkBlockedData = checkBlocked.json();
    assert.equal(checkBlockedData.restricted, true);
    assert.equal(checkBlockedData.action, 'block');

    // 3. Parent grants 30-minute temporary approval
    const tempRes = await app.inject({
      method: 'POST',
      url: '/api/v1/policies/temporary-approvals',
      payload: { target: 'minecraft.exe', durationMinutes: 30, approvedBy: 'Mom' },
    });
    assert.equal(tempRes.statusCode, 200);
    assert.equal(tempRes.json().success, true);

    // 4. Re-check now allows access under temporary approval
    const checkAllowed = await app.inject({
      method: 'POST',
      url: '/api/v1/policies/check',
      payload: { applicationName: 'minecraft.exe', memberId: 'user-teen-123' },
    });
    assert.equal(checkAllowed.statusCode, 200);
    const checkAllowedData = checkAllowed.json();
    assert.equal(checkAllowedData.restricted, false);
    assert.equal(checkAllowedData.temporaryApprovalActive, true);

    // 5. Exports declarativeNetRequest dynamic rules for Chrome/Edge extension
    const rulesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/policies/declarative-rules',
    });
    assert.equal(rulesRes.statusCode, 200);
    const rulesData = rulesRes.json();
    assert.ok(Array.isArray(rulesData.rules));
    assert.ok(rulesData.rules.some((r) => r.condition.urlFilter.includes('steampowered.com')));
  });
});
