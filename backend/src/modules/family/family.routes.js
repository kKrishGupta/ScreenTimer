import crypto from 'node:crypto';
import { Roles, normalizeRole } from '../auth/auth.service.js';

// In-memory family members state for local Stage 1 operation
const familyState = {
  members: [
    {
      id: crypto.randomUUID(),
      displayName: 'Alex (Family Owner)',
      email: 'alex@family.local',
      role: 'owner',
      ageBracket: 'adult',
      consentGranted: true,
      consentDate: new Date().toISOString(),
      assignedDeviceIds: [],
      createdAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      displayName: 'Sam (Child)',
      email: 'sam@family.local',
      role: 'child',
      ageBracket: 'child',
      consentGranted: true,
      guardianAuthorized: true,
      assignedDeviceIds: [],
      createdAt: new Date().toISOString(),
    },
  ],
};

export default async function familyRoutes(fastify) {
  const { prisma } = fastify;

  // GET /api/v1/family/members
  fastify.get('/family/members', async (req, reply) => {
    const role = normalizeRole(req.user?.role);
    const organizationId = role === Roles.SUPER_ADMIN
      ? req.query?.organizationId
      : req.user?.organizationId;
    if (!organizationId) {
      return reply.code(400).send({
        error: {
          code: 'ORGANIZATION_SCOPE_REQUIRED',
          message: 'Select an organization before viewing members',
        },
      });
    }

    // Attempt to enrich with device names from Prisma if available
    let devices = [];
    try {
      if (prisma?.device?.findMany) {
        devices = await prisma.device.findMany({
          where: { organizationId, deletedAt: null },
          select: { id: true, name: true, kind: true, platform: true, lastSeenAt: true },
        });
      }
    } catch {
      devices = [];
    }

    // Auto-link registered devices with the primary owner/admin if not explicitly assigned
    if (devices.length > 0 && familyState.members.length > 0 && familyState.members[0].assignedDeviceIds.length === 0) {
      familyState.members[0].assignedDeviceIds = devices.map((d) => d.id);
    }

    const membersWithDevices = familyState.members.map((m) => {
      const assigned = devices.filter((d) => m.assignedDeviceIds.includes(d.id));
      return {
        ...m,
        devices: assigned,
      };
    });

    return {
      members: membersWithDevices,
      totalCount: membersWithDevices.length,
    };
  });

  // POST /api/v1/family/members
  fastify.post('/family/members', async (req, reply) => {
    const { displayName, email, role = 'member', ageBracket = 'adult', consentGranted = true } = req.body ?? {};
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'displayName is required' },
      });
    }

    const member = {
      id: crypto.randomUUID(),
      displayName: displayName.trim().slice(0, 100),
      email: (email || `${displayName.toLowerCase().replace(/\s+/g, '')}@family.local`).slice(0, 200),
      role: ['owner', 'parent', 'child', 'member'].includes(role) ? role : 'member',
      ageBracket: ['child', 'teen', 'adult'].includes(ageBracket) ? ageBracket : 'adult',
      consentGranted: Boolean(consentGranted),
      guardianAuthorized: role === 'child' || ageBracket === 'child',
      consentDate: consentGranted ? new Date().toISOString() : null,
      assignedDeviceIds: [],
      createdAt: new Date().toISOString(),
    };

    familyState.members.push(member);
    return { success: true, member };
  });

  // PATCH /api/v1/family/members/:id
  fastify.patch('/family/members/:id', async (req, reply) => {
    const { id } = req.params;
    const member = familyState.members.find((m) => m.id === id);
    if (!member) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Family member not found' },
      });
    }

    const { displayName, role, ageBracket, consentGranted, assignedDeviceIds } = req.body ?? {};
    if (displayName) member.displayName = displayName.trim().slice(0, 100);
    if (role && ['owner', 'parent', 'child', 'member'].includes(role)) member.role = role;
    if (ageBracket && ['child', 'teen', 'adult'].includes(ageBracket)) member.ageBracket = ageBracket;
    if (typeof consentGranted === 'boolean') {
      member.consentGranted = consentGranted;
      member.consentDate = consentGranted ? new Date().toISOString() : null;
    }
    if (Array.isArray(assignedDeviceIds)) member.assignedDeviceIds = assignedDeviceIds;

    return { success: true, member };
  });

  // DELETE /api/v1/family/members/:id
  fastify.delete('/family/members/:id', async (req, reply) => {
    const { id } = req.params;
    const initialLen = familyState.members.length;
    familyState.members = familyState.members.filter((m) => m.id !== id);

    if (familyState.members.length === initialLen) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Family member not found' },
      });
    }

    return { success: true, deletedId: id };
  });

  // POST /api/v1/family/members/:id/devices
  fastify.post('/family/members/:id/devices', async (req, reply) => {
    const { id } = req.params;
    const { deviceId } = req.body ?? {};
    const member = familyState.members.find((m) => m.id === id);
    if (!member) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Family member not found' },
      });
    }

    if (!deviceId) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'deviceId is required' },
      });
    }

    if (!member.assignedDeviceIds.includes(deviceId)) {
      member.assignedDeviceIds.push(deviceId);
    }

    return { success: true, assignedDeviceIds: member.assignedDeviceIds };
  });
}

