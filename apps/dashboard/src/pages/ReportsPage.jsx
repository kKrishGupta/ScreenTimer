import { useCallback, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysBefore = (date, days) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };

export default function ReportsPage() {
  const [endDate, setEndDate] = useState(today);
  const [startDate, setStartDate] = useState(() => daysBefore(today(), 6));
  const [employeeId, setEmployeeId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [reportError, setReportError] = useState('');

  const loadEmployees = useCallback((opts) => api.employees({}, opts), []);
  const loadDaily = useCallback((opts) => api.dailyAnalytics({ date: endDate, employeeId: employeeId || undefined }, opts), [endDate, employeeId]);
  const loadWeekly = useCallback((opts) => api.weeklyAnalytics({ startDate, endDate, employeeId: employeeId || undefined }, opts), [startDate, endDate, employeeId]);
  const loadApps = useCallback((opts) => api.apps({ from: `${startDate}T00:00:00.000Z`, to: `${endDate}T23:59:59.999Z`, userId: employeeId || undefined }, opts), [startDate, endDate, employeeId]);
  const loadWebsites = useCallback((opts) => api.websites({ from: `${startDate}T00:00:00.000Z`, to: `${endDate}T23:59:59.999Z`, userId: employeeId || undefined }, opts), [startDate, endDate, employeeId]);

  const { data: employeeData } = useApi(loadEmployees);
  const { data: daily, error: dailyError, loading: dailyLoading, reload: reloadDaily } = useApi(loadDaily);
  const { data: weekly, error: weeklyError, loading: weeklyLoading, reload: reloadWeekly } = useApi(loadWeekly);
  const { data: appsData } = useApi(loadApps);
  const { data: sitesData } = useApi(loadWebsites);
  const employees = employeeData?.employees ?? [];
  const selectedEmployee = employees.find((employee) => employee.id === employeeId);
  const apps = appsData?.apps ?? [];
  const websites = sitesData?.websites ?? [];
  const weekDays = weekly?.days ?? [];
  const maxActiveMinutes = Math.max(1, ...weekDays.map((day) => day.totalActiveMinutes || 0));
  const scheduledMinutes = useMemo(() => {
    if (!selectedEmployee) return null;
    if (!selectedEmployee.shiftStart || !selectedEmployee.shiftEnd || !selectedEmployee.shiftTimezone || !selectedEmployee.workingDays?.length) return null;
    const toMinutes = (time) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
    const shiftMinutes = Math.max(0, toMinutes(selectedEmployee.shiftEnd) - toMinutes(selectedEmployee.shiftStart));
    let total = 0;
    for (let day = new Date(`${startDate}T00:00:00Z`); day <= new Date(`${endDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
      const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getUTCDay()];
      if ((selectedEmployee.workingDays || []).includes(weekday)) total += shiftMinutes;
    }
    return total;
  }, [selectedEmployee, startDate, endDate]);

  const exportCsv = async () => {
    try {
      setExporting(true); setReportError('');
      const blob = await api.exportActivityCsv({ startDate, endDate, employeeId: employeeId || undefined });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = href; link.download = `digitalpulse-${startDate}-to-${endDate}.csv`; link.click();
      URL.revokeObjectURL(href);
    } catch (error) { setReportError(error.message || 'CSV export failed.'); }
    finally { setExporting(false); }
  };

  if (dailyLoading && !daily) return <LoadingState label="Loading activity report…" />;
  if (dailyError) return <ErrorState error={dailyError} onRetry={() => { reloadDaily(); reloadWeekly(); }} />;

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <PageHeader title="Activity reports" description="Review database-recorded active and idle time, application and website usage, and daily trends." />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">Employee<select aria-label="Filter reports by employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="mt-1 block rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-white"><option value="">All accessible employees</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
        <label className="text-xs text-slate-400">From<input aria-label="Report start date" type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 block rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">To<input aria-label="Report end date" type="date" value={endDate} min={startDate} max={today()} onChange={(e) => setEndDate(e.target.value)} className="mt-1 block rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-sm text-white" /></label>
        <Button onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</Button>
      </div>
    </div>
    {reportError && <p role="alert" className="text-sm text-rose-300">{reportError}</p>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[
        ['Scheduled time', scheduledMinutes == null ? (selectedEmployee ? 'Not configured' : 'Select an employee') : formatDuration(scheduledMinutes * 60), 'Schedule'],
        ['Active time', daily ? formatDuration(daily.totalActiveMinutes * 60) : 'No data', 'Recorded activity'],
        ['Idle time', daily ? formatDuration(daily.totalIdleMinutes * 60) : 'No data', 'Windows idle events'],
        ['Monitored time', daily ? formatDuration((daily.totalActiveMinutes + daily.totalIdleMinutes) * 60) : 'No data', 'Active plus idle'],
      ].map(([label, value, note]) => <Card key={label}><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 text-xl font-semibold text-white">{value}</p><p className="mt-1 text-xs text-slate-500">{note}</p></Card>)}
    </div>

    <Card title="Daily active-time trend">
      {weekly?.summary && <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300"><span>Range active <strong className="font-mono text-white">{formatDuration(weekly.summary.totalWeeklyActiveMinutes * 60)}</strong></span><span>Range idle <strong className="font-mono text-white">{formatDuration(weekly.summary.totalWeeklyIdleMinutes * 60)}</strong></span><span>Range monitored <strong className="font-mono text-white">{formatDuration(weekly.summary.totalWeeklyMonitoredMinutes * 60)}</strong></span></div>}
      {weeklyLoading ? <p className="text-sm text-slate-400">Loading trend…</p> : weekDays.length === 0 ? <EmptyState title="No historical activity">Recorded daily activity will appear here when enrolled devices send events.</EmptyState> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">{weekDays.map((day) => <div key={day.date} className="rounded-lg border border-white/5 bg-white/[0.02] p-3"><p className="text-xs text-slate-400">{day.date}</p><div className="my-3 h-2 rounded bg-white/5"><div className="h-2 rounded bg-sky-400" style={{ width: `${Math.max(day.totalActiveMinutes ? 4 : 0, Math.round(day.totalActiveMinutes / maxActiveMinutes * 100))}%` }} /></div><p className="text-sm font-semibold text-white">{formatDuration(day.totalActiveMinutes * 60)}</p></div>)}</div>}
      {weeklyError && <p role="alert" className="mt-3 text-sm text-rose-300">{weeklyError.message}</p>}
    </Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={`Applications · ${startDate} to ${endDate}`}>
        {apps.length === 0 ? <EmptyState title="No application data">No foreground application events were recorded in this range.</EmptyState> : <div className="divide-y divide-white/5">{apps.slice(0, 10).map((app) => <div key={app.name || app.application} className="flex items-center justify-between py-2 text-sm"><span className="text-slate-200">{app.name || app.application}</span><span className="font-mono text-slate-400">{formatDuration(app.durationSeconds || 0)}</span></div>)}</div>}
      </Card>
      <Card title={`Websites · ${startDate} to ${endDate}`}>
        {websites.length === 0 ? <EmptyState title="No website data">No browser domain events were recorded in this range.</EmptyState> : <div className="divide-y divide-white/5">{websites.slice(0, 10).map((site) => <div key={site.domain} className="flex items-center justify-between py-2 text-sm"><span className="text-slate-200">{site.domain}</span><span className="font-mono text-slate-400">{formatDuration(site.durationSeconds || 0)}</span></div>)}</div>}
      </Card>
    </div>
  </div>;
}
