import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { Roles } from '../src/modules/auth/auth.service.js';

const organizationId = 'reminder-org-1';
const employeeId = 'employee-reminder-1';

function createPrisma({ employee = {}, pendingInvitation = null, notificationStorage = true } = {}) {
  const targetEmployee = {
    id: employeeId,
    organizationId,
    departmentId: 'department-a',
    managerId: 'manager-a',
    email: 'employee@example.com',
    displayName: 'Taylor Example',
    passwordHash: 'stored-password-hash',
    employmentStatus: 'active',
    role: Roles.EMPLOYEE,
    ...employee,
  };
  const notifications = [];
  const auditRows = [];
  const prisma = {
    user: {
      findFirst: async ({ where }) => {
        if (where.id !== targetEmployee.id || where.role !== targetEmployee.role) return null;
        if (where.organizationId && where.organizationId !== targetEmployee.organizationId) return null;
        return targetEmployee;
      },
    },
    invitation: {
      findFirst: async ({ where }) => {
        if (!pendingInvitation) return null;
        if (where.organizationId !== pendingInvitation.organizationId || where.email !== pendingInvitation.email) return null;
        return pendingInvitation;
      },
    },
    auditLog: {
      create: async ({ data }) => {
        auditRows.push(data);
        return data;
      },
    },
    __state: { targetEmployee, notifications, auditRows },
  };

  if (notificationStorage) {
    prisma.notification = {
      findMany: async () => notifications,
      findFirst: async ({ where }) => notifications.find((item) =>
        item.organizationId === where.organizationId &&
        item.type === where.type &&
        item.target === where.target &&
        new Date(item.createdAt) >= where.createdAt.gte,
      ) || null,
      create: async ({ data }) => {
        const notification = { id: `notification-${notifications.length + 1}`, read: false, createdAt: new Date(), ...data };
        notifications.push(notification);
        return notification;
      },
    };
  }

  return prisma;
}

async function createHarness(options = {}) {
  const prisma = createPrisma(options);
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: 'postgresql://localhost:5433/digitalpulse_test', SMTP_USER: '', SMTP_PASSWORD: '' }),
    prisma,
    logger: false,
  });
  return { app, prisma };
}

async function createSession(app, options = {}) {
  return app.authService.createTestSession({
    userId: options.userId || 'admin-a',
    email: options.email || 'admin@example.com',
      role: options.role || Roles.ADMIN,
    organizationId: options.organizationId || organizationId,
    departmentId: options.departmentId,
  });
}

