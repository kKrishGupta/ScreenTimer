import { Roles, normalizeRole } from '../auth/auth.service.js';
import { AppError } from '../../shared/errors.js';

export default async function employeeRoutes(fastify) {
  const { prisma } = fastify;

  // Convert Prisma User to Employee shape
  function userToEmployee(u, devices = []) {
    const assigned = devices
      .filter((d) => d.userId === u.id || (u.assignedDeviceIds && u.assignedDeviceIds.includes(d.id)))
      .sort((a, b) => new Date(b.lastSeenAt || b.createdAt || 0) - new Date(a.lastSeenAt || a.createdAt || 0));
    const activeDevices = assigned.filter((d) => !d.isRevoked);
    const hasOnlineDevice = activeDevices.some((d) => {
      if (!d.lastSeenAt) return false;
      const ageMs = Date.now() - new Date(d.lastSeenAt).getTime();
      return ageMs >= 0 && ageMs < 5 * 60 * 1000;
    });
    // Device records contain authentication hashes. Employee APIs must expose
    // operational metadata only, never credential material.
    const visibleDevices = assigned.map((d) => ({
      id: d.id,
      userId: d.userId || null,
      kind: d.kind,
      name: d.name,
      platform: d.platform,
      browser: d.browser || null,
      agentVersion: d.agentVersion || null,
      isRevoked: Boolean(d.isRevoked),
      lastSeenAt: d.lastSeenAt || null,
      lastSyncAt: d.lastSyncAt || null,
      status: d.isRevoked ? 'revoked' : d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 5 * 60 * 1000 ? 'online' : 'offline',
    }));

    const nameParts = (u.displayName || '').split(' ');
    const firstName = u.firstName || nameParts[0] || 'Employee';
    const lastName = u.lastName || nameParts.slice(1).join(' ') || '';

    return {
      id: u.id,
      employeeId: u.employeeNumber || u.employeeId || `EMP-${u.id.slice(0, 4)}`,
      firstName,
      lastName,
      displayName: u.displayName || `${firstName} ${lastName}`.trim(),
      companyEmail: u.email || u.companyEmail,
      email: u.email || u.companyEmail,
      department: u.department?.name || u.department || null,
      departmentId: u.departmentId || null,
      designation: u.designation || null,
      managerId: u.managerId || null,
      workLocation: u.workLocation || null,
      shiftStart: u.shiftStart || null,
      shiftEnd: u.shiftEnd || null,
      shiftTimezone: u.shiftTimezone || null,
      workingDays: Array.isArray(u.workingDays) ? u.workingDays : [],
      joiningDate: u.createdAt ? (u.createdAt.toISOString ? u.createdAt.toISOString().split('T')[0] : String(u.createdAt).split('T')[0]) : null,
      employmentStatus: u.employmentStatus || 'unknown',
      monitoringAuthorized: typeof u.monitoringAuthorized === 'boolean' ? u.monitoringAuthorized : false,
      monitoringConsentGranted: Boolean(u.monitoringConsentAt && (!u.monitoringConsentRevokedAt || u.monitoringConsentRevokedAt < u.monitoringConsentAt)),
      monitoringConsentAt: u.monitoringConsentAt || null,
      assignedDeviceIds: visibleDevices.map((d) => d.id),
      devices: visibleDevices,
      deviceCount: visibleDevices.length,
      currentAgentStatus: activeDevices.length === 0 ? assigned.length === 0 ? 'NOT_ENROLLED' : 'REVOKED' : hasOnlineDevice ? 'ONLINE' : 'OFFLINE',
      connectionStatus: activeDevices.length === 0 ? assigned.length === 0 ? 'PENDING_ENROLLMENT' : 'REVOKED' : hasOnlineDevice ? 'ONLINE' : 'OFFLINE',
      accountStatus: u.employmentStatus === 'disabled' || u.employmentStatus === 'terminated'
        ? 'DISABLED'
        : u.passwordHash
          ? 'ACTIVE'
          : 'PENDING_ACTIVATION',
      lastActiveTime: visibleDevices[0]?.lastSeenAt || null,
      lastHeartbeatAt: visibleDevices.find((d) => d.lastSeenAt)?.lastSeenAt || null,
      lastSyncAt: visibleDevices.find((d) => d.lastSyncAt)?.lastSyncAt || null,
      organizationId: u.organizationId,
      role: u.role,
      createdAt: u.createdAt ? (u.createdAt.toISOString ? u.createdAt.toISOString() : u.createdAt) : new Date().toISOString(),
    };
  }

  function unionSeconds(sessions, types, start, end) {
    const intervals = sessions.filter((s) => types.includes(s.type)).map((s) => [
      Math.max(start.getTime(), new Date(s.startedAt).getTime()),
      Math.min(end.getTime(), new Date(s.endedAt).getTime()),
    ]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let current = null;
    for (const interval of intervals) {
      if (!current || interval[0] > current[1]) {
        if (current) total += current[1] - current[0];
        current = [...interval];
      } else current[1] = Math.max(current[1], interval[1]);
    }
    if (current) total += current[1] - current[0];
    return Math.round(total / 1000);
  }

  async function fetchEmployees(organizationId) {
    if (!prisma?.user?.findMany) {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Employee data storage is unavailable');
    }
    try {
      const where = { role: Roles.EMPLOYEE };
      if (organizationId) where.organizationId = organizationId;
      const users = await prisma.user.findMany({ where, include: { department: true, devices: true } });
      return users.map((u) => userToEmployee(u, u.devices || []));
    } catch {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Employee data could not be loaded from the database');
    }
  }

  async function recordSetupReminderAudit({ organizationId, actorId, employeeId, deliveryStatus }) {
    const details = { employeeId, deliveryStatus };
    if (prisma?.auditLog?.create) {
      try {
        await prisma.auditLog.create({
          data: {
            organizationId,
            action: 'EMPLOYEE_SETUP_REMINDER',
            actor: actorId,
            details,
            timestamp: new Date(),
          },
        });
      } catch (error) {
        fastify.log.warn({ err: error, organizationId, employeeId }, 'Could not persist employee setup reminder audit record');
      }
    }
    fastify.log.info({ action: 'EMPLOYEE_SETUP_REMINDER', organizationId, actorId, employeeId, deliveryStatus }, 'Employee setup reminder processed');
  }

  // GET /api/v1/employees/live (Real-time employee monitoring feed)
  fastify.get('/employees/live', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const orgId = user.role === Roles.SUPER_ADMIN && req.query?.organizationId
      ? req.query.organizationId
      : user.organizationId;
    if (user.role !== Roles.SUPER_ADMIN && !orgId) {
      return reply.status(403).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'An organization scope is required to view employee activity' } });
    }

    let list = await fetchEmployees(orgId);
    const userRole = normalizeRole(user.role);

    if (userRole === Roles.EMPLOYEE) {
      list = list.filter(
        (e) =>
          e.id === user.id ||
          (e.companyEmail && user.email && e.companyEmail.toLowerCase() === user.email.toLowerCase()) ||
          (e.email && user.email && e.email.toLowerCase() === user.email.toLowerCase()),
      );
    } else if (userRole === Roles.MANAGER) {
      list = list.filter(
        (e) =>
          e.id === user.id ||
          (e.companyEmail && user.email && e.companyEmail.toLowerCase() === user.email.toLowerCase()) ||
          e.managerId === user.id ||
          (user.departmentId && e.departmentId === user.departmentId) ||
          (user.department && e.department && e.department.toLowerCase() === user.department.toLowerCase()),
      );
    }

    list = list.filter((employee) => String(employee.employmentStatus || '').toLowerCase() === 'active');
    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const activityByEmployee = new Map();
    const monitoredEmployeeIds = list.filter((employee) => employee.monitoringAuthorized === true).map((employee) => employee.id);
    if (monitoredEmployeeIds.length > 0) {
      if (!prisma?.activitySession?.findMany) {
        return reply.status(503).send({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Live activity storage is unavailable' } });
      }
      try {
        const sessions = await prisma.activitySession.findMany({
          where: {
            ...(orgId ? { organizationId: orgId } : {}),
            startedAt: { gte: startOfToday, lte: now },
            device: { userId: { in: monitoredEmployeeIds } },
          },
          orderBy: { startedAt: 'desc' },
          include: { application: true, website: true, device: { select: { userId: true } } },
        });
        for (const session of sessions) {
          const employeeId = session.device?.userId;
          if (!employeeId) continue;
          if (!activityByEmployee.has(employeeId)) activityByEmployee.set(employeeId, []);
          activityByEmployee.get(employeeId).push(session);
        }
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to load live employee activity');
        return reply.status(503).send({ error: { code: 'ACTIVITY_UNAVAILABLE', message: 'Live activity is temporarily unavailable' } });
      }
    }

    const liveEmployees = [];
    let activeCount = 0;
    let idleCount = 0;
    let offlineCount = 0;
    let connectedCount = 0;
    let pendingEnrollmentCount = 0;
    let revokedCount = 0;

    for (const emp of list) {
      let liveStatus = 'NOT_ENROLLED';
      let currentApp = 'None';
      let currentDomain = 'None';
      let activeSecondsToday = 0;
      let idleSecondsToday = 0;
      let lastSeen = null;
      let primaryDevice = null;
      const employeeDevices = emp.devices || [];
      const activeDevices = employeeDevices.filter((device) => !device.isRevoked);
      const onlineDevices = activeDevices.filter((device) => {
        if (!device.lastSeenAt) return false;
        const ageMs = now.getTime() - new Date(device.lastSeenAt).getTime();
        return ageMs >= 0 && ageMs < 5 * 60 * 1000;
      });
      primaryDevice = activeDevices[0] || employeeDevices[0] || null;
      lastSeen = primaryDevice?.lastSeenAt || null;
      const sessions = activityByEmployee.get(emp.id) || [];
      activeSecondsToday = unionSeconds(sessions, ['APP_SESSION', 'WEB_SESSION'], startOfToday, now);
      idleSecondsToday = unionSeconds(sessions, ['IDLE_SESSION'], startOfToday, now);

      if (activeDevices.length === 0) {
        liveStatus = employeeDevices.length > 0 ? 'REVOKED' : 'NOT_ENROLLED';
      } else if (onlineDevices.length === 0) {
        liveStatus = 'OFFLINE';
      } else {
        liveStatus = 'CONNECTED';
        const latest = sessions[0];
        if (latest) {
          const latestTimestamp = new Date(latest.endedAt || latest.startedAt).getTime();
          const ageMs = now.getTime() - latestTimestamp;
          if (ageMs >= 0 && ageMs <= 5 * 60 * 1000) {
            if (latest.type === 'IDLE_SESSION') liveStatus = 'IDLE';
            else if (latest.type === 'APP_SESSION' || latest.type === 'WEB_SESSION') liveStatus = 'WORKING';
            if (latest.application) currentApp = latest.application.displayName || latest.application.executableName || 'None';
            if (latest.website) currentDomain = latest.website.domain || 'None';
          }
        }
      }

      if (liveStatus === 'WORKING') activeCount++;
      else if (liveStatus === 'IDLE') idleCount++;
      else if (liveStatus === 'OFFLINE') offlineCount++;
      else if (liveStatus === 'CONNECTED') connectedCount++;
      else if (liveStatus === 'NOT_ENROLLED') pendingEnrollmentCount++;
      else if (liveStatus === 'REVOKED') revokedCount++;

      liveEmployees.push({
        id: emp.id,
        employeeId: emp.employeeId,
        displayName: emp.displayName,
        email: emp.companyEmail || emp.email,
        department: emp.department || 'General',
        designation: emp.designation || 'Team Member',
        managerId: emp.managerId,
        device: primaryDevice,
        liveStatus,
        currentApplication: currentApp,
        currentDomain,
        activeSecondsToday,
        idleSecondsToday,
        activeTimeFormatted: `${Math.floor(activeSecondsToday / 3600)}h ${Math.floor((activeSecondsToday % 3600) / 60)}m`,
        lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
      });
    }

    return {
      employees: liveEmployees,
      summary: {
        totalEmployees: liveEmployees.length,
        activeCount,
        idleCount,
        offlineCount,
        connectedCount,
        pendingEnrollmentCount,
        revokedCount,
      },
      timestamp: now.toISOString(),
    };
  });

  // GET /api/v1/employees (Protected: User authentication, scoped by role & tenant)
  fastify.get('/employees', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const orgId = user.role === Roles.SUPER_ADMIN && req.query?.organizationId
      ? req.query.organizationId
      : user.organizationId;
    if (user.role !== Roles.SUPER_ADMIN && !orgId) {
      return reply.status(403).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'An organization scope is required to view employees' } });
    }

    let list = await fetchEmployees(orgId);
    const userRole = normalizeRole(user.role);

    // Enforce role-based access control
    if (userRole === Roles.EMPLOYEE) {
      // Employees may access only their own authorized records
      list = list.filter(
        (e) =>
          e.id === user.id ||
          (e.companyEmail && user.email && e.companyEmail.toLowerCase() === user.email.toLowerCase()) ||
          (e.email && user.email && e.email.toLowerCase() === user.email.toLowerCase()),
      );
    } else if (userRole === Roles.MANAGER) {
      // Managers may access only employees within their assigned scope
      list = list.filter(
        (e) =>
          e.id === user.id ||
          (e.companyEmail && user.email && e.companyEmail.toLowerCase() === user.email.toLowerCase()) ||
          e.managerId === user.id ||
          (user.departmentId && e.departmentId === user.departmentId) ||
          (user.department && e.department && e.department.toLowerCase() === user.department.toLowerCase()),
      );
    }

    const { department, status, search, managerId } = req.query || {};
    if (department && department !== 'undefined' && department !== 'all') {
      list = list.filter((e) => e.department && e.department.toLowerCase() === String(department).toLowerCase().trim());
    }
    if (status && status !== 'undefined' && status !== 'all') {
      list = list.filter((e) => e.employmentStatus && e.employmentStatus.toLowerCase() === String(status).toLowerCase().trim());
    } else if (!status || status === 'undefined') {
      list = list.filter((e) => e.employmentStatus === 'active');
    }
    if (managerId && managerId !== 'undefined') {
      list = list.filter((e) => e.managerId === managerId);
    }
    if (search && search !== 'undefined' && search.trim() !== '') {
      const q = String(search).toLowerCase().trim();
      list = list.filter(
        (e) =>
          (e.displayName && e.displayName.toLowerCase().includes(q)) ||
          (e.employeeId && e.employeeId.toLowerCase().includes(q)) ||
          (e.companyEmail && e.companyEmail.toLowerCase().includes(q)) ||
          (e.department && e.department.toLowerCase().includes(q)),
      );
    }

    const counts = {
      total: list.length,
      online: list.filter((employee) => employee.connectionStatus === 'ONLINE').length,
      offline: list.filter((employee) => employee.connectionStatus === 'OFFLINE').length,
      pending: list.filter((employee) => employee.accountStatus === 'PENDING_ACTIVATION' || employee.connectionStatus === 'PENDING_ENROLLMENT').length,
    };
    return { employees: list, totalCount: list.length, counts };
  });

  // GET /api/v1/employees/:id (Protected: role & tenant scope enforced)
  fastify.get('/employees/:id', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const { id } = req.params;
    const orgId = user.role === Roles.SUPER_ADMIN ? null : user.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id || e.companyEmail === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Employee not found' },
      });
    }

    // Tenant check
    if (orgId && emp.organizationId && emp.organizationId !== orgId) {
      return reply.code(403).send({
        error: { code: 'CROSS_TENANT_FORBIDDEN', message: 'Access to employees outside your organization is prohibited' },
      });
    }

    const userRole = normalizeRole(user.role);

    // Scope check: Employee can only access their own profile
    if (userRole === Roles.EMPLOYEE) {
      const isSelf =
        emp.id === user.id ||
        (emp.companyEmail && user.email && emp.companyEmail.toLowerCase() === user.email.toLowerCase()) ||
        (emp.email && user.email && emp.email.toLowerCase() === user.email.toLowerCase()) ||
        (emp.employeeId && user.employeeId && emp.employeeId === user.employeeId);

      if (!isSelf) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Employees may access only their own authorized records' },
        });
      }
    }

    // Scope check: Manager can only access assigned employees
    if (userRole === Roles.MANAGER) {
      const isAssigned =
        emp.id === user.id ||
        (emp.companyEmail && user.email && emp.companyEmail.toLowerCase() === user.email.toLowerCase()) ||
        emp.managerId === user.id ||
        (user.departmentId && emp.departmentId === user.departmentId) ||
        (user.department && emp.department && emp.department.toLowerCase() === user.department.toLowerCase());

      if (!isAssigned) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Managers may access only employees within their assigned scope' },
        });
      }
    }

    const activeDevices = (emp.devices || []).filter((device) => !device.isRevoked);
    const newestHeartbeat = activeDevices
      .filter((device) => device.lastSeenAt)
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))[0];
    const connected = Boolean(newestHeartbeat && Date.now() - new Date(newestHeartbeat.lastSeenAt).getTime() < 5 * 60 * 1000);
    let analytics = {
      hasData: false,
      totalMonitoredSeconds: null,
      activeSeconds: null,
      idleSeconds: null,
      policyViolationsCount: null,
      firstActiveAt: null,
      lastActiveAt: null,
      applicationUsage: [],
      websiteUsage: [],
    };

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    if (activeDevices.length > 0 && prisma?.activitySession?.findMany && emp.id) {
      const todaySessions = await prisma.activitySession.findMany({
        where: { organizationId: orgId || emp.organizationId, startedAt: { lt: new Date() }, endedAt: { gt: startOfToday }, device: { userId: emp.id } },
        include: { application: true, website: true },
      });
      if (todaySessions.length > 0) {
        const now = new Date();
        const sessionSeconds = (session) => Math.max(0, Math.min(now.getTime(), new Date(session.endedAt).getTime()) - Math.max(startOfToday.getTime(), new Date(session.startedAt).getTime())) / 1000;
        const aggregateUsage = (sessions, pick) => {
          const totals = new Map();
          for (const session of sessions) {
            const label = pick(session);
            if (!label) continue;
            totals.set(label, (totals.get(label) || 0) + sessionSeconds(session));
          }
          return [...totals].map(([name, seconds]) => ({ name, seconds: Math.round(seconds) })).sort((a, b) => b.seconds - a.seconds);
        };
        const activeSessions = todaySessions.filter((session) => ['APP_SESSION', 'WEB_SESSION'].includes(session.type));
        analytics = {
          hasData: true,
          activeSeconds: unionSeconds(todaySessions, ['APP_SESSION', 'WEB_SESSION'], startOfToday, now),
          idleSeconds: unionSeconds(todaySessions, ['IDLE_SESSION'], startOfToday, now),
          totalMonitoredSeconds: unionSeconds(todaySessions, ['APP_SESSION', 'WEB_SESSION', 'IDLE_SESSION'], startOfToday, now),
          policyViolationsCount: null,
          firstActiveAt: activeSessions.length ? new Date(Math.min(...activeSessions.map((session) => new Date(session.startedAt).getTime()))).toISOString() : null,
          lastActiveAt: activeSessions.length ? new Date(Math.max(...activeSessions.map((session) => new Date(session.endedAt).getTime()))).toISOString() : null,
          applicationUsage: aggregateUsage(todaySessions.filter((session) => session.type === 'APP_SESSION'), (session) => session.application?.displayName || session.application?.executableName),
          websiteUsage: aggregateUsage(todaySessions.filter((session) => session.type === 'WEB_SESSION'), (session) => session.website?.domain),
        };
      }
      if (prisma.policyViolation?.count) {
        analytics.policyViolationsCount = await prisma.policyViolation.count({
          where: { organizationId: emp.organizationId, userId: emp.id, timestamp: { gte: startOfToday } },
        });
      }
    }

    return {
      employee: {
        ...emp,
        deviceStatus: activeDevices.length === 0 ? 'NOT_CONNECTED' : connected ? 'CONNECTED' : 'OFFLINE',
        enrollmentStatus: activeDevices.length === 0 ? 'PENDING' : 'ENROLLED',
        monitoringStatus: activeDevices.length === 0 ? 'NOT_STARTED' : analytics.hasData ? 'ACTIVE' : 'WAITING_FOR_EVENTS',
        lastHeartbeatAt: newestHeartbeat?.lastSeenAt || null,
        lastSyncAt: activeDevices
          .filter((device) => device.lastSyncAt)
          .sort((a, b) => new Date(b.lastSyncAt) - new Date(a.lastSyncAt))[0]?.lastSyncAt || null,
        analytics,
      },
    };
  });

  // Send a setup reminder to an already activated employee. This is separate
  // from account invitations and never creates or changes credentials.
  fastify.post('/employees/:employeeId/setup-reminder', async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const role = normalizeRole(user.role);
    if (![Roles.ORGANIZATION_ADMIN, Roles.MANAGER, Roles.SUPER_ADMIN].includes(role)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Only an administrator or manager can send a setup reminder' } });
    }
    const orgId = role === Roles.SUPER_ADMIN ? null : user.organizationId;
    if (role !== Roles.SUPER_ADMIN && !orgId) {
      return reply.code(403).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'An organization scope is required to send a setup reminder' } });
    }
    if (!prisma?.user?.findFirst || !prisma?.invitation?.findFirst) {
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Employee and invitation storage is unavailable' } });
    }

    let employee;
    try {
      employee = await prisma.user.findFirst({
        where: {
          id: req.params.employeeId,
          role: Roles.EMPLOYEE,
          ...(orgId ? { organizationId: orgId } : {}),
        },
        select: {
          id: true,
          organizationId: true,
          departmentId: true,
          managerId: true,
          email: true,
          displayName: true,
          passwordHash: true,
          employmentStatus: true,
        },
      });
    } catch (error) {
      req.log?.error?.({ err: error, organizationId: orgId }, 'Employee setup reminder lookup failed');
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Employee data could not be loaded' } });
    }

    // Do not reveal whether an employee exists in another organization.
    if (!employee || (orgId && employee.organizationId !== orgId)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Employee not found' } });
    }
    if (role === Roles.MANAGER && employee.managerId !== user.id && !(user.departmentId && employee.departmentId === user.departmentId)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Managers may send reminders only within their assigned scope' } });
    }

    if (String(employee.employmentStatus || '').toLowerCase() !== 'active' || !employee.passwordHash) {
      return reply.code(409).send({
        error: {
          code: 'EMPLOYEE_NOT_ACTIVE',
          message: employee.passwordHash ? 'Setup reminders are available only for active employee accounts' : 'This employee has not accepted their invitation yet',
        },
      });
    }

    const now = new Date();
    let pendingInvitation;
    try {
      pendingInvitation = await prisma.invitation.findFirst({
        where: {
          organizationId: employee.organizationId,
          email: employee.email,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
    } catch (error) {
      req.log?.error?.({ err: error, organizationId: employee.organizationId }, 'Pending invitation check failed for setup reminder');
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Invitation status could not be checked' } });
    }
    if (pendingInvitation) {
      return reply.code(409).send({
        error: { code: 'INVITATION_PENDING', message: 'This employee still has an invitation awaiting acceptance. Resend or revoke that invitation from the directory.' },
      });
    }

    if (!prisma?.notification?.findMany || !prisma?.notification?.findFirst || !prisma?.notification?.create || !fastify.notifyService) {
      return reply.code(503).send({ error: { code: 'REMINDER_UNAVAILABLE', message: 'Persistent reminder notifications are unavailable' } });
    }

    const appUrl = fastify.config.publicAppUrl || process.env.DASHBOARD_URL || process.env.APP_BASE_URL || 'http://localhost:5173';
    const setupUrl = new URL('/employee-setup', appUrl).toString();
    const target = `employee-setup:${employee.id}`;
    let notificationResult;
    try {
      notificationResult = await fastify.notifyService.createNotification({
        type: 'employee_setup_reminder',
        severity: 'info',
        title: 'Device setup reminder',
        message: `Your DigitalPulse account is active. Sign in and follow the device setup guide: ${setupUrl}`,
        target,
        organizationId: employee.organizationId,
        userId: employee.id,
        cooldownMinutes: 60,
      });
    } catch (error) {
      req.log?.error?.({ err: error, organizationId: employee.organizationId, employeeId: employee.id }, 'Failed to queue employee setup reminder');
      return reply.code(503).send({ error: { code: 'REMINDER_UNAVAILABLE', message: 'The setup reminder could not be queued' } });
    }
    if (notificationResult.suppressed) {
      const response = { success: true, emailSent: false, notificationQueued: false, deliveryStatus: 'already_queued', message: 'A setup reminder was already queued recently; no duplicate was sent.' };
      await recordSetupReminderAudit({ organizationId: employee.organizationId, actorId: user.id, employeeId: employee.id, deliveryStatus: response.deliveryStatus });
      return reply.code(200).send(response);
    }

    let emailSent = false;
    let emailFailureCode = 'EMAIL_NOT_CONFIGURED';
    const emailService = fastify.authService?.emailService;
    if (emailService?.configured && typeof emailService.sendDeviceSetupReminder === 'function') {
      try {
        await emailService.sendDeviceSetupReminder({ to: employee.email, setupUrl });
        emailSent = true;
      } catch (error) {
        emailFailureCode = error.code || 'EMAIL_DELIVERY_FAILED';
        req.log?.warn?.({ errorCode: emailFailureCode, organizationId: employee.organizationId, employeeId: employee.id }, 'Employee setup reminder email delivery failed');
      }
    }

    const deliveryStatus = emailSent ? 'sent' : 'queued';
    await recordSetupReminderAudit({ organizationId: employee.organizationId, actorId: user.id, employeeId: employee.id, deliveryStatus });
    const payload = {
      success: true,
      emailSent,
      notificationQueued: true,
      deliveryStatus,
      message: emailSent
        ? `Setup instructions were emailed to ${employee.email}.`
        : emailFailureCode === 'EMAIL_NOT_CONFIGURED'
          ? 'Email is unavailable. The setup reminder was queued in DigitalPulse.'
          : 'Email delivery failed. The setup reminder was queued in DigitalPulse.',
      setupUrl,
    };
    return reply.code(emailSent ? 200 : 202).send(payload);
  });

  // POST /api/v1/employees (Protected: Admin only)
  fastify.post('/employees', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const userRole = normalizeRole(user.role);
    if (![Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN, Roles.MANAGER].includes(userRole)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Only an organization admin or manager can invite an employee' } });
    }
    const body = req.body ?? {};
    const displayName = body.displayName || `${body.firstName || ''} ${body.lastName || ''}`.trim();
    const email = body.companyEmail || body.email;
    if (!displayName || !email) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Employee name and email are required to start onboarding' } });
    }
    try {
      let departmentId = body.departmentId || user.departmentId || null;
      if (body.department?.trim()) {
        const found = await prisma.department.findFirst({ where: { organizationId: user.organizationId, name: body.department.trim() } });
        const department = found || await prisma.department.create({ data: { organizationId: user.organizationId, name: body.department.trim() } });
        departmentId = department.id;
      }
      if (departmentId) {
        const scopedDepartment = await prisma.department.findFirst({ where: { id: departmentId, organizationId: user.organizationId }, select: { id: true } });
        if (!scopedDepartment) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'The selected department does not belong to your organization' } });
      }
      const invitation = await fastify.authService.createInvitation({
        organizationId: user.organizationId,
        email,
        displayName,
        role: 'EMPLOYEE',
        departmentId,
        invitedBy: user.email,
        shiftStart: body.shiftStart,
        shiftEnd: body.shiftEnd,
        workingDays: body.workingDays,
        shiftTimezone: body.shiftTimezone,
      });
      return reply.code(201).send({ success: true, ...invitation, status: 'PENDING_INVITATION' });
    } catch (error) {
      return reply.code(error.statusCode || 503).send({ error: { code: 'EMPLOYEE_ONBOARDING_FAILED', message: error.message } });
    }
  });

  // PATCH /api/v1/employees/:id (Protected: Admin or Manager within scope)
  fastify.patch('/employees/:id/monitoring-authorization', {
    preHandler: [fastify.authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN)],
  }, async (req, reply) => {
    const authorized = req.body?.authorized;
    if (typeof authorized !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'authorized must be true or false' } });
    }
    const organizationId = req.user?.organizationId;
    if (!organizationId || !prisma?.user?.findFirst || !prisma?.user?.updateMany) {
      return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Monitoring authorization could not be saved' } });
    }
    try {
      const persist = async (tx) => {
        const target = await tx.user.findFirst({
          where: { id: req.params.id, organizationId, role: Roles.EMPLOYEE },
          select: { id: true },
        });
        if (!target) return false;
        const changed = await tx.user.updateMany({
          where: { id: target.id, organizationId, role: Roles.EMPLOYEE },
          data: { monitoringAuthorized: authorized },
        });
        if (changed.count !== 1) return false;
        if (tx.auditLog?.create) await tx.auditLog.create({
          data: {
            organizationId,
            action: authorized ? 'ACTIVITY_MONITORING_ADMIN_AUTHORIZED' : 'ACTIVITY_MONITORING_ADMIN_AUTHORIZATION_REVOKED',
            actor: req.user.email,
            details: { userId: target.id },
          },
        });
        return true;
      };
      const changed = prisma.$transaction ? await prisma.$transaction(persist) : await persist(prisma);
      if (!changed) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Employee not found in this organization' } });
      return reply.send({ success: true, employee: (await fetchEmployees(organizationId)).find((employee) => employee.id === req.params.id) });
    } catch (error) {
      req.log.error({ err: error }, 'Failed to update employee monitoring authorization');
      return reply.code(503).send({ error: { code: 'AUTHORIZATION_SAVE_FAILED', message: 'Monitoring authorization could not be saved' } });
    }
  });

  fastify.patch('/employees/:id', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const userRole = normalizeRole(user.role);
    if (userRole === Roles.EMPLOYEE) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Employees are not authorized to update employee records' },
      });
    }

    const { id } = req.params;
    const orgId = user.role === Roles.SUPER_ADMIN ? null : user.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Employee not found' },
      });
    }

    if (orgId && emp.organizationId && emp.organizationId !== orgId) {
      return reply.code(403).send({
        error: { code: 'CROSS_TENANT_FORBIDDEN', message: 'Access denied: employee belongs to another organization' },
      });
    }

    if (userRole === Roles.MANAGER && emp.managerId !== user.id && emp.departmentId !== user.departmentId) {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Managers may access only employees within their assigned scope' },
      });
    }

    const updates = req.body ?? {};
    if ((updates.shiftStart || updates.shiftEnd) && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(updates.shiftStart || emp.shiftStart) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(updates.shiftEnd || emp.shiftEnd) || (updates.shiftStart || emp.shiftStart) === (updates.shiftEnd || emp.shiftEnd))) {
      return reply.code(400).send({ error: { code: 'INVALID_SCHEDULE', message: 'Choose different valid start and end times. Overnight schedules are supported.' } });
    }
    if (updates.workingDays && (!Array.isArray(updates.workingDays) || !updates.workingDays.length || updates.workingDays.some((day) => !['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(day)))) {
      return reply.code(400).send({ error: { code: 'INVALID_SCHEDULE', message: 'Select at least one valid working day' } });
    }
    if (updates.shiftTimezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: updates.shiftTimezone }); }
      catch { return reply.code(400).send({ error: { code: 'INVALID_SCHEDULE', message: 'Enter a valid IANA time zone' } }); }
    }
    const updateData = {
            ...(updates.displayName ? { displayName: updates.displayName } : {}),
            ...(updates.companyEmail ? { email: updates.companyEmail } : {}),
            ...(updates.departmentId ? { departmentId: updates.departmentId } : {}),
            ...(updates.designation ? { designation: updates.designation } : {}),
            ...(updates.workLocation ? { workLocation: updates.workLocation } : {}),
            ...(updates.shiftStart ? { shiftStart: updates.shiftStart } : {}),
            ...(updates.shiftEnd ? { shiftEnd: updates.shiftEnd } : {}),
            ...(Array.isArray(updates.workingDays) ? { workingDays: updates.workingDays } : {}),
            ...(updates.shiftTimezone ? { shiftTimezone: updates.shiftTimezone } : {}),
            ...(updates.employmentStatus ? { employmentStatus: updates.employmentStatus } : {}),
    };
    if (Object.keys(updateData).length === 0) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'No supported employee changes were provided' } });
    if (!prisma?.user?.updateMany) return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Employee storage is unavailable' } });
    const changed = await prisma.user.updateMany({ where: { id: emp.id, organizationId: emp.organizationId }, data: updateData });
    if (changed.count !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Employee not found' } });
    const updated = (await fetchEmployees(emp.organizationId)).find((item) => item.id === emp.id);
    return { success: true, employee: updated, member: updated };
  });

  // DELETE /api/v1/employees/:id (Protected: Admin only)
  fastify.delete('/employees/:id', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const userRole = normalizeRole(user.role);
    if (userRole === Roles.EMPLOYEE || userRole === Roles.MANAGER) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Only administrators may delete employee records' },
      });
    }

    const { id } = req.params;
    const orgId = user.role === Roles.SUPER_ADMIN ? null : user.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Employee not found' },
      });
    }

    if (orgId && emp.organizationId && emp.organizationId !== orgId) {
      return reply.code(403).send({
        error: { code: 'CROSS_TENANT_FORBIDDEN', message: 'Access denied: employee belongs to another organization' },
      });
    }

    if (!prisma?.user?.updateMany) return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Employee status storage is unavailable' } });
    const changed = await prisma.user.updateMany({
      where: { id: emp.id, organizationId: emp.organizationId },
      data: { employmentStatus: 'disabled', monitoringAuthorized: false },
    });
    if (changed.count !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Employee not found' } });
    return { success: true, deactivatedId: emp.id };
  });

  // POST /api/v1/employees/:id/devices (Protected: Admin or Manager within scope)
  fastify.post('/employees/:id/devices', async (req, reply) => {
    const user = req.user;
    if (!user) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    if (normalizeRole(user.role) === Roles.EMPLOYEE) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Employees are not authorized to assign devices' },
      });
    }

    const { id } = req.params;
    const { deviceId } = req.body ?? {};
    if (!deviceId) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'deviceId is required' },
      });
    }

    const orgId = user.role === Roles.SUPER_ADMIN ? null : user.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Employee not found' },
      });
    }

    if (!prisma?.device?.findFirst || !prisma?.device?.update) return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Device assignment storage is unavailable' } });
    const device = await prisma.device.findFirst({ where: { id: deviceId, organizationId: emp.organizationId, isRevoked: false, OR: [{ userId: null }, { userId: emp.id }] } });
    if (!device) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Active device not found in this organization' } });
    await prisma.device.update({ where: { id: deviceId }, data: { userId: emp.id } });
    return { success: true, assignedDeviceIds: [...new Set([...(emp.assignedDeviceIds || []), deviceId])] };
  });

  // BACKWARD COMPATIBILITY ALIASES for /family/members
  fastify.get('/family/members', async (req, reply) => {
    const user = req.user;
    const orgId = user?.organizationId;
    let list = await fetchEmployees(orgId);

    if (user && normalizeRole(user.role) === Roles.EMPLOYEE) {
      list = list.filter((e) => e.id === user.id || e.companyEmail === user.email);
    }

    return {
      members: list.map((e) => ({
        ...e,
        role: e.role || (e.managerId ? 'member' : 'owner'),
        ageBracket: e.ageBracket || 'adult',
        consentGranted: typeof e.consentGranted === 'boolean' ? e.consentGranted : e.monitoringAuthorized,
      })),
      totalCount: list.length,
    };
  });

  fastify.post('/family/members', async (req, reply) => {
    const { displayName, email } = req.body ?? {};
    if (!displayName || !email) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Name and email are required to invite a member' } });
    try {
      const result = await fastify.authService.createInvitation({ organizationId: req.user.organizationId, email, displayName, invitedBy: req.user.email });
      return reply.code(201).send({ success: true, invitation: result });
    } catch (error) {
      return reply.code(error.statusCode || 503).send({ error: { code: 'INVITATION_FAILED', message: error.message } });
    }
  });

  fastify.patch('/family/members/:id', async (req, reply) => {
    const { id } = req.params;
    const orgId = req.user?.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Member not found' },
      });
    }

    const updates = req.body ?? {};
    const changed = await prisma.user.updateMany({ where: { id: emp.id, organizationId: orgId }, data: {
      ...(updates.displayName ? { displayName: updates.displayName } : {}),
      ...(updates.employmentStatus ? { employmentStatus: updates.employmentStatus } : {}),
    } });
    if (changed.count !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    return { success: true, member: { ...emp, ...updates }, employee: { ...emp, ...updates } };
  });

  fastify.delete('/family/members/:id', async (req, reply) => {
    const { id } = req.params;
    const orgId = req.user?.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Member not found' },
      });
    }

    const changed = await prisma.user.updateMany({ where: { id: emp.id, organizationId: orgId }, data: { employmentStatus: 'disabled', monitoringAuthorized: false } });
    if (changed.count !== 1) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    return { success: true, deactivatedId: emp.id };
  });

  fastify.post('/family/members/:id/devices', async (req, reply) => {
    const { id } = req.params;
    const { deviceId } = req.body ?? {};
    if (!deviceId) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'deviceId is required' },
      });
    }

    const orgId = req.user?.organizationId;
    const list = await fetchEmployees(orgId);
    const emp = list.find((e) => e.id === id || e.employeeId === id);

    if (!emp) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Member not found' },
      });
    }

    if (!emp.assignedDeviceIds.includes(deviceId)) {
      emp.assignedDeviceIds.push(deviceId);
    }

    if (prisma?.device?.update) {
      try {
        await prisma.device.update({
          where: { id: deviceId },
          data: { userId: emp.id },
        });
      } catch {
        // Safe
      }
    }

    return { success: true, assignedDeviceIds: emp.assignedDeviceIds };
  });

  // GET /api/v1/departments
  fastify.get('/departments', async (req) => {
    const orgId = req.user?.organizationId;
    if (!prisma?.department?.findMany) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Department storage is unavailable');
    const where = {};
    if (orgId) where.organizationId = orgId;
    const departments = await prisma.department.findMany({ where, orderBy: { name: 'asc' } });
    return { departments, count: departments.length };
  });

  // POST /api/v1/departments (Admin or Manager)
  fastify.post('/departments', async (req, reply) => {
    const userRole = normalizeRole(req.user?.role);
    if (userRole === Roles.EMPLOYEE) {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Insufficient privileges to create departments' },
      });
    }

    const { name, siteId } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'Department name is required' },
      });
    }

    const orgId = req.user?.organizationId;
    const cleanName = name.trim();

    if (!orgId || !prisma?.department?.create) return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Department storage is unavailable' } });
    try {
        const dept = await prisma.department.create({
          data: {
            organizationId: orgId,
            name: cleanName,
            siteId: siteId || null,
          },
        });
        return reply.code(201).send({ department: dept });
    } catch (err) {
        if (err.code === 'P2002') {
          return reply.code(409).send({
            error: { code: 'DUPLICATE_DEPARTMENT', message: 'A department with this name already exists in your organization' },
          });
        }
        throw err;
      }
  });

  // DELETE /api/v1/departments/:id (Admin only)
  fastify.delete('/departments/:id', async (req, reply) => {
    const userRole = normalizeRole(req.user?.role);
    if (userRole !== Roles.ORGANIZATION_ADMIN && userRole !== Roles.SUPER_ADMIN && userRole !== Roles.FAMILY_OWNER) {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Only administrators can delete departments' },
      });
    }

    const { id } = req.params;
    const orgId = req.user?.organizationId;

    if (!prisma?.department?.deleteMany) return reply.code(503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Department storage is unavailable' } });
    try {
        const where = { id };
        if (orgId) where.organizationId = orgId;
        const res = await prisma.department.deleteMany({ where });
        if (res.count === 0) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Department not found' } });
        }
        return { success: true, deletedId: id };
    } catch (err) { throw err; }
  });
}
