import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

export default function TimePlannerPage() {
  const fetchTasks = useCallback((opts) => api.plannerTasks(opts), []);
  const fetchGoals = useCallback((opts) => api.plannerGoals(opts), []);
  const fetchSessions = useCallback((opts) => api.focusSessions(opts), []);
  const fetchAnalytics = useCallback((opts) => api.plannerAnalytics(opts), []);

  const { data: tasksData, error: tasksErr, loading: tasksLoading, reload: reloadTasks } = useApi(fetchTasks, { intervalMs: 5000 });
  const { data: goalsData, reload: reloadGoals } = useApi(fetchGoals, { intervalMs: 5000 });
  const { data: sessionsData, reload: reloadSessions } = useApi(fetchSessions, { intervalMs: 3000 });
  const { data: analytics, error: analyticsErr, loading: analyticsLoading, reload: reloadAnalytics } = useApi(fetchAnalytics, { intervalMs: 5000 });

  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskCategory, setNewTaskCategory] = useState('engineering');
  const [newTaskMinutes, setNewTaskMinutes] = useState(30);
  const [busy, setBusy] = useState(false);

  const tasks = analytics?.tasks ?? tasksData?.tasks ?? [];
  const goals = analytics?.goalComparisons ?? goalsData?.goals ?? [];
  const activeFocus = sessionsData?.activeSession;
  const timeline = analytics?.hourlyTimeline ?? [];

  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    try {
      setBusy(true);
      await api.createPlannerTask({
        title: newTaskTitle.trim(),
        category: newTaskCategory,
        targetMinutes: Number(newTaskMinutes),
      });
      setNewTaskTitle('');
      reloadTasks();
      reloadAnalytics();
    } catch (err) {
      alert(`Error creating task: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleToggleTask = async (id, currentCompleted) => {
    try {
      await api.updatePlannerTask(id, { completed: !currentCompleted });
      reloadTasks();
      reloadAnalytics();
    } catch (err) {
      alert(`Error updating task: ${err.message}`);
    }
  };

  const handleDeleteTask = async (id) => {
    try {
      await api.deletePlannerTask(id);
      reloadTasks();
      reloadAnalytics();
    } catch (err) {
      alert(`Error deleting task: ${err.message}`);
    }
  };

  const handleStartFocus = async (durationMinutes = 25) => {
    try {
      setBusy(true);
      await api.startFocusSession({
        title: 'Deep Focus Block',
        durationMinutes,
        blockedCategories: ['entertainment', 'social_media'],
      });
      reloadSessions();
    } catch (err) {
      alert(`Error starting focus session: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStopFocus = async () => {
    try {
      setBusy(true);
      await api.stopFocusSession();
      reloadSessions();
    } catch (err) {
      alert(`Error stopping focus session: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  if ((tasksLoading && !tasksData) || (analyticsLoading && !analytics)) {
    return <LoadingState label="Loading Time Planner & Productivity Analytics…" />;
  }

  if (tasksErr || analyticsErr) {
    return <ErrorState error={tasksErr || analyticsErr} onRetry={() => { reloadTasks(); reloadAnalytics(); }} />;
  }

  const plannedScreenMins = analytics?.plannedScreenTimeMinutes ?? null;
  const actualScreenMins = analytics?.actualScreenTimeMinutes || analytics?.realActiveMinutes || 0;

  const plannedProductiveMins = analytics?.plannedProductiveMinutes ?? null;
  const actualProductiveMins = analytics?.actualProductiveMinutes ?? null;

  const completedCount = analytics?.completedTaskCount ?? 0;
  const pendingCount = analytics?.pendingTaskCount ?? (tasks.length - completedCount);
  const completionRate = analytics?.goalCompletionPercent ?? (tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0);

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Work & Shift Focus Planner"
          description="Enterprise daily screen-time goals, scheduled focus sessions, and planned vs. actual time comparison."
        />
        <div className="flex items-center gap-2">
          {!activeFocus ? (
            <>
              <Button onClick={() => handleStartFocus(25)} disabled={busy} className="bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs">
                Start 25m Focus Block
              </Button>
              <Button onClick={() => handleStartFocus(50)} disabled={busy} className="text-xs">
                50m Focus Block
              </Button>
            </>
          ) : (
            <Button onClick={handleStopFocus} disabled={busy} className="bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs">
              End Active Focus Session
            </Button>
          )}
        </div>
      </div>

      {/* Focus Mode Banner */}
      {activeFocus && (
        <div className="my-4 rounded-xl bg-gradient-to-r from-sky-950/80 to-indigo-950/80 border border-sky-500/30 p-5 backdrop-blur flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="relative flex h-4 w-4">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-4 w-4 bg-sky-500"></span>
            </span>
            <div>
              <h3 className="text-base font-bold text-white">{activeFocus.title} Active</h3>
              <p className="text-xs text-sky-200/80 mt-0.5">
                Target: {activeFocus.durationMinutes}m &bull; Expires at {new Date(activeFocus.expiresAt).toLocaleTimeString()} &bull; Distracting apps monitored
              </p>
            </div>
          </div>
          <Button onClick={handleStopFocus} disabled={busy} className="text-xs">
            Complete Session
          </Button>
        </div>
      )}

      {/* SECTION 2: PLANNED VS ACTUAL PRODUCTIVITY VISIBILITY (6 KPI CARDS) */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 my-6">
        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Planned Screen</p>
          <p className="mt-1 text-xl font-bold font-mono text-slate-100">
            {plannedScreenMins == null ? '—' : formatDuration(plannedScreenMins * 60)}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">Daily target limit</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Actual Screen</p>
          <p className="mt-1 text-xl font-bold font-mono text-sky-400">
            {formatDuration(actualScreenMins * 60)}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">Logged by agent</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Planned Productive</p>
          <p className="mt-1 text-xl font-bold font-mono text-slate-100">
            {plannedProductiveMins == null ? '—' : formatDuration(plannedProductiveMins * 60)}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">Tasks target total</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Actual Productive</p>
          <p className="mt-1 text-xl font-bold font-mono text-emerald-400">
            {actualProductiveMins == null ? '—' : formatDuration(actualProductiveMins * 60)}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">Coding & work apps</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Task Status</p>
          <p className="mt-1 text-xl font-bold font-mono text-white">
            <span className="text-emerald-400">{completedCount}</span> / {tasks.length}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">{pendingCount} pending today</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Adherence Rate</p>
          <p className="mt-1 text-xl font-bold font-mono text-purple-400">
            {completionRate}%
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">Goal adherence</p>
        </div>
      </div>

      {/* PLANNED VS. ACTUAL COMPARISON CHART */}
      <Card title="Planned vs. Actual Time Comparison">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Total Screen Time Bar */}
          <div className="rounded-xl bg-white/[0.02] border border-white/5 p-4 space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-slate-200">Total Screen Time Adherence</span>
              <span className="font-mono text-slate-400">
                {plannedScreenMins == null
                  ? 'No configured screen-time target'
                  : <><strong className={actualScreenMins > plannedScreenMins ? 'text-rose-400' : 'text-sky-400'}>{formatDuration(actualScreenMins * 60)}</strong> / {formatDuration(plannedScreenMins * 60)}</>}
              </span>
            </div>
            <div className="h-3 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  actualScreenMins > plannedScreenMins ? 'bg-rose-500' : 'bg-sky-500'
                }`}
                style={{ width: plannedScreenMins == null ? '0%' : `${Math.min(100, Math.round((actualScreenMins / (plannedScreenMins || 1)) * 100))}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500">
              {plannedScreenMins == null ? 'Configure a target to compare recorded activity.' : actualScreenMins > plannedScreenMins
                ? `Exceeded screen-time allocation by ${formatDuration((actualScreenMins - plannedScreenMins) * 60)}`
                : `${formatDuration((plannedScreenMins - actualScreenMins) * 60)} available within daily target`}
            </p>
          </div>

          {/* Productive Work Time Bar */}
          <div className="rounded-xl bg-white/[0.02] border border-white/5 p-4 space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-slate-200">Productive Goal Attainment</span>
              <span className="font-mono text-slate-400">
                {actualProductiveMins == null || plannedProductiveMins == null ? 'Productive time attribution is unavailable' : <><strong className="text-emerald-400">{formatDuration(actualProductiveMins * 60)}</strong> / {formatDuration(plannedProductiveMins * 60)}</>}
              </span>
            </div>
            <div className="h-3 w-full rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                style={{ width: actualProductiveMins == null || plannedProductiveMins == null ? '0%' : `${Math.min(100, Math.round((actualProductiveMins / (plannedProductiveMins || 1)) * 100))}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500">
              DigitalPulse does not infer task completion from application or website usage.
            </p>
          </div>
        </div>
      </Card>

      {/* DAILY SCHEDULE TIMELINE (Planned vs. Actual Device Activity) */}
      <div className="my-6">
        <Card title="Daily Schedule Timeline (Planned Blocks vs. Measured Device Activity)">
          <div className="flex items-center gap-6 mb-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-indigo-500/40 border border-indigo-400"></span>
              <span className="text-slate-300">Planned Schedule Block</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-emerald-500"></span>
              <span className="text-slate-300">Measured Device Activity (Agent Telemetry)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-slate-700"></span>
              <span className="text-slate-500">Idle / Off-screen</span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-7 sm:grid-cols-14 gap-1.5">
              {timeline.map((slot) => {
                const actualHeight = Math.min(100, Math.round((slot.actualMinutes / 60) * 100));
                const plannedHeight = Math.min(100, Math.round((slot.plannedMinutes / 60) * 100));

                return (
                  <div key={slot.hour} className="flex flex-col items-center bg-white/[0.02] p-2 rounded-lg border border-white/5">
                    <div className="h-20 w-full flex items-end justify-center gap-1">
                      {/* Planned Bar */}
                      <div
                        className="w-2.5 rounded-t bg-indigo-500/40 border-t border-indigo-400"
                        style={{ height: `${Math.max(10, plannedHeight)}%` }}
                        title={`Planned: ${slot.plannedMinutes}m`}
                      />
                      {/* Actual Bar */}
                      <div
                        className={`w-2.5 rounded-t ${slot.actualMinutes > 0 ? 'bg-emerald-400' : 'bg-slate-700/50'}`}
                        style={{ height: `${Math.max(6, actualHeight)}%` }}
                        title={`Actual Activity: ${slot.actualMinutes}m`}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 mt-2 truncate">{slot.label}</span>
                    <span className="text-[9px] font-mono text-emerald-400">{slot.actualMinutes}m</span>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 text-center pt-2">
              Notice: Measured activity is captured by the endpoint telemetry agent, distinguishing actual keyboard/mouse time from self-reported task checkboxes.
            </p>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Daily Screen-Time Goals */}
        <Card title="Daily Screen-Time Goals">
          <div className="space-y-4">
            {goals.map((g) => {
              const actualMins = g.actualMinutes ?? 0;
              const maxMins = g.maxMinutesPerDay;
              const pct = Math.min(100, Math.round((actualMins / maxMins) * 100));
              const isExceeded = actualMins > maxMins;
              const isWarning = pct >= (g.warningThresholdPercent ?? 80);

              return (
                <div key={g.id || g.category} className="rounded-lg border border-white/5 bg-white/[0.02] p-4 space-y-2">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-semibold text-slate-200">{g.title}</span>
                    <span className="font-mono text-xs text-slate-400">
                      <strong className={isExceeded ? 'text-rose-400' : isWarning ? 'text-amber-400' : 'text-emerald-400'}>
                        {formatDuration(actualMins * 60)}
                      </strong>{' '}
                      / {formatDuration(maxMins * 60)}
                    </span>
                  </div>

                  <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        isExceeded ? 'bg-rose-500' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {isExceeded && (
                    <p className="text-xs text-rose-400">Daily limit exceeded by {formatDuration((actualMins - maxMins) * 60)}.</p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Task Management */}
        <Card title="Task & Productivity Planner">
          {/* Add Task Form */}
          <form onSubmit={handleCreateTask} className="mb-4 flex flex-wrap gap-2 border-b border-white/5 pb-4">
            <input
              type="text"
              placeholder="Add enterprise task (e.g. Code review, API endpoint, Sprint planning)..."
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              className="flex-1 min-w-[180px] rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-400 focus:outline-none"
            />
            <select
              value={newTaskCategory}
              onChange={(e) => setNewTaskCategory(e.target.value)}
              className="rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-300"
            >
              <option value="engineering">Engineering</option>
              <option value="operations">DevOps / Ops</option>
              <option value="review">Code Review</option>
              <option value="design">Design & UI</option>
              <option value="research">Research</option>
              <option value="meeting">Team Sync</option>
              <option value="work">General Work</option>
              <option value="study">Study</option>
            </select>
            <input
              type="number"
              min="5"
              max="360"
              value={newTaskMinutes}
              onChange={(e) => setNewTaskMinutes(e.target.value)}
              className="w-16 rounded-lg border border-white/10 bg-surface-900 px-2 py-1.5 text-xs text-center text-slate-100 font-mono"
              title="Target duration in minutes"
            />
            <Button type="submit" disabled={busy || !newTaskTitle.trim()} className="text-xs">
              Add Task
            </Button>
          </form>

          {tasks.length === 0 ? (
            <EmptyState title="No tasks added for today">
              Add your planned tasks above to track completion against actual application time.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className={`rounded-lg border p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition ${
                    task.completed
                      ? 'border-emerald-500/20 bg-emerald-950/10'
                      : 'border-white/5 bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={task.completed}
                      onChange={() => handleToggleTask(task.id, task.completed)}
                      className="h-4 w-4 rounded border-white/20 bg-surface-900 text-sky-500 focus:ring-0 cursor-pointer"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-semibold ${task.completed ? 'line-through text-slate-400' : 'text-slate-100'}`}>
                          {task.title}
                        </span>
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-white/5 text-slate-300">
                          {task.category}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-slate-400 mt-1 font-mono">
                        <span>Planned: <strong className="text-slate-200">{task.targetMinutes}m</strong></span>
                        <span>&bull;</span>
                        <span>Measured Active: <strong className="text-emerald-400">{task.actualRecordedMinutes || (task.completed ? task.targetMinutes : 0)}m</strong></span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 self-end sm:self-auto">
                    <div className="w-20 hidden sm:block">
                      <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-0.5">
                        <span>Progress</span>
                        <span>{task.progressPercent || (task.completed ? 100 : 0)}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-sky-500"
                          style={{ width: `${task.progressPercent || (task.completed ? 100 : 0)}%` }}
                        />
                      </div>
                    </div>

                    <button
                      onClick={() => handleDeleteTask(task.id)}
                      className="text-xs text-slate-500 hover:text-rose-400 px-1 transition"
                      title="Delete task"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
