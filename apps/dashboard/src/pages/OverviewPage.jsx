import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

function HealthCard() {
  const { data, error, loading, reload } = useApi(api.health, { intervalMs: 10000 });
  if (loading && !data) return <LoadingState label="Checking backend…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const rows = [
    ['API status', data.status === 'ok' ? 'Online' : 'Degraded'],
    ['Database', data.database.status === 'up' ? `Connected (${data.database.latencyMs} ms)` : 'Unreachable'],
    ['Backend version', data.version],
    ['Backend uptime', formatDuration(data.uptimeSeconds)],
    ['Server time (UTC)', data.time],
  ];
  return (
    <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2" data-testid="health-details">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 border-b border-white/5 pb-2">
          <dt className="text-slate-400">{label}</dt>
          <dd className="text-right font-medium text-slate-200">{value}</dd>
        </div>
      ))}
      {data.database.error && (
        <p className="text-xs text-amber-300 sm:col-span-2">{data.database.error}</p>
      )}
      <div className="sm:col-span-2">
        <Button onClick={reload}>Refresh</Button>
      </div>
    </dl>
  );
}

function ActivitySummaryCard() {
  const fetchSummary = useCallback((opts) => api.summary({}, opts), []);
  const { data, error, loading, reload } = useApi(fetchSummary, { intervalMs: 5000 });

  if (loading && !data) return <LoadingState label="Loading activity summary…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const hasActivity = data && (data.totalActiveSeconds > 0 || data.totalIdleSeconds > 0 || data.totalEvents > 0);

  if (!hasActivity) {
    return (
      <EmptyState title="No activity recorded yet">
        Start the DigitalPulse desktop agent and install the Chrome or Edge extension to begin
        collecting activity. Active time, idle time, and top applications and websites will
        appear here once real events reach the backend.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Total Active</p>
          <p className="mt-1 text-2xl font-bold text-emerald-400">{formatDuration(data.totalActiveSeconds)}</p>
        </div>
        <div className="rounded-lg bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Total Idle</p>
          <p className="mt-1 text-2xl font-bold text-amber-400">{formatDuration(data.totalIdleSeconds)}</p>
        </div>
        <div className="rounded-lg bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Top Application</p>
          <p className="mt-1 text-lg font-semibold text-sky-300 truncate" title={data.topApp?.name ?? '—'}>
            {data.topApp?.name ?? '—'}
          </p>
          {data.topApp && (
            <p className="text-xs text-slate-400">{formatDuration(data.topApp.durationSeconds)}</p>
          )}
        </div>
        <div className="rounded-lg bg-white/[0.03] p-4 border border-white/5">
          <p className="text-xs uppercase font-medium tracking-wider text-slate-400">Top Domain</p>
          <p className="mt-1 text-lg font-semibold text-purple-300 truncate" title={data.topDomain?.domain ?? '—'}>
            {data.topDomain?.domain ?? '—'}
          </p>
          {data.topDomain && (
            <p className="text-xs text-slate-400">{formatDuration(data.topDomain.durationSeconds)}</p>
          )}
        </div>
      </div>
      <div className="flex justify-between items-center text-xs text-slate-400 border-t border-white/5 pt-3">
        <span>Recorded sessions: <strong className="text-slate-200">{data.totalEvents}</strong></span>
        <Button onClick={reload}>Refresh</Button>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Today's digital activity on this computer." />
      <div className="grid gap-6">
        <Card title="Today's activity">
          <ActivitySummaryCard />
        </Card>
        <Card title="System health">
          <HealthCard />
        </Card>
      </div>
    </>
  );
}
