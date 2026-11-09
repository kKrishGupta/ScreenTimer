import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';

describe('employee wellbeing authorization', () => {
  it('restricts organization discovery and enforces tenant-scoped employee access', async () => {
    const orgA = '11111111-1111-4111-8111-111111111111';
    const orgB = '22222222-2222-4222-8222-222222222222';

    const employees = [
      {
        id: 'alice',
        organizationId: orgA,
        role: 'EMPLOYEE',
        displayName: 'Alice',
        email: 'alice@example.test',
        employmentStatus: 'active',
        monitoringAuthorized: true,
        createdAt: new Date(),
        devices: [],
      },
      {
        id: 'bob',
        organizationId: orgB,
        role: 'EMPLOYEE',
        displayName: 'Bob',
        email: 'bob@example.test',
        employmentStatus: 'active',
        monitoringAuthorized: true,
        createdAt: new Date(),
        devices: [],
      },
    ];

    let organizationQueries = 0;

    const prisma = {
      organization: {
        findMany: async () => {
          organizationQueries += 1;
          return [
            { id: orgA, name: 'Organization A' },
            { id: orgB, name: 'Organization B' },
          ];
        },
      },
      user: {
        findMany: async ({ where }) =>
          employees.filter((employee) =>
            employee.role === where.role &&
            employee.organizationId === where.organizationId
          ),
      },
    };

    const app = await buildApp({
      config: loadConfig({
        DATABASE_URL: 'postgresql://x:y@localhost:5433/dp',
      }),
      prisma,
      logger: false,
    });

    try {
      const admin = await app.authService.createTestSession({
        role: 'ORGANIZATION_ADMIN',
        organizationId: orgA,
      });

      const superAdmin = await app.authService.createTestSession({
        role: 'SUPER_ADMIN',
        organizationId: orgA,
      });

      const adminOrganizations = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: admin.headers,
      });
      assert.equal(adminOrganizations.statusCode, 403);
      assert.equal(organizationQueries, 0);

      const superOrganizations = await app.inject({
        method: 'GET',
        url: '/api/v1/organizations',
        headers: superAdmin.headers,
      });
      assert.equal(superOrganizations.statusCode, 200, superOrganizations.body);
      assert.deepEqual(
        superOrganizations.json().organizations.map((item) => item.id),
        [orgA, orgB]
      );

      const adminCrossTenant = await app.inject({
        method: 'GET',
        url: `/api/v1/employees?organizationId=${orgB}`,
        headers: admin.headers,
      });
      assert.equal(adminCrossTenant.statusCode, 403);

      const adminEmployees = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: admin.headers,
      });
      assert.equal(adminEmployees.statusCode, 200, adminEmployees.body);
      assert.deepEqual(
        adminEmployees.json().employees.map((item) => item.id),
        ['alice']
      );

      const missingScope = await app.inject({
        method: 'GET',
        url: '/api/v1/employees',
        headers: superAdmin.headers,
      });
      assert.equal(missingScope.statusCode, 400);

      const selectedEmployees = await app.inject({
        method: 'GET',
        url: `/api/v1/employees?organizationId=${orgB}`,
        headers: superAdmin.headers,
      });
      assert.equal(selectedEmployees.statusCode, 200, selectedEmployees.body);
      assert.deepEqual(
        selectedEmployees.json().employees.map((item) => item.id),
        ['bob']
      );

      const adminOtherEmployee = await app.inject({
        method: 'GET',
        url: '/api/v1/employees/bob',
        headers: admin.headers,
      });
      assert.equal(adminOtherEmployee.statusCode, 404);

      const superOtherOrganization = await app.inject({
        method: 'GET',
        url: `/api/v1/employees/alice?organizationId=${orgB}`,
        headers: superAdmin.headers,
      });
      assert.equal(superOtherOrganization.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});