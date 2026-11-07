import crypto from 'node:crypto';
import { Roles, normalizeRole } from '../auth/auth.service.js';

// Local storage for planner tasks, goals, and focus sessions (Stage 1 local MVP)
const plannerState = {
  tasks: [],
  goals: [],
  activeFocusSession: null,
  pastFocusSessions: [],
  wellbeing: {
    continuousActiveMinutes: 0,
    lastBreakTakenAt: null,
    breakIntervalMinutes: 20, // 20-20-20 rule
    eyeRestDurationSeconds: 20,
    postureReminderEnabled: true,
    breaksCompletedToday: 0,
    breaksSkippedToday: 0,
  },
};

export default async function plannerRoutes(fastify) {
  const { prisma } = fastify;

  function taskScope(req, reply) {
    if (!req.user?.id) {
      reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return null;
    }
    const role = normalizeRole(req.user.role);
    const organizationId = role === Roles.SUPER_ADMIN
      ? (req.method === 'GET' ? req.query?.organizationId : req.body?.organizationId)
      : req.user.organizationId;
    if (!organizationId) {
      reply.code(400).send({ error: { code: 'ORGANIZATION_SCOPE_REQUIRED', message: 'Select an organization' } });
      return null;
    }
    return { organizationId, ...(role === Roles.EMPLOYEE ? { userId: req.user.id } : {}) };
  }

  // Planner state is ancillary to activity monitoring. Production requests
  // must use durable models; unsupported in-memory-only endpoints fail closed.
  fastify.addHook('preHandler', async (req, reply) => {
    if (process.env.NODE_ENV !== 'production') return;
    const path = req.url.split('?')[0];
    let model;
    let operation;
    if (path.endsWith('/planner/tasks')) {
      model = prisma?.plannerTask;
      operation = req.method === 'GET' ? 'findMany' : 'create';
    } else if (/\/planner\/tasks\/[^/]+$/.test(path)) {
      model = prisma?.plannerTask;
      operation = req.method === 'PATCH' ? 'update' : 'delete';
    } else if (path.includes('/planner/focus-sessions')) {
      model = prisma?.focusSession;
      operation = path.endsWith('/start') ? 'create' : path.endsWith('/stop') ? 'updateMany' : 'findMany';
    } else if (path.endsWith('/planner/analytics')) {
      model = prisma?.activitySession;
      operation = 'findMany';
    } else {
      // Goals and wellbeing counters have no durable schema yet.
      return reply.code(503).send({ error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'This setting is not backed by persistent storage' } });
    }
    if (!model?.[operation]) {
      return reply.code(503).send({ error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'Planner persistence is unavailable' } });
    }
  });

  // GET /api/v1/planner/tasks
  fastify.get('/planner/tasks', async (req, reply) => {
    const whereClause = taskScope(req, reply);
    if (!whereClause) return;
    let tasks = plannerState.tasks.filter((task) => task.organizationId === whereClause.organizationId
      && (!whereClause.userId || task.userId === whereClause.userId));

    if (prisma?.plannerTask?.findMany) {
      try {
        const rows = await prisma.plannerTask.findMany({ where: whereClause, orderBy: { createdAt: 'desc' } });
        if (rows) {
          tasks = rows.map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            targetMinutes: r.targetMinutes,
            completed: r.completed,
            createdAt: r.createdAt?.toISOString ? r.createdAt.toISOString() : r.createdAt,
            organizationId: r.organizationId,
            userId: r.userId,
          }));
        }
      } catch {
        // Fallback
      }
    }

    return {
      tasks,
      totalCount: tasks.length,
      completedCount: tasks.filter((t) => t.completed).length,
    };
  });

  // POST /api/v1/planner/tasks
  fastify.post('/planner/tasks', async (req, reply) => {
    const scope = taskScope(req, reply);
    if (!scope) return;
    const orgId = scope.organizationId;
    const { title, category = 'general', targetMinutes = 30 } = req.body ?? {};
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'Task "title" is required' },
      });
    }

    const task = {
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: req.user.id,
      title: title.trim().slice(0, 140),
      category: String(category).slice(0, 32),
      targetMinutes: Math.max(5, Math.min(720, Number(targetMinutes) || 30)),
      completed: false,
      createdAt: new Date().toISOString(),
    };

    if (prisma?.plannerTask?.create) {
      try {
        await prisma.plannerTask.create({
          data: {
            id: task.id,
            organizationId: orgId,
            userId: req.user?.id,
            title: task.title,
            category: task.category,
            targetMinutes: task.targetMinutes,
            completed: false,
          },
        });
      } catch {
        // Safe fallback
      }
    }

    plannerState.tasks.unshift(task);
    return { success: true, task };
  });

  // PATCH /api/v1/planner/tasks/:id
  fastify.patch('/planner/tasks/:id', async (req, reply) => {
    const { id } = req.params;
    const scope = taskScope(req, reply);
    if (!scope) return;

    const { completed, title, targetMinutes } = req.body ?? {};

    const updateData = {};
    if (typeof completed === 'boolean') updateData.completed = completed;
    if (typeof title === 'string' && title.trim()) {
      updateData.title = title.trim().slice(0, 140);
    }
    if (targetMinutes != null) {
      updateData.targetMinutes = Math.max(
        5,
        Math.min(720, Number(targetMinutes) || 5),
      );
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'No valid task fields supplied' },
      });
    }

    if (prisma?.plannerTask?.findFirst && prisma?.plannerTask?.update) {
      try {
        const existing = await prisma.plannerTask.findFirst({
          where: { id, ...scope },
        });

        if (!existing) {
          return reply.code(404).send({
            error: { code: 'NOT_FOUND', message: 'Task not found' },
          });
        }

        const updated = await prisma.plannerTask.update({
          where: { id: existing.id },
          data: updateData,
        });

        return {
          success: true,
          task: {
            id: updated.id,
            title: updated.title,
            category: updated.category,
            targetMinutes: updated.targetMinutes,
            completed: updated.completed,
            createdAt: updated.createdAt?.toISOString
              ? updated.createdAt.toISOString()
              : updated.createdAt,
            organizationId: updated.organizationId,
            userId: updated.userId,
          },
        };
      } catch (error) {
        req.log?.error?.({ err: error }, 'Planner task update failed');
        return reply.code(503).send({
          error: {
            code: 'PERSISTENCE_UNAVAILABLE',
            message: 'Planner task update is temporarily unavailable',
          },
        });
      }
    }

    // Development-only in-memory fallback, using the same authorization scope.
    const taskIndex = plannerState.tasks.findIndex(
      (task) =>
        task.id === id &&
        task.organizationId === scope.organizationId &&
        (!scope.userId || task.userId === scope.userId),
    );

    if (taskIndex === -1) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      });
    }

    Object.assign(plannerState.tasks[taskIndex], updateData);

    return {
      success: true,
      task: plannerState.tasks[taskIndex],
    };
  });

  // DELETE /api/v1/planner/tasks/:id
  fastify.delete('/planner/tasks/:id', async (req, reply) => {
    const { id } = req.params;
    const scope = taskScope(req, reply);
    if (!scope) return;

    if (prisma?.plannerTask?.findFirst && prisma?.plannerTask?.delete) {
      try {
        const existing = await prisma.plannerTask.findFirst({
          where: { id, ...scope },
        });

        if (!existing) {
          return reply.code(404).send({
            error: { code: 'NOT_FOUND', message: 'Task not found' },
          });
        }

        await prisma.plannerTask.delete({
          where: { id: existing.id },
        });

        plannerState.tasks = plannerState.tasks.filter(
          (task) =>
            !(
              task.id === id &&
              task.organizationId === scope.organizationId &&
              (!scope.userId || task.userId === scope.userId)
            ),
        );

        return { success: true, deletedId: existing.id, message: 'Task deleted successfully' };
      } catch (error) {
        req.log?.error?.({ err: error }, 'Planner task deletion failed');
        return reply.code(503).send({
          error: {
            code: 'PERSISTENCE_UNAVAILABLE',
            message: 'Planner task deletion is temporarily unavailable',
          },
        });
      }
    }

    // Development-only in-memory fallback, using the same authorization scope.
    const initialLength = plannerState.tasks.length;

    plannerState.tasks = plannerState.tasks.filter(
      (task) =>
        !(
          task.id === id &&
          task.organizationId === scope.organizationId &&
          (!scope.userId || task.userId === scope.userId)
        ),
    );

    if (plannerState.tasks.length === initialLength) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      });
    }

    return { success: true, deletedId: id, message: 'Task deleted successfully' };
  });

  // GET /api/v1/planner/goals
  fastify.get('/planner/goals', async () => {
    return {
      goals: plannerState.goals,
      count: plannerState.goals.length,
    };
  });

  // POST /api/v1/planner/goals
  fastify.post('/planner/goals', async (req, reply) => {
    const { title, category, maxMinutesPerDay, warningThresholdPercent = 80 } = req.body ?? {};
    if (!title || !category || !maxMinutesPerDay) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'title, category, and maxMinutesPerDay are required' },
      });
    }

    const existing = plannerState.goals.find((g) => g.category === category);
    if (existing) {
      existing.title = title;
      existing.maxMinutesPerDay = Number(maxMinutesPerDay);
      existing.warningThresholdPercent = Number(warningThresholdPercent);
      return { success: true, goal: existing };
    }

    const goal = {
      id: crypto.randomUUID(),
      category: String(category).slice(0, 32),
      title: String(title).slice(0, 64),
      maxMinutesPerDay: Math.max(10, Math.min(1440, Number(maxMinutesPerDay))),
      warningThresholdPercent: Math.max(50, Math.min(100, Number(warningThresholdPercent))),
    };

    plannerState.goals.push(goal);
    return { success: true, goal };
  });

  // GET /api/v1/planner/focus-sessions
  fastify.get('/planner/focus-sessions', async (req) => {
    const orgId = req.user?.organizationId;

    if (prisma?.focusSession?.findMany) {
      try {
        const whereClause = orgId ? { organizationId: orgId } : {};
        const rows = await prisma.focusSession.findMany({
          where: whereClause,
          orderBy: { startedAt: 'desc' },
          take: 20,
        });

        const activeRow = rows.find((r) => !r.completed && new Date(r.expiresAt) > new Date());
        const pastRows = rows.filter((r) => r !== activeRow);

        return {
          activeSession: activeRow
            ? {
                id: activeRow.id,
                title: activeRow.title,
                durationMinutes: activeRow.durationMinutes,
                startedAt: activeRow.startedAt.toISOString(),
                expiresAt: activeRow.expiresAt.toISOString(),
                status: 'active',
              }
            : null,
          history: pastRows.map((r) => ({
            id: r.id,
            title: r.title,
            durationMinutes: r.durationMinutes,
            startedAt: r.startedAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            status: r.completed ? 'completed' : 'stopped_early',
          })),
        };
      } catch {
        // Fallback
      }
    }

    // In-memory fallback
    if (plannerState.activeFocusSession) {
      const now = new Date();
      if (now >= new Date(plannerState.activeFocusSession.expiresAt)) {
        plannerState.activeFocusSession.status = 'completed';
        plannerState.pastFocusSessions.unshift({ ...plannerState.activeFocusSession });
        plannerState.activeFocusSession = null;
      }
    }

    return {
      activeSession: plannerState.activeFocusSession,
      history: plannerState.pastFocusSessions.slice(0, 20),
    };
  });

  // POST /api/v1/planner/focus-sessions/start
  fastify.post('/planner/focus-sessions/start', async (req, reply) => {
    const orgId = req.user?.organizationId || '00000000-0000-0000-0000-000000000000';
    if (plannerState.activeFocusSession) {
      return reply.code(409).send({
        error: { code: 'ACTIVE_SESSION_EXISTS', message: 'A focus session is already in progress' },
      });
    }

    const { title = 'Deep Focus Block', durationMinutes = 25, blockedCategories = ['entertainment', 'social_media'] } = req.body ?? {};
    const minutes = Math.max(5, Math.min(180, Number(durationMinutes)));
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + minutes * 60 * 1000);

    const session = {
      id: crypto.randomUUID(),
      organizationId: orgId,
      title: String(title).slice(0, 100),
      durationMinutes: minutes,
      blockedCategories,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };

    if (prisma?.focusSession?.create) {
      try {
        await prisma.focusSession.create({
          data: {
            id: session.id,
            organizationId: orgId,
            userId: req.user?.id,
            title: session.title,
            durationMinutes: session.durationMinutes,
            startedAt,
            expiresAt,
            completed: false,
          },
        });
      } catch {
        // Fallback
      }
    }

    plannerState.activeFocusSession = session;
    return { success: true, session };
  });

  // POST /api/v1/planner/focus-sessions/stop
  fastify.post('/planner/focus-sessions/stop', async (req) => {
    const orgId = req.user?.organizationId;
    if (prisma?.focusSession?.updateMany) {
      try {
        const whereClause = { completed: false };
        if (orgId) whereClause.organizationId = orgId;
        await prisma.focusSession.updateMany({
          where: whereClause,
          data: { completed: true },
        });
      } catch {
        // Fallback
      }
    }

    if (!plannerState.activeFocusSession) {
      return { success: true, message: 'No active focus session' };
    }

    const session = {
      ...plannerState.activeFocusSession,
      status: 'stopped_early',
      stoppedAt: new Date().toISOString(),
    };

    plannerState.pastFocusSessions.unshift(session);
    plannerState.activeFocusSession = null;

    return { success: true, session };
  });

  // Keep this legacy planner report factual. App and browser intervals may
  // overlap, so use their union for total active duration and do not invent
  // per-task attribution, productivity scores, goals, or planned schedules.
  fastify.get('/planner/analytics', async (req, reply) => {
    const scope = taskScope(req, reply);
    if (!scope) return;

    const organizationId = scope.organizationId;

    if (!prisma?.activitySession?.findMany) {
      return reply.code(503).send({ error: { code: 'ANALYTICS_UNAVAILABLE', message: 'Persistent activity data is unavailable' } });
    }
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const where = {
      organizationId,
      type: { in: ['APP_SESSION', 'WEB_SESSION'] },
      startedAt: { lt: dayEnd },
      endedAt: { gt: dayStart },
    };
    if (scope.userId) {
      where.device = { userId: scope.userId };
    }

    let sessions;
    try {
      sessions = await prisma.activitySession.findMany({ where, select: { startedAt: true, endedAt: true } });
    } catch (error) {
      req.log?.error?.({ err: error }, 'Planner activity query failed');
      return reply.code(503).send({ error: { code: 'ANALYTICS_UNAVAILABLE', message: 'Persistent activity data is unavailable' } });
    }
    const intervals = sessions
      .map((session) => [Math.max(dayStart.getTime(), new Date(session.startedAt).getTime()), Math.min(dayEnd.getTime(), new Date(session.endedAt).getTime())])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
      .sort((a, b) => a[0] - b[0]);
    let activeSeconds = 0;
    let current = null;
    for (const interval of intervals) {
      if (!current) current = interval;
      else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
      else {
        activeSeconds += (current[1] - current[0]) / 1000;
        current = interval;
      }
    }
    if (current) activeSeconds += (current[1] - current[0]) / 1000;

    const realActiveMinutes = Math.round(activeSeconds / 60);
    let tasks = plannerState.tasks.filter(
      (task) =>
        task.organizationId === organizationId &&
        (!scope.userId || task.userId === scope.userId),
    );
    if (prisma?.plannerTask?.findMany) {
      try {
        tasks = await prisma.plannerTask.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
        });
      } catch (error) {
        req.log?.error?.({ err: error }, 'Planner task query failed');
        return reply.code(503).send({ error: { code: 'ANALYTICS_UNAVAILABLE', message: 'Persistent task data is unavailable' } });
      }
    } else if (process.env.NODE_ENV === 'production') {
      return reply.code(503).send({ error: { code: 'ANALYTICS_UNAVAILABLE', message: 'Persistent task data is unavailable' } });
    }
    const completedTaskCount = tasks.filter((task) => task.completed).length;
    return {
      realActiveMinutes,
      actualScreenTimeMinutes: realActiveMinutes,
      plannedScreenTimeMinutes: null,
      plannedProductiveMinutes: null,
      actualProductiveMinutes: null,
      plannedTaskMinutes: tasks.reduce((sum, task) => sum + (task.targetMinutes || 0), 0),
      completedTaskMinutes: tasks.filter((task) => task.completed).reduce((sum, task) => sum + (task.targetMinutes || 0), 0),
      goalComparisons: [],
      taskCount: tasks.length,
      completedTaskCount,
      pendingTaskCount: tasks.length - completedTaskCount,
      goalCompletionPercent: tasks.length ? Math.round((completedTaskCount / tasks.length) * 100) : null,
      tasks: tasks.map((task) => ({ ...task, actualRecordedMinutes: null, progressPercent: null })),
      hourlyTimeline: [],
    };
  });

  // GET /api/v1/wellbeing/status
  fastify.get('/wellbeing/status', async () => {
    return {
      ...plannerState.wellbeing,
      eyeRestCountdownSeconds: null,
    };
  });

  // POST /api/v1/wellbeing/break/complete
  fastify.post('/wellbeing/break/complete', async () => {
    plannerState.wellbeing.breaksCompletedToday += 1;
    plannerState.wellbeing.lastBreakTakenAt = new Date().toISOString();
    return { success: true, breaksCompletedToday: plannerState.wellbeing.breaksCompletedToday };
  });
}
