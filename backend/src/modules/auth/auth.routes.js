import { AuthService, Roles } from './auth.service.js';
import { createAuthMiddleware } from '../../middleware/auth.middleware.js';

export default async function authRoutes(fastify) {
  const authService = new AuthService(fastify.prisma, fastify.log);
  const authMiddleware = createAuthMiddleware(authService);

  // Decorate fastify instance so other modules can access auth
  if (!fastify.authService) {
    fastify.decorate('authService', authService);
    fastify.decorate('authMiddleware', authMiddleware);
  }

  // Register
  fastify.post('/auth/register', async (req, reply) => {
    const { email, password, displayName, role, organizationId, organizationName } = req.body || {};
    try {
      const user = await authService.register({
        email,
        password,
        displayName,
        role,
        organizationId,
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
    const ipAddress = req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown Client';

    try {
      const session = await authService.login({ email, password, ipAddress, userAgent });
      return reply.send({ success: true, ...session });
    } catch (err) {
      return reply.status(err.statusCode || 401).send({
        error: { code: err.statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS', message: err.message },
      });
    }
  });

  // Logout
  fastify.post(
    '/auth/logout',
    { preHandler: [authMiddleware.authenticate] },
    async (req, reply) => {
      await authService.logout(req.session.token);
      return reply.send({ success: true, message: 'Successfully logged out' });
    },
  );

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

  // Request Password Reset Token (Dev friendly)
  fastify.post('/auth/reset-password-request', async (req, reply) => {
    const { email } = req.body || {};
    if (!email) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Email is required' },
      });
    }
    const result = await authService.requestPasswordReset({ email });
    return reply.send(result);
  });

  // Confirm Password Reset
  fastify.post('/auth/reset-password-confirm', async (req, reply) => {
    const { email, resetToken, newPassword } = req.body || {};
    try {
      const result = await authService.confirmPasswordReset({ email, resetToken, newPassword });
      return reply.send(result);
    } catch (err) {
      return reply.status(err.statusCode || 400).send({
        error: { code: 'RESET_FAILED', message: err.message },
      });
    }
  });

  // Available Roles & Permissions Metadata
  fastify.get('/auth/roles', async (req, reply) => {
    return reply.send({
      roles: [
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
