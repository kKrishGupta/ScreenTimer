import { AuthService, Roles, normalizeRole } from '../modules/auth/auth.service.js';

/**
 * Decorates request with authenticated user session or returns 401 if missing/invalid.
 */
export function createAuthMiddleware(authService) {
  return {
    /**
     * Enforces active session authentication.
     */
    async authenticate(req, reply) {
      const authHeader = req.headers.authorization;
      let token = null;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
      } else if (req.headers['x-session-token']) {
        token = req.headers['x-session-token'];
      }

      if (!token) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication token is required. Pass in Authorization: Bearer <token>',
          },
        });
      }

      const session = await authService.validateSession(token);
      if (!session) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Session is invalid or has expired',
          },
        });
      }

      req.user = session.user;
      req.session = session;
    },

    /**
     * Enforces that the authenticated user possesses one of the allowed roles.
     * @param {...string} allowedRoles
     */
    requireRole(...allowedRoles) {
      const normalizedAllowed = allowedRoles.map(normalizeRole);
      return async (req, reply) => {
        if (!req.user) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Authentication required before role check',
            },
          });
        }

        const userRole = normalizeRole(req.user.role);
        if (!normalizedAllowed.includes(userRole)) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: `Role ${userRole} is not authorized for this operation. Required: ${allowedRoles.join(', ')}`,
            },
          });
        }
      };
    },

    /**
     * Prevents cross-household access by matching target organizationId against authenticated user's organizationId.
     */
    requireHousehold(targetOrgParam = 'organizationId') {
      return async (req, reply) => {
        if (!req.user) {
          return reply.status(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const targetOrg = req.params[targetOrgParam] || req.query[targetOrgParam] || req.body?.[targetOrgParam];
        if (targetOrg && targetOrg !== req.user.organizationId) {
          return reply.status(403).send({
            error: {
              code: 'CROSS_HOUSEHOLD_FORBIDDEN',
              message: 'Access to resources outside your family household is prohibited',
            },
          });
        }
      };
    },
  };
}
