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
  fastify.post('/organization/register', async (req, reply) => {
    if (!fastify.config.allowPublicRegistration) {
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

  // Shared login handler for role-specific portals.
  const createLoginHandler = (expectedRole) => async (req, reply) => {
    const { email, password } = req.body || {};
    const rememberMe = req.body?.rememberMe !== false;
    const ipAddress = req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown Client';

    try {
      const session = await authService.login({
        email,
        password,
        rememberMe,
        ipAddress,
        userAgent,
        expectedRole,
      });

      reply.header('Set-Cookie', serializeSessionCookie(session.token, {
        secure: Boolean(fastify.config.secureSessionCookies),
        maxAgeSeconds: session.rememberMe ? 7 * 24 * 60 * 60 : undefined,
      }));

      return reply.send({
        success: true,
        expiresAt: session.expiresAt,
        rememberMe: session.rememberMe,
        user: session.user,
      });
    } catch (err) {
      return reply.status(err.statusCode || 401).send({
        error: {
          code: err.statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS',
          message: err.statusCode === 429
            ? err.message
            : 'Invalid email or password',
        },
      });
    }
  };

  // Employee portal
  fastify.post(
    '/auth/login',
    createLoginHandler(Roles.EMPLOYEE)
  );

  // Organization administrator portal
  fastify.post(
    '/organization/login',
    createLoginHandler(Roles.ADMIN)
  );

  // Platform super administrator portal
  fastify.post(
    '/super-admin/login',
    createLoginHandler(Roles.SUPER_ADMIN)
  );

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

  // Super Admin must explicitly choose a tenant; Admin stays bound to their own tenant.
  function invitationOrganizationId(req) {
    return String(req.user?.role || '').toUpperCase() === Roles.SUPER_ADMIN
      ? req.body?.organizationId || req.query?.organizationId || null
      : req.user?.organizationId || null;
  }

  // Create Invitation (Protected: Admin or Super Admin)
  const inviteHandler = async (req, reply) => {
    const { email, role, departmentId, department, displayName, shiftStart, shiftEnd, workingDays, shiftTimezone } = req.body || {};
    const organizationId = invitationOrganizationId(req);
    if (!organizationId) {
      return reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization before managing invitations' } });
    }
    try {
      if (!String(displayName || '').trim() || !String(email || '').trim() || !String(department || '').trim() && !departmentId && !req.user.departmentId) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Employee name, email, and department are required' } });
      }
      if (!shiftStart || !shiftEnd || !Array.isArray(workingDays) || !workingDays.length || !shiftTimezone) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Working hours, at least one working day, and a time zone are required' } });
      }
      if (role && String(role).toUpperCase() !== Roles.EMPLOYEE) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_INPUT',
            message: 'Invitations may assign only Employee access',
          },
        });
      }
      let resolvedDepartmentId = departmentId || req.user.departmentId;
      if (department?.trim()) {
        const existing = await fastify.prisma.department.findFirst({ where: { organizationId, name: department.trim() } });
        const saved = existing || await fastify.prisma.department.create({ data: { organizationId, name: department.trim() } });
        resolvedDepartmentId = saved.id;
      }
      if (resolvedDepartmentId) {
        const scopedDepartment = await fastify.prisma.department.findFirst({
          where: { id: resolvedDepartmentId, organizationId },
          select: { id: true },
        });
        if (!scopedDepartment) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'The selected department does not belong to your organization' } });
      }
      const result = await authService.createInvitation({
        organizationId,
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

  fastify.post('/auth/invitations', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, inviteHandler);
  fastify.post('/invitations', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, inviteHandler);

  // List Invitations (Protected: Admin or Super Admin)
  const listInvitationsHandler = async (req, reply) => {
    const organizationId = invitationOrganizationId(req);
    if (!organizationId) {
      return reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization before viewing invitations' } });
    }
    const invitations = await authService.listInvitations(organizationId);
    return { invitations, count: invitations.length };
  };
  fastify.get('/auth/invitations', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, listInvitationsHandler);
  fastify.get('/invitations', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, listInvitationsHandler);

  // Revoke Invitation (Protected: Admin only)
  const revokeInvitationHandler = async (req, reply) => {
    const organizationId = invitationOrganizationId(req);
    if (!organizationId) {
      return reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization before revoking invitations' } });
    }
    const { id } = req.params;
    const res = await authService.revokeInvitation({
      organizationId,
      invitationId: id,
    });
    return reply.send({ success: res.success, revokedId: id });
  };
  fastify.delete('/auth/invitations/:id', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, revokeInvitationHandler);
  fastify.delete('/invitations/:id', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, revokeInvitationHandler);

  const resendInvitationHandler = async (req, reply) => {
    const organizationId = invitationOrganizationId(req);
    if (!organizationId) {
      return reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization before resending invitations' } });
    }
    try {
      const result = await authService.resendInvitation({
        organizationId,
        invitationId: req.params.id,
        invitedBy: req.user.email,
      });
      return reply.send(result);
    } catch (err) {
      return reply.code(err.statusCode || 503).send({ error: { code: 'INVITATION_RESEND_FAILED', message: err.message } });
    }
  };
  fastify.post('/invitations/:id/resend', { preHandler: [authMiddleware.requireRole(Roles.ADMIN, Roles.SUPER_ADMIN)] }, resendInvitationHandler);

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
  fastify.get('/auth/roles', async (_req, reply) => {
    return reply.send({
      roles: [
        {
          id: Roles.SUPER_ADMIN,
          title: 'Super Administrator',
          description: 'Platform-wide administration, cross-organization oversight, governance and system audits.',
        },
        {
          id: Roles.ADMIN,
          title: 'Organization Administrator',
          description: 'Full administration within the organization, including employees, devices, reports and policies.',
        },
        {
          id: Roles.EMPLOYEE,
          title: 'Employee',
          description: 'Personal activity insights, device management, time planning and digital wellbeing.',
        },
      ],
    });
  });
}
