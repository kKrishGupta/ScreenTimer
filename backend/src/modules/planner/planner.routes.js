import crypto from 'node:crypto';

// Local storage for planner tasks, goals, and focus sessions (Stage 1 local MVP)
const plannerState = {
  tasks: [
    {
      id: crypto.randomUUID(),
      title: 'Complete Math & Science Homework',
      category: 'education',
      targetMinutes: 60,
      completed: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(),
      title: 'DigitalPulse Rust Agent Development',
      category: 'work',
      targetMinutes: 120,
      completed: false,
      createdAt: new Date().toISOString(),
    },
  ],
  goals: [
    {
      id: crypto.randomUUID(),
      category: 'daily_screen_time',
      title: 'Total Screen Time Limit',
      maxMinutesPerDay: 240, // 4 hours
      warningThresholdPercent: 85,
    },
    {
      id: crypto.randomUUID(),
      category: 'entertainment',
      title: 'Gaming & Social Media',
      maxMinutesPerDay: 60, // 1 hour
      warningThresholdPercent: 80,
    },
    {
      id: crypto.randomUUID(),
      category: 'productive',
      title: 'Study & Coding Goal',
      maxMinutesPerDay: 180, // 3 hours target
      warningThresholdPercent: 90,
    },
  ],
  activeFocusSession: null,
  pastFocusSessions: [],
  wellbeing: {
    continuousActiveMinutes: 0,
    lastBreakTakenAt: null,
    breakIntervalMinutes: 20, // 20-20-20 rule
    eyeRestDurationSeconds: 20,
    postureReminderEnabled: true,
    breaksCompletedToday: 3,
    breaksSkippedToday: 0,
  },
};

export default async function plannerRoutes(fastify) {
  const { prisma } = fastify;

  // GET /api/v1/planner/tasks
  fastify.get('/planner/tasks', async () => {
    return {
      tasks: plannerState.tasks,
      totalCount: plannerState.tasks.length,
      completedCount: plannerState.tasks.filter((t) => t.completed).length,
    };
  });

  // POST /api/v1/planner/tasks
  fastify.post('/planner/tasks', async (req, reply) => {
    const { title, category = 'general', targetMinutes = 30 } = req.body ?? {};
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'Task "title" is required' },
      });
    }

    const task = {
      id: crypto.randomUUID(),
      title: title.trim().slice(0, 140),
      category: String(category).slice(0, 32),
      targetMinutes: Math.max(5, Math.min(720, Number(targetMinutes) || 30)),
      completed: false,
      createdAt: new Date().toISOString(),
    };

    plannerState.tasks.unshift(task);
    return { success: true, task };
  });

  // PATCH /api/v1/planner/tasks/:id
  fastify.patch('/planner/tasks/:id', async (req, reply) => {
    const { id } = req.params;
    const task = plannerState.tasks.find((t) => t.id === id);
    if (!task) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      });
    }

    const { completed, title, targetMinutes } = req.body ?? {};
    if (typeof completed === 'boolean') task.completed = completed;
    if (title && typeof title === 'string') task.title = title.trim().slice(0, 140);
    if (targetMinutes != null) task.targetMinutes = Math.max(5, Math.min(720, Number(targetMinutes)));

    return { success: true, task };
  });

  // DELETE /api/v1/planner/tasks/:id
  fastify.delete('/planner/tasks/:id', async (req, reply) => {
    const { id } = req.params;
    const initialLen = plannerState.tasks.length;
    plannerState.tasks = plannerState.tasks.filter((t) => t.id !== id);

    if (plannerState.tasks.length === initialLen) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      });
    }

    return { success: true, deletedId: id };
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
  fastify.get('/planner/focus-sessions', async () => {
    // Check if active focus session expired
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
      title: String(title).slice(0, 100),
      durationMinutes: minutes,
      blockedCategories,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };

    plannerState.activeFocusSession = session;
    return { success: true, session };
  });

  // POST /api/v1/planner/focus-sessions/stop
  fastify.post('/planner/focus-sessions/stop', async () => {
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

  // GET /api/v1/planner/analytics (Planned vs. Actual comparison using real activity sessions)
  fastify.get('/planner/analytics', async () => {
    let realActiveSeconds = 0;
    try {
      if (prisma?.activitySession?.aggregate) {
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);

        const agg = await prisma.activitySession.aggregate({
          where: {
            type: { in: ['APP_SESSION', 'WEB_SESSION'] },
            startedAt: { gte: todayStart },
          },
          _sum: { durationSeconds: true },
        });
        realActiveSeconds = agg._sum?.durationSeconds ?? 0;
      }
    } catch {
      // Fallback in test / mock environment
      realActiveSeconds = 0;
    }

    const realActiveMinutes = Math.round(realActiveSeconds / 60);

    // Calculate goal adherence
    const goalComparisons = plannerState.goals.map((g) => {
      const actualMinutes = g.category === 'daily_screen_time' ? realActiveMinutes : Math.round(realActiveMinutes * 0.35);
      const percentUsed = g.maxMinutesPerDay > 0 ? Math.round((actualMinutes / g.maxMinutesPerDay) * 100) : 0;
      return {
        ...g,
        actualMinutes,
        percentUsed,
        isExceeded: actualMinutes > g.maxMinutesPerDay,
        isWarning: percentUsed >= g.warningThresholdPercent,
      };
    });

    const plannedTaskMinutes = plannerState.tasks.reduce((acc, t) => acc + (t.targetMinutes || 0), 0);
    const completedTaskMinutes = plannerState.tasks
      .filter((t) => t.completed)
      .reduce((acc, t) => acc + (t.targetMinutes || 0), 0);

    return {
      plannedTaskMinutes,
      completedTaskMinutes,
      realActiveMinutes,
      goalComparisons,
      taskCount: plannerState.tasks.length,
      completedTaskCount: plannerState.tasks.filter((t) => t.completed).length,
    };
  });

  // GET /api/v1/wellbeing/status
  fastify.get('/wellbeing/status', async () => {
    return {
      ...plannerState.wellbeing,
      eyeRestCountdownSeconds: 1200, // 20 mins remaining in local cycle
      recommendedAction: 'Keep up great posture! Next 20-20-20 eye break in 18 minutes.',
    };
  });

  // POST /api/v1/wellbeing/break/complete
  fastify.post('/wellbeing/break/complete', async () => {
    plannerState.wellbeing.breaksCompletedToday += 1;
    plannerState.wellbeing.lastBreakTakenAt = new Date().toISOString();
    return { success: true, breaksCompletedToday: plannerState.wellbeing.breaksCompletedToday };
  });
}
