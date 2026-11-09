import { Roles, normalizeRole } from '../modules/auth/auth.service.js';
import { readSessionToken } from '../modules/auth/session-cookie.js';

/**
 * Decorates request with authenticated user session or device identity,
 * enforcing tenant isolation and role-based permissions.
 */
export function createAuthMiddleware(authService, deviceService) {
  function extractBearerToken(req) {
    return readSessionToken(req);
  }

  function extractDeviceSecret(req) {
    if (req.headers['x-device-secret']) {
      return req.headers['x-device-secret'];
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const candidate = authHeader.substring(7).trim();
      if (candidate.startsWith('dp_sec_')) {
        return candidate;
      }
    }
    if (req.body?.deviceSecret) {
      return req.body.deviceSecret;
    }
    if (req.body?.device?.secret) {
      return req.body.device.secret;
    }
    if (req.body?.secret) {
      return req.body.secret;
    }
    return null;
  }

  return {
    /**
     * Enforces active user session authentication and tenant isolation.
     */
    async authenticate(req, reply) {
      const token = extractBearerToken(req);
      if (!token) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Sign in to continue.',
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
      req.organizationId = session.user.organizationId;

      // Tenant isolation: client-supplied organizationId must match authenticated session
      const targetOrg =
        req.params?.organizationId ||
        req.query?.organizationId ||
        (typeof req.body === 'object' && req.body !== null ? req.body.organizationId : null);

      if (
        targetOrg &&
        normalizeRole(req.user.role) !== Roles.SUPER_ADMIN &&
        targetOrg !== req.organizationId
      ) {
        return reply.status(403).send({
          error: {
            code: 'CROSS_TENANT_FORBIDDEN',
            message: 'Access to resources outside your organization is prohibited',
          },
        });
      }
    },

    /**
     * Authenticates an endpoint device submitting telemetry or heartbeats.
     */
    async authenticateDevice(req, reply) {
      const deviceId =
        req.params?.id ||
        req.body?.device?.id ||
        req.body?.deviceId ||
        req.query?.deviceId;

      if (!deviceId) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Device ID is required for device authentication',
          },
        });
      }

      const secret = extractDeviceSecret(req);
      if (!secret) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Device authentication credentials required (X-Device-Secret or Bearer dp_sec_...)',
          },
        });
      }

      if (!deviceService) {
        return reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Device service unavailable' },
        });
      }

      const check = await deviceService.validateDeviceCredentials(deviceId, secret);
      if (!check.valid) {
        if (['DEVICE_REVOKED', 'DEVICE_ARCHIVED'].includes(check.code)) {
          return reply.status(403).send({
            error: {
              code: check.code,
              message: check.message,
            },
          });
        }
        return reply.status(check.code === 'STORAGE_UNAVAILABLE' ? 503 : 401).send({
          error: {
            code: check.code || 'UNAUTHORIZED',
            message: check.message || 'Invalid device credentials',
          },
        });
      }

      req.device = check.device;
      req.organizationId = check.device.organizationId;
    },

    /**
     * Enforces role-based permissions (SUPER_ADMIN, ADMIN, EMPLOYEE).
     */
    requireRole(...allowedRoles) {
      const canonicalAllowed = allowedRoles.filter((role) => typeof role === 'string' && role.trim()).map(normalizeRole);
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
        if (
          userRole === Roles.SUPER_ADMIN ||
          canonicalAllowed.includes(userRole) ||
          allowedRoles.includes(req.user.role)
        ) {
          return; // Authorized
        }

        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: `Role ${req.user.role} is not authorized for this operation. Required: ${allowedRoles.join(', ')}`,
          },
        });
      };
    },

    /**
     * Household/Organization boundary check helper.
     */
    requireHousehold(targetOrgParam = 'organizationId') {
      return async (req, reply) => {
        if (!req.user) {
          return reply.status(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const targetOrg =
          req.params?.[targetOrgParam] ||
          req.query?.[targetOrgParam] ||
          req.body?.[targetOrgParam];

        if (
          targetOrg &&
          normalizeRole(req.user.role) !== Roles.SUPER_ADMIN &&
          targetOrg !== req.user.organizationId
        ) {
          return reply.status(403).send({
            error: {
              code: 'CROSS_HOUSEHOLD_FORBIDDEN',
              message: 'Access to resources outside your organization is prohibited',
            },
          });
        }
      };
    },
  };
}
