import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function SchedulePage() {
  const loadEmployees = useCallback((opts) => api.employees({}, opts), []);
  const { data, error, loading, reload } = useApi(loadEmployees);
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState('');
  if (loading && !data) return <LoadingState label="Loading work schedules…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const employees = data?.employees ?? [];
  const draftFor = (employee) => drafts[employee.id] || {
    shiftStart: employee.shiftStart || '',
    shiftEnd: employee.shiftEnd || '',
    shiftTimezone: employee.shiftTimezone || '',
    workingDays: Array.isArray(employee.workingDays) ? employee.workingDays : [],
  };
  const change = (employee, field, value) => setDrafts((current) => ({ ...current, [employee.id]: { ...draftFor(employee), [field]: value } }));
  const save = async (employee) => {
    const draft = draftFor(employee);
    if (!draft.shiftStart || !draft.shiftEnd || !draft.shiftTimezone || draft.workingDays.length === 0) {
      setMessage(`Set start time, end time, time zone and at least one workday for ${employee.displayName}.`);
      return;
    }
    try {
      setBusyId(employee.id); setMessage('');
      await api.updateEmployee(employee.id, draft);
      setMessage(`Schedule saved for ${employee.displayName}.`);
      setDrafts((current) => { const next = { ...current }; delete next[employee.id]; return next; });
      reload();
    } catch (err) { setMessage(err.message || 'Could not save the schedule.'); }
    finally { setBusyId(null); }
  };
  return <div className="space-y-6">
    <PageHeader title="Work schedule" description="Set each employee’s working days, hours and time zone. Activity remains shown separately from scheduled time." />
    {message && <p role="status" className="text-sm text-sky-200">{message}</p>}
    {employees.length === 0 ? <EmptyState title="No employees yet">Invite an employee first. Their schedule can be set before or after they accept.</EmptyState> : (
      <div className="space-y-3">{employees.map((employee) => {
        const draft = draftFor(employee);
        return <section key={employee.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-white">{employee.displayName}</h2><p className="text-xs text-slate-400">{employee.department} · {employee.companyEmail}</p></div><Button disabled={busyId === employee.id} onClick={() => save(employee)}>{busyId === employee.id ? 'Saving…' : 'Save schedule'}</Button></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-400">Start<input type="time" value={draft.shiftStart} onChange={(e) => change(employee, 'shiftStart', e.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
            <label className="text-xs text-slate-400">End<input type="time" value={draft.shiftEnd} onChange={(e) => change(employee, 'shiftEnd', e.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
            <label className="text-xs text-slate-400">Time zone<input value={draft.shiftTimezone} onChange={(e) => change(employee, 'shiftTimezone', e.target.value)} placeholder="America/New_York" className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">{DAYS.map((day) => { const active = draft.workingDays.includes(day); return <button key={day} type="button" aria-pressed={active} onClick={() => change(employee, 'workingDays', active ? draft.workingDays.filter((d) => d !== day) : [...draft.workingDays, day])} className={`rounded-lg border px-3 py-1.5 text-xs ${active ? 'border-sky-400/50 bg-sky-400/10 text-sky-200' : 'border-white/10 text-slate-500'}`}>{day}</button>; })}</div>
        </section>;
      })}</div>
    )}
  </div>;
}
