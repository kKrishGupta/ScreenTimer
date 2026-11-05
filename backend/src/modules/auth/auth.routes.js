import { AuthService, Roles } from './auth.service.js';
import { createAuthMiddleware } from '../../middleware/auth.middleware.js';
import { readSessionToken, serializeSessionCookie } from './session-cookie.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';

export default async function authRoutes(fastify) {
  const authService = fastify.authService || new AuthService(fastify.prisma, fastify.log, fastify.config);
  const authMiddleware = createAuthMiddleware(authService);

  // Decorate fastify instance so other modules can access auth
  if (!fastify.authService) {
    fastify.decorate('authService', authService);
    fastify.decorate('authMiddleware', authMiddleware);
  }

  // Register
  fastify.post('/auth/register', async (req, reply) => {
    if (fastify.config.nodeEnv === 'production') {
      return reply.code(403).send({
        error: { code: 'PUBLIC_REGISTRATION_DISABLED', message: 'Public organization registration is disabled. Ask your workspace owner for an invitation.' },
      });
    }
    const { email, password, displayName, organizationName } = req.body || {};
    try {
      const user = await authService.register({
        email,
        password,
        displayName,
        organizationName,
      });
      return reply.status(201).send({ success: true, user });
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: 'REGISTRATION_FAILED', message: err.message },
      });
    }
  });

  // Login
  fastify.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const rememberMe = req.body?.rememberMe !== false;
    const ipAddress = req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown Client';

    try {
      const session = await authService.login({ email, password, rememberMe, ipAddress, userAgent });
      reply.header('Set-Cookie', serializeSessionCookie(session.token, {
        secure: Boolean(fastify.config.secureSessionCookies),
        maxAgeSeconds: session.rememberMe ? 7 * 24 * 60 * 60 : undefined,
      }));
      const publicSession = {
        expiresAt: session.expiresAt,
        rememberMe: session.rememberMe,
        user: session.user,
      };
      return reply.send({ success: true, ...publicSession });
    } catch (err) {
      return reply.status(err.statusCode || 401).send({
        error: { code: err.statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS', message: err.message },
      });
    }
  });

  // Logout
  fastify.post('/auth/logout', async (req, reply) => {
    const token = readSessionToken(req);
    try {
      await authService.logout(token);
    } catch (err) {
      reply.header('Set-Cookie', serializeSessionCookie('', {
        secure: Boolean(fastify.config.secureSessionCookies),
        maxAgeSeconds: 0,
      }));
      return reply.code(err.statusCode || 503).send({
        error: { code: 'LOGOUT_UNAVAILABLE', message: 'The session could not be revoked. Try signing out again.' },
      });
    }
    reply.header('Set-Cookie', serializeSessionCookie('', {
      secure: Boolean(fastify.config.secureSessionCookies),
      maxAgeSeconds: 0,
    }));
    return reply.send({ success: true, message: 'Successfully logged out' });
  });

  // Current User Profile (Me)
  fastify.get(
    '/auth/me',
    { preHandler: [authMiddleware.authenticate] },
    async (req, reply) => {
      return reply.send({ success: true, user: req.user });
    },
  );

  // Change Password
  fastify.post(
    '/auth/change-password',
    { preHandler: [authMiddleware.authenticate] },
    async (req, reply) => {
      const { oldPassword, newPassword } = req.body || {};
      try {
        const result = await authService.changePassword({
          userId: req.user.id,
          oldPassword,
          newPassword,
        });
        return reply.send(result);
      } catch (err) {
        return reply.status(err.statusCode || 400).send({
          error: { code: 'PASSWORD_CHANGE_FAILED', message: err.message },
        });
      }
    },
  );

  const resetHeaders = async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
  };
  const resetRequestLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 5 });
  const resetConfirmLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10 });

  // Raw reset credentials are delivered exclusively through email.
  fastify.post('/auth/reset-password-request', { onRequest: [resetHeaders, resetRequestLimit] }, async (req, reply) => {
    const { email } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Email is required' },
      });
    }
    try {
      const result = await authService.requestPasswordReset({ email });
      return reply.send(result);
    } catch (err) {
      if (err.code === 'RESET_EMAIL_NOT_CONFIGURED') {
        return reply.status(503).send({ error: { code: 'RESET_EMAIL_NOT_CONFIGURED', message: 'Password-reset email is unavailable. Please contact your administrator.' } });
      }
      return reply.status(503).send({ error: { code: 'RESET_UNAVAILABLE', message: 'Password reset is temporarily unavailable. Please try again.' } });
    }
  });

  // Confirm Password Reset
  fastify.post('/auth/reset-password-confirm', { onRequest: [resetHeaders, resetConfirmLimit] }, async (req, reply) => {
    const { email, resetToken, newPassword } = req.body || {};
    try {
      const result = await authService.confirmPasswordReset({ email, resetToken, newPassword });
      return reply.send(result);
    } catch (err) {
      const invalidLink = err.code === 'RESET_LINK_INVALID';
      const weakPassword = err.code === 'PASSWORD_TOO_SHORT';
      return reply.status(invalidLink || weakPassword ? 400 : 503).send({
        error: {
          code: weakPassword ? 'PASSWORD_TOO_SHORT' : 'RESET_FAILED',
          message: weakPassword ? 'Password must be at least 8 characters long'
            : invalidLink ? 'This reset link is invalid, expired, or already used. Request a new reset link.'
              : 'Password reset is temporarily unavailable. Please try again.',
        },
      });
    }
  });

  // Create Invitation (Protected: Admin or Manager)
  const inviteHandler = async (req, reply) => {
    const { email, role, departmentId, department, displayName, shiftStart, shiftEnd, workingDays, shiftTimezone } = req.body || {};
    try {
      if (!String(displayName || '').trim() || !String(email || '').trim() || !String(department || '').trim() && !departmentId && !req.user.departmentId) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Employee name, email, and department are required' } });
      }
      if (!shiftStart || !shiftEnd || !Array.isArray(workingDays) || !workingDays.length || !shiftTimezone) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Working hours, at least one working day, and a time zone are required' } });
      }
      if (role && !['EMPLOYEE', 'MANAGER'].includes(String(role).toUpperCase())) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invitations may assign only Employee or Manager access' } });
      }
      let resolvedDepartmentId = departmentId || req.user.departmentId;
      if (department?.trim()) {
        if (req.user.role === Roles.MANAGER && department.trim().toLowerCase() !== String(req.user.department || '').toLowerCase()) {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Managers can only invite employees in their own department' } });
        }
        const existing = await fastify.prisma.department.findFirst({ where: { organizationId: req.user.organizationId, name: department.trim() } });
        const saved = existing || await fastify.prisma.department.create({ data: { organizationId: req.user.organizationId, name: department.trim() } });
        resolvedDepartmentId = saved.id;
      }
      if (resolvedDepartmentId) {
        const scopedDepartment = await fastify.prisma.department.findFirst({
          where: { id: resolvedDepartmentId, organizationId: req.user.organizationId },
          select: { id: true },
        });
        if (!scopedDepartment) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'The selected department does not belong to your organization' } });
      }
      const result = await authService.createInvitation({
        organizationId: req.user.organizationId,
        email,
        role: role || 'EMPLOYEE',
        departmentId: resolvedDepartmentId,
        invitedBy: req.user.email,
        displayName,
        shiftStart,
        shiftEnd,
        workingDays,
        shiftTimezone,
      });
      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: 'INVITATION_FAILED', message: err.message },
      });
    }
  };

  fastify.post('/auth/invitations', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN, Roles.MANAGER)] }, inviteHandler);
  fastify.post('/invitations', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN, Roles.MANAGER)] }, inviteHandler);

  // List Invitations (Protected: Admin or Manager)
  const listInvitationsHandler = async (req) => {
    const invitations = await authService.listInvitations(req.user?.organizationId);
    return { invitations, count: invitations.length };
  };
  fastify.get('/auth/invitations', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN, Roles.MANAGER)] }, listInvitationsHandler);
  fastify.get('/invitations', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN, Roles.MANAGER)] }, listInvitationsHandler);

  // Revoke Invitation (Protected: Admin only)
  const revokeInvitationHandler = async (req, reply) => {
    const { id } = req.params;
    const res = await authService.revokeInvitation({
      organizationId: req.user?.organizationId,
      invitationId: id,
    });
    return reply.send({ success: res.success, revokedId: id });
  };
  fastify.delete('/auth/invitations/:id', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN)] }, revokeInvitationHandler);
  fastify.delete('/invitations/:id', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN)] }, revokeInvitationHandler);

  const resendInvitationHandler = async (req, reply) => {
    try {
      const result = await authService.resendInvitation({
        organizationId: req.user.organizationId,
        invitationId: req.params.id,
        invitedBy: req.user.email,
      });
      return reply.send(result);
    } catch (err) {
      return reply.code(err.statusCode || 503).send({ error: { code: 'INVITATION_RESEND_FAILED', message: err.message } });
    }
  };
  fastify.post('/invitations/:id/resend', { preHandler: [authMiddleware.requireRole(Roles.ORGANIZATION_ADMIN, Roles.SUPER_ADMIN)] }, resendInvitationHandler);

  // The token is submitted in the POST body so it does not appear in backend access logs.
  const validateInvitationHandler = async (req, reply) => {
    try {
      const result = await authService.getInvitationDetails(req.body?.token);
      return reply.send(result);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: { code: 'INVITATION_VALIDATION_FAILED', message: err.message } });
    }
  };
  fastify.post('/auth/invitations/validate', validateInvitationHandler);
  fastify.post('/invitations/validate', validateInvitationHandler);

  // Accept Invitation (Public)
  const acceptHandler = async (req, reply) => {
    const { token, password, displayName } = req.body || {};
    try {
      const result = await authService.acceptInvitation({ token, password, displayName, authenticatedUser: req.user || null });
      return reply.status(200).send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: err.code || 'INVITATION_ACCEPT_FAILED', message: err.message || 'Invitation acceptance could not be completed.' },
      });
    }
  };

  fastify.post('/auth/invitations/accept', acceptHandler);
  fastify.post('/invitations/accept', acceptHandler);

  // Available Roles & Permissions Metadata
  fastify.get('/auth/roles', async (req, reply) => {
    return reply.send({
      roles: [
        {
          id: Roles.SUPER_ADMIN,
          title: 'Super Administrator',
          description: 'Cross-tenant oversight, platform-level governance, and system-wide audits.',
        },
        {
          id: Roles.ORGANIZATION_ADMIN,
          title: 'Organization Administrator',
          description: 'Full tenant governance, policy enforcement, employee & device management, and audit inspection.',
        },
        {
          id: Roles.MANAGER,
          title: 'Department Manager',
          description: 'Departmental analytics, supervised employee wellbeing, and team activity tracking.',
        },
        {
          id: Roles.EMPLOYEE,
          title: 'Employee',
          description: 'Personal activity insights, time planning, digital wellbeing, and privacy charter visibility.',
        },
        {
          id: Roles.FAMILY_OWNER,
          title: 'Family Owner',
          description: 'Full administrative governance, policy configuration, member & device management, and audit inspection.',
        },
        {
          id: Roles.ADULT_MEMBER,
          title: 'Adult Member',
          description: 'Personal activity insights, time planning, personal wellbeing goals, and consensual monitoring controls.',
        },
        {
          id: Roles.SUPERVISED_MEMBER,
          title: 'Supervised Member',
          description: 'Age-appropriate activity breakdown, daily screen-time visibility, and active family policy display.',
        },
      ],
    });
  });
}