async function requestReminder(app, session, id = employeeId) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/employees/${id}/setup-reminder`,
    headers: session?.headers,
    payload: {},
  });
}

describe('employee setup reminders', () => {
  it('registers the route and sends an authorized administrator reminder by email', async () => {
    const { app, prisma } = await createHarness();
    try {
      const sent = [];
      app.authService.emailService = {
        configured: true,
        sendDeviceSetupReminder: async (message) => sent.push(message),
      };
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().deliveryStatus, 'sent');
      assert.equal(response.json().emailSent, true);
      assert.equal(response.json().notificationQueued, true);
      assert.deepEqual(sent, [{ to: 'employee@example.com', setupUrl: response.json().setupUrl }]);
      assert.equal(prisma.__state.notifications.length, 1);
      assert.equal(prisma.__state.auditRows[0].action, 'EMPLOYEE_SETUP_REMINDER');
      assert.deepEqual(prisma.__state.auditRows[0].details, { employeeId, deliveryStatus: 'sent' });
      assert.equal(app.hasRoute({ method: 'POST', url: '/api/v1/employees/:employeeId/setup-reminder' }), true);
    } finally {
      await app.close();
    }
  });

  it('rejects an authenticated employee with 403', async () => {
    const { app } = await createHarness();
    try {
      const employee = await createSession(app, { userId: 'employee-self', role: Roles.EMPLOYEE });
      const response = await requestReminder(app, employee);
      assert.equal(response.statusCode, 403, response.body);
    } finally {
      await app.close();
    }
  });

  it('allows an administrator only within the selected organization scope', async () => {
    const { app, prisma } = await createHarness();
    try {
      const manager = await createSession(app, { userId: 'manager-a', role: Roles.ADMIN, departmentId: 'department-a' });
      const allowed = await requestReminder(app, manager);
      assert.equal(allowed.statusCode, 202, allowed.body);
      assert.equal(allowed.json().deliveryStatus, 'queued');

      const otherManager = await createSession(app, { userId: 'manager-b', role: Roles.ADMIN, organizationId: 'other-org', departmentId: 'department-b' });
      const denied = await requestReminder(app, otherManager);
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(prisma.__state.notifications.length, 1);
    } finally {
      await app.close();
    }
  });

  it('does not expose or target an employee in another organization', async () => {
    const { app } = await createHarness({ employee: { organizationId: 'other-org' } });
    try {
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);
      assert.equal(response.statusCode, 404, response.body);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unknown employee', async () => {
    const { app } = await createHarness();
    try {
      const admin = await createSession(app);
      const response = await requestReminder(app, admin, 'unknown-employee');
      assert.equal(response.statusCode, 404, response.body);
    } finally {
      await app.close();
    }
  });

  it('does not send reminders to inactive or not-yet-activated accounts', async () => {
    const { app, prisma } = await createHarness({ employee: { employmentStatus: 'disabled' } });
    try {
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'EMPLOYEE_NOT_ACTIVE');
      assert.equal(prisma.__state.notifications.length, 0);
    } finally {
      await app.close();
    }
  });

  it('directs pending invitation accounts back to invitation management', async () => {
    const { app, prisma } = await createHarness({
      pendingInvitation: { id: 'inv-pending', organizationId, email: 'employee@example.com' },
    });
    try {
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'INVITATION_PENDING');
      assert.equal(prisma.__state.notifications.length, 0);
    } finally {
      await app.close();
    }
  });

  it('queues an in-app reminder honestly when email is not configured', async () => {
    const { app, prisma } = await createHarness();
    try {
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().success, true);
      assert.equal(response.json().emailSent, false);
      assert.equal(response.json().deliveryStatus, 'queued');
      assert.equal(response.json().notificationQueued, true);
      assert.equal(prisma.__state.notifications.length, 1);
    } finally {
      await app.close();
    }
  });

  it('queues an in-app reminder when configured email delivery fails', async () => {
    const { app, prisma } = await createHarness();
    try {
      app.authService.emailService = {
        configured: true,
        sendDeviceSetupReminder: async () => { throw Object.assign(new Error('SMTP failure'), { code: 'EMAIL_DELIVERY_FAILED' }); },
      };
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().emailSent, false);
      assert.equal(response.json().deliveryStatus, 'queued');
      assert.match(response.json().message, /Email delivery failed/);
      assert.equal(prisma.__state.notifications.length, 1);
    } finally {
      await app.close();
    }
  });

  it('returns unavailable when neither email nor persistent notifications can deliver a reminder', async () => {
    const { app } = await createHarness({ notificationStorage: false });
    try {
      const admin = await createSession(app);
      const response = await requestReminder(app, admin);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().error.code, 'REMINDER_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });

  it('does not repeat email or notification creation during the cooldown window', async () => {
    const { app, prisma } = await createHarness();
    try {
      let emailCount = 0;
      app.authService.emailService = { configured: true, sendDeviceSetupReminder: async () => { emailCount += 1; } };
      const admin = await createSession(app);
      const first = await requestReminder(app, admin);
      const second = await requestReminder(app, admin);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().deliveryStatus, 'already_queued');
      assert.equal(emailCount, 1);
      assert.equal(prisma.__state.notifications.length, 1);
    } finally {
      await app.close();
    }
  });
});
