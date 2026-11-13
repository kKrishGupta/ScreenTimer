import { useCallback } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

const ACTIVITY_REFRESH_MS = 60_000;
const DIRECTORY_REFRESH_MS = 3 * 60_000;
const today = () => new Date().toISOString().slice(0, 10);

function MetricCard({ label, value, detail, loading, error, to }) {
  const shownValue = error ? 'Unavailable' : loading && value == null ? '—' : value ?? '—';
  const contents = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-white">{shownValue}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </>
  );
  return to ? <Link to={to} aria-label={`${label}: ${shownValue}. ${detail}`} className="rounded-xl border border-white/5 bg-surface-900/80 p-4 transition hover:border-sky-400/30 hover:bg-surface-900">{contents}</Link> : <div className="rounded-xl border border-white/5 bg-surface-900/80 p-4">{contents}</div>;
}

function statusStyle(status) {
  switch (String(status || '').toUpperCase()) {
    case 'WORKING': return 'bg-emerald-400/10 text-emerald-300';
    case 'IDLE': return 'bg-amber-400/10 text-amber-200';
    case 'CONNECTED':
    case 'ONLINE': return 'bg-sky-400/10 text-sky-200';
    case 'REVOKED': return 'bg-rose-400/10 text-rose-200';
    case 'NOT_ENROLLED':
    case 'PENDING_ENROLLMENT': return 'bg-violet-400/10 text-violet-200';
    default: return 'bg-slate-400/10 text-slate-300';
  }
}

function formatWhen(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}

