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
  const { data: goalsData, error: goalsErr, loading: goalsLoading, reload: reloadGoals } = useApi(fetchGoals, { intervalMs: 5000 });
  const { data: sessionsData, error: sessionsErr, loading: sessionsLoading, reload: reloadSessions } = useApi(fetchSessions, { intervalMs: 3000 });
  const { data: analytics, error: analyticsErr, loading: analyticsLoading, reload: reloadAnalytics } = useApi(fetchAnalytics, { intervalMs: 5000 });

  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskCategory, setNewTaskCategory] = useState('study');
  const [newTaskMinutes, setNewTaskMinutes] = useState(30);
  const [busy, setBusy] = useState(false);

  const tasks = tasksData?.tasks ?? [];
  const goals = analytics?.goalComparisons ?? goalsData?.goals ?? [];
  const activeFocus = sessionsData?.activeSession;

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

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Family Time Planner"
          description="Daily screen-time goals, scheduled focus sessions, and planned vs. actual time comparison."
        />
        <div className="flex items-center gap-2">
          {!activeFocus ? (
            <>
              <Button onClick={() => handleStartFocus(25)} disabled={busy} className="bg-sky-600 hover:bg-sky-500 text-white font-medium">
                Start 25m Focus Block
              </Button>
              <Button onClick={() => handleStartFocus(50)} disabled={busy}>
                50m Focus Block
              </Button>
            </>
          ) : (
            <Button onClick={handleStopFocus} disabled={busy} className="bg-amber-600 hover:bg-amber-500 text-white font-medium">
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

      {/* Analytics: Planned vs. Actual Comparison Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 my-6">
        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Planned Task Time</p>
          <p className="mt-1 text-2xl font-bold text-slate-100">
            {formatDuration((analytics?.plannedTaskMinutes ?? 0) * 60)}
          </p>
          <p className="text-xs text-slate-400 mt-1">{analytics?.taskCount ?? 0} tasks planned</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Completed Task Time</p>
          <p className="mt-1 text-2xl font-bold text-emerald-400">
            {formatDuration((analytics?.completedTaskMinutes ?? 0) * 60)}
          </p>
          <p className="text-xs text-slate-400 mt-1">{analytics?.completedTaskCount ?? 0} completed</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Actual Active Usage</p>
          <p className="mt-1 text-2xl font-bold text-sky-400">
            {formatDuration((analytics?.realActiveMinutes ?? 0) * 60)}
          </p>
          <p className="text-xs text-slate-400 mt-1">Logged from desktop agent</p>
        </div>

        <div className="rounded-xl bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Task Completion Rate</p>
          <p className="mt-1 text-2xl font-bold text-purple-400">
            {analytics?.taskCount > 0 ? Math.round((analytics.completedTaskCount / analytics.taskCount) * 100) : 0}%
          </p>
          <p className="text-xs text-slate-400 mt-1">Goal adherence</p>
        </div>
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
              placeholder="Add new task (e.g. Science project)..."
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              className="flex-1 min-w-[180px] rounded-lg border border-white/10 bg-surface-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent-400 focus:outline-none"
            />
            <select
              value={newTaskCategory}
              onChange={(e) => setNewTaskCategory(e.target.value)}
              className="rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs text-slate-300"
            >
              <option value="study">Study</option>
              <option value="work">Work</option>
              <option value="reading">Reading</option>
              <option value="creative">Creative</option>
            </select>
            <input
              type="number"
              min="5"
              max="360"
              value={newTaskMinutes}
              onChange={(e) => setNewTaskMinutes(e.target.value)}
              className="w-16 rounded-lg border border-white/10 bg-surface-900 px-2 py-1.5 text-xs text-center text-slate-100"
              title="Target duration in minutes"
            />
            <Button type="submit" disabled={busy || !newTaskTitle.trim()}>
              Add Task
            </Button>
          </form>

          {tasksLoading && !tasksData && <LoadingState label="Loading tasks…" />}

          {!tasksLoading && tasks.length === 0 && (
            <EmptyState title="No tasks added for today">
              Add your planned tasks above to track completion against actual application time.
            </EmptyState>
          )}

          {tasks.length > 0 && (
            <ul className="divide-y divide-white/5">
              {tasks.map((task) => (
                <li key={task.id} className="py-2.5 flex items-center justify-between gap-3 group">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={task.completed}
                      onChange={() => handleToggleTask(task.id, task.completed)}
                      className="h-4 w-4 rounded border-white/20 bg-surface-900 text-emerald-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                    />
                    <div>
                      <p className={`text-sm ${task.completed ? 'line-through text-slate-500' : 'text-slate-200'}`}>
                        {task.title}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-white/5 text-slate-400">
                          {task.category}
                        </span>
                        <span className="text-xs text-slate-400 font-mono">
                          {task.targetMinutes}m target
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDeleteTask(task.id)}
                    className="text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition text-xs"
                    title="Delete task"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