function EmployeeActivity({ data, loading, error }) {
  if (loading && !data) return <LoadingState label="Loading employee activity…" />;
  if (error) return <ErrorState error={error} />;

  const employees = data?.employees || [];
  const summary = data?.summary;
  if (employees.length === 0) {
    return <EmptyState title="No employees in this reporting scope">
      <p>Create or invite an employee to begin onboarding.</p>
      <Link className="mt-3 inline-flex rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white" to="/employees">Open employee directory</Link>
    </EmptyState>;
  }

  const activityEligible = (summary?.activeCount || 0) + (summary?.idleCount || 0);
  const activeWidth = activityEligible > 0 ? (summary.activeCount / activityEligible) * 100 : 0;
  return <div className="space-y-4">
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
        <span>Recent device activity</span>
        <span>{summary?.activeCount ?? '—'} working · {summary?.idleCount ?? '—'} idle</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/5" role="img" aria-label={`${summary?.activeCount ?? 'Unavailable'} employees working and ${summary?.idleCount ?? 'unavailable'} idle`}>
        <div className="bg-emerald-400 transition-[width]" style={{ width: `${activeWidth}%` }} />
        <div className="bg-amber-300 transition-[width]" style={{ width: `${activityEligible ? 100 - activeWidth : 0}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">Working and idle labels require a recent event from a device with a valid heartbeat. They describe observed activity, not productivity.</p>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left text-sm">
        <thead><tr className="border-b border-white/5 text-xs uppercase tracking-wide text-slate-500"><th className="py-2 pr-4 font-medium">Employee</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 pr-4 font-medium">Current activity</th><th className="py-2 text-right font-medium">Active today</th></tr></thead>
        <tbody className="divide-y divide-white/5">
          {employees.slice(0, 8).map((employee) => {
            const status = String(employee.liveStatus || 'OFFLINE').toUpperCase();
            const activity = status === 'WORKING' || status === 'IDLE'
              ? [employee.currentApplication !== 'None' ? employee.currentApplication : null, employee.currentDomain !== 'None' ? employee.currentDomain : null].filter(Boolean).join(' · ') || 'No foreground target reported'
              : status === 'CONNECTED' ? 'Connected · no recent activity' : status === 'NOT_ENROLLED' ? 'No enrolled device' : status === 'REVOKED' ? 'Device access revoked' : 'No recent device heartbeat';
            return <tr key={employee.id}>
              <td className="py-3 pr-4"><Link className="font-medium text-white hover:text-sky-300" to="/employees">{employee.displayName}</Link><span className="mt-0.5 block text-xs text-slate-500">{employee.department || 'Department not set'}</span></td>
              <td className="py-3 pr-4"><span className={`inline-flex rounded-full px-2 py-1 text-xs ${statusStyle(status)}`}>{status.replaceAll('_', ' ')}</span></td>
              <td className="max-w-[260px] truncate py-3 pr-4 text-slate-300" title={activity}>{activity}</td>
              <td className="py-3 text-right tabular-nums text-slate-200">{formatDuration(Number(employee.activeSecondsToday || 0))}</td>
            </tr>;
          })}
        </tbody>
      </table>
      {employees.length > 8 && <Link className="mt-3 inline-block text-sm text-sky-300 hover:text-sky-200" to="/employees">View all {employees.length} employees</Link>}
    </div>
  </div>;
}

function UsageList({ title, rows, loading, error, totalSeconds, nameKey }) {
  if (loading && !rows) return <LoadingState label={`Loading ${title.toLowerCase()}…`} />;
  if (error) return <ErrorState error={error} />;
  if (!rows?.length) return <EmptyState title={`No ${title.toLowerCase()} data today`}>Authorized device events will appear here after they are received and stored.</EmptyState>;

  const total = totalSeconds || rows.reduce((sum, row) => sum + Number(row.durationSeconds || row.totalSeconds || 0), 0);
  return <ol className="space-y-3">
    {rows.slice(0, 5).map((row, index) => {
      const seconds = Number(row.durationSeconds || row.totalSeconds || 0);
      const width = total > 0 ? Math.max(2, Math.round((seconds / total) * 100)) : 0;
      return <li key={`${row[nameKey]}-${index}`}>
        <div className="mb-1 flex items-center justify-between gap-3 text-sm"><span className="truncate text-slate-200" title={row[nameKey]}>{row[nameKey]}</span><span className="shrink-0 font-mono text-xs text-slate-400">{formatDuration(seconds)}</span></div>
        <div className="h-1.5 rounded-full bg-white/5"><div className="h-1.5 rounded-full bg-sky-400" style={{ width: `${width}%` }} /></div>
      </li>;
    })}
  </ol>;
}

function RecentActivity({ data, loading, error }) {
  if (loading && !data) return <LoadingState label="Loading recent events…" />;
  if (error) return <ErrorState error={error} />;
  const events = data?.events || [];
  if (!events.length) return <EmptyState title="No activity recorded yet">
    <p>Complete employee onboarding and connect a device to begin collecting authorized activity.</p>
    <div className="mt-3 flex flex-wrap justify-center gap-2"><Link className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white" to="/employees">Invite or set up employees</Link><Link className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200" to="/devices">Review device setup</Link></div>
  </EmptyState>;

  return <ol className="divide-y divide-white/5">
    {events.slice(0, 8).map((event) => {
      const type = String(event.type || '').toLowerCase();
      const target = type === 'idle_session' ? 'Idle time' : event.app?.name || event.application?.name || event.web?.domain || event.website?.domain || 'Activity session';
      const source = event.deviceName || (event.source === 'browser_extension' ? 'Browser extension' : 'Windows agent');
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
        <div className="min-w-0"><p className="truncate text-sm text-slate-200">{target}</p><p className="text-xs text-slate-500">{source} · {type.replaceAll('_', ' ') || 'event'}</p></div>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-slate-400"><span>{formatDuration(Number(event.durationSeconds || 0))}</span><time dateTime={event.startedAt}>{formatWhen(event.startedAt)}</time></div>
      </li>;
    })}
  </ol>;
}

function DeviceHealth({ data, loading, error }) {
  if (loading && !data) return <LoadingState label="Loading device health…" />;
  if (error) return <ErrorState error={error} />;

  const devices = data?.devices || [];
  const connected = devices.filter((device) => !device.isRevoked && device.status === 'online');
  const pending = devices.filter((device) => !device.isRevoked && !device.lastSeenAt);
  const offline = devices.filter((device) => !device.isRevoked && device.lastSeenAt && device.status !== 'online');
  const revoked = devices.filter((device) => device.isRevoked || device.status === 'revoked');
  const attention = pending.length + offline.length + revoked.length;

  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[['Connected', connected.length], ['Offline', offline.length], ['Pending first heartbeat', pending.length], ['Revoked', revoked.length]].map(([label, value]) => <div key={label} className="rounded-lg border border-white/5 bg-white/[0.02] p-3"><p className="text-xs text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-white">{value}</p></div>)}
    </div>
    {devices.length === 0 ? <EmptyState title="No enrolled devices">
      <p>Devices appear here only after secure enrollment. Invite an employee or review the setup guide.</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2"><Link className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white" to="/employees">Open employee directory</Link><Link className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200" to="/employee-setup">Read installation instructions</Link></div>
    </EmptyState> : <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead><tr className="border-b border-white/5 text-xs uppercase tracking-wide text-slate-500"><th className="py-2 pr-3 font-medium">Device</th><th className="py-2 pr-3 font-medium">Employee</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 pr-3 font-medium">Last heartbeat</th><th className="py-2 font-medium">Last successful sync</th></tr></thead>
        <tbody className="divide-y divide-white/5">{devices.slice(0, 8).map((device) => {
          const status = device.isRevoked || device.status === 'revoked' ? 'REVOKED' : device.status === 'online' ? 'CONNECTED' : device.lastSeenAt ? 'OFFLINE' : 'ENROLLMENT PENDING';
          return <tr key={device.id}><td className="py-3 pr-3"><span className="font-medium text-slate-200">{device.name || 'Unnamed device'}</span><span className="mt-0.5 block text-xs text-slate-500">{String(device.kind || 'device').replaceAll('_', ' ')}{device.browser ? ` · ${device.browser}` : ''}</span></td><td className="py-3 pr-3 text-slate-300">{device.assignedUser?.displayName || device.assignedUser?.email || 'Unassigned'}</td><td className="py-3 pr-3"><span className={`rounded-full px-2 py-1 text-xs ${statusStyle(status)}`}>{status.replaceAll('_', ' ')}</span></td><td className="py-3 pr-3 text-xs text-slate-400">{formatWhen(device.lastSeenAt)}</td><td className="py-3 text-xs text-slate-400">{formatWhen(device.lastSyncAt)}</td></tr>;
        })}</tbody>
      </table>
    </div>}
    <p className="text-xs text-slate-500">{attention ? `${attention} device${attention === 1 ? '' : 's'} need review. ` : ''}Failed sync attempts are not reported by agents yet; this view shows only backend-recorded successful sync times.</p>
  </div>;
}

function HealthCard() {
  const { data, error, loading, reload } = useApi(api.health, { intervalMs: 90_000, staleTimeMs: 60_000, queryKey: 'backend-health' });
  if (loading && !data) return <LoadingState label="Checking backend and database health…" />;
  if (error || data?.error) return <ErrorState error={error || new Error(data?.error?.message || 'Health status is unavailable')} onRetry={reload} />;
  if (!data) return <ErrorState error={new Error('No response from backend service.')} onRetry={reload} />;
  const rows = [
    ['API status', data.status === 'ok' ? 'Online' : 'Degraded'],
    ['Database', data.database?.status === 'up' ? `Connected (${data.database.latencyMs} ms)` : 'Unreachable'],
    ['Backend version', data.version ?? 'Unavailable'],
    ['Backend uptime', formatDuration(data.uptimeSeconds ?? 0)],
    ['Server time (UTC)', data.time ?? 'Unavailable'],
  ];
  return <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2" data-testid="health-details">
    {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-slate-400">{label}</dt><dd className="text-right font-medium text-slate-200">{value}</dd></div>)}
    {data.database?.error && <p className="text-xs text-amber-300 sm:col-span-2">{data.database.error}</p>}
    <div className="sm:col-span-2"><Button onClick={reload}>Refresh system health</Button></div>
  </dl>;
}

export default function OverviewPage() {
  const date = today();
  const loadEmployees = useCallback((opts) => api.employees({}, opts), []);
  const loadLive = useCallback((opts) => api.liveEmployees({}, opts), []);
  const loadInvitations = useCallback((opts) => api.invitations(opts), []);
  const loadDevices = useCallback((opts) => api.devices(opts), []);
  const loadSummary = useCallback((opts) => api.summary({ date }, opts), [date]);
  const loadApps = useCallback((opts) => api.apps({ date }, opts), [date]);
  const loadWebsites = useCallback((opts) => api.websites({ date }, opts), [date]);
  const loadTimeline = useCallback((opts) => api.timeline({ limit: 8, from: `${date}T00:00:00.000Z`, to: new Date().toISOString() }, opts), [date]);

  const employees = useApi(loadEmployees, { intervalMs: DIRECTORY_REFRESH_MS, staleTimeMs: 2 * 60_000, queryKey: 'employees-directory' });
  const live = useApi(loadLive, { intervalMs: ACTIVITY_REFRESH_MS, staleTimeMs: 30_000, queryKey: 'employees-live' });
  const invitations = useApi(loadInvitations, { intervalMs: DIRECTORY_REFRESH_MS, staleTimeMs: 2 * 60_000, queryKey: 'invitations' });
  const devices = useApi(loadDevices, { intervalMs: DIRECTORY_REFRESH_MS, staleTimeMs: 2 * 60_000, queryKey: 'devices' });
  const summary = useApi(loadSummary, { intervalMs: ACTIVITY_REFRESH_MS, staleTimeMs: 30_000, queryKey: ['activity-summary', date] });
  const apps = useApi(loadApps, { intervalMs: ACTIVITY_REFRESH_MS, staleTimeMs: 30_000, queryKey: ['activity-apps', date] });
  const websites = useApi(loadWebsites, { intervalMs: ACTIVITY_REFRESH_MS, staleTimeMs: 30_000, queryKey: ['activity-websites', date] });
  const timeline = useApi(loadTimeline, { intervalMs: ACTIVITY_REFRESH_MS, staleTimeMs: 30_000, queryKey: ['activity-timeline', date, 8] });

  const employeeRows = employees.data?.employees || [];
  const liveSummary = live.data?.summary;
  const invitationRows = invitations.data?.invitations || [];
  const pendingInvitations = invitationRows.filter((invitation) => invitation.status === 'pending').length;
  const deviceRows = devices.data?.devices || [];
  const pendingDevices = deviceRows.filter((device) => !device.isRevoked && !device.lastSeenAt).length;
  const offlineDevices = deviceRows.filter((device) => !device.isRevoked && device.lastSeenAt && device.status !== 'online').length;
  const revokedDevices = deviceRows.filter((device) => device.isRevoked || device.status === 'revoked').length;
  const devicesNeedingAttention = pendingDevices + offlineDevices + revokedDevices;
  const refreshAll = [employees.reload, live.reload, invitations.reload, devices.reload, summary.reload, apps.reload, websites.reload, timeline.reload];

  return <div className="space-y-6">
    <PageHeader title="Organization overview" description={`Authorized employee activity and endpoint health · ${date}`}>
      <Button onClick={() => refreshAll.forEach((reload) => reload())}>Refresh overview</Button>
    </PageHeader>

    <section aria-label="Organization summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <MetricCard label="Employees" value={employees.data ? employees.data.totalCount ?? employeeRows.length : null} detail="In your accessible directory" loading={employees.loading} error={employees.error} to="/employees" />
      <MetricCard label="Currently working" value={liveSummary?.activeCount} detail="Recent activity + valid heartbeat" loading={live.loading} error={live.error} to="/live" />
      <MetricCard label="Idle employees" value={liveSummary?.idleCount} detail="Recent idle event + valid heartbeat" loading={live.loading} error={live.error} to="/live" />
      <MetricCard label="Offline employees" value={liveSummary?.offlineCount} detail="No valid heartbeat in the last 5 minutes" loading={live.loading} error={live.error} to="/employees" />
      <MetricCard label="Pending invitations" value={invitations.data ? pendingInvitations : null} detail="Awaiting acceptance" loading={invitations.loading} error={invitations.error} to="/employees" />
      <MetricCard label="Devices needing attention" value={devices.data ? devicesNeedingAttention : null} detail={devices.data ? `${pendingDevices} awaiting first heartbeat · ${offlineDevices} offline · ${revokedDevices} revoked` : 'Enrollment and heartbeat issues'} loading={devices.loading} error={devices.error} to="/devices" />
    </section>

    {summary.data && summary.data.totalEvents === 0 && <div className="rounded-xl border border-sky-400/15 bg-sky-400/5 px-4 py-3 text-sm text-sky-100">
      No activity recorded yet. Complete employee onboarding and connect a device to begin collecting authorized activity. <Link className="ml-1 font-medium underline underline-offset-2" to="/employees">Go to employee setup</Link>.
    </div>}

    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,0.9fr)]">
      <Card title="Employee activity overview" action={<Link className="text-sm text-sky-300 hover:text-sky-200" to="/live">Open live activity</Link>}>
        <EmployeeActivity data={live.data} loading={live.loading} error={live.error} />
      </Card>
      <Card title="Device health" action={<Link className="text-sm text-sky-300 hover:text-sky-200" to="/devices">Manage devices</Link>}>
        <DeviceHealth data={devices.data} loading={devices.loading} error={devices.error} />
      </Card>
    </section>

    <section className="grid gap-4 xl:grid-cols-3">
      <Card title="Today's active and idle time">
        {summary.loading && !summary.data ? <LoadingState label="Loading today's activity…" /> : summary.error ? <ErrorState error={summary.error} onRetry={summary.reload} /> : summary.data ? <div className="space-y-4"><div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-white/[0.03] p-3"><p className="text-xs text-slate-400">Observed active time</p><p className="mt-1 text-xl font-semibold text-emerald-300">{formatDuration(summary.data.totalActiveSeconds || 0)}</p></div><div className="rounded-lg bg-white/[0.03] p-3"><p className="text-xs text-slate-400">Observed idle time</p><p className="mt-1 text-xl font-semibold text-amber-200">{formatDuration(summary.data.totalIdleSeconds || 0)}</p></div></div><p className="text-xs text-slate-500">Durations are unions of stored session intervals. Observed time is not a productivity score.</p><p className="text-xs text-slate-500">{summary.data.totalEvents || 0} persisted sessions · {summary.data.appSessionCount || 0} application · {summary.data.webSessionCount || 0} website</p></div> : <p className="text-sm text-slate-400">Today's activity summary is unavailable.</p>}
      </Card>
      <Card title="Today's application usage" action={<Link className="text-sm text-sky-300 hover:text-sky-200" to="/applications">View applications</Link>}>
        <UsageList title="Application" rows={apps.data?.apps} loading={apps.loading} error={apps.error} totalSeconds={apps.data?.totalSeconds} nameKey="name" />
      </Card>
      <Card title="Today's website usage" action={<Link className="text-sm text-sky-300 hover:text-sky-200" to="/websites">View websites</Link>}>
        <UsageList title="Website" rows={websites.data?.websites} loading={websites.loading} error={websites.error} totalSeconds={websites.data?.totalSeconds} nameKey="domain" />
      </Card>
    </section>

    <Card title="Recent activity timeline" action={<Link className="text-sm text-sky-300 hover:text-sky-200" to="/timeline">View full timeline</Link>}>
      <RecentActivity data={timeline.data} loading={timeline.loading} error={timeline.error} />
    </Card>

    <Card title="System health">
      <HealthCard />
    </Card>
  </div>;
}
