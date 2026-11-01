import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

function HealthCard() {
  const { data, error, loading, reload } = useApi(api.health);
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

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Today's digital activity on this computer." />
      <div className="grid gap-6">
        <Card title="System health">
          <HealthCard />
        </Card>
        <Card title="Today's activity">
          <EmptyState title="No activity recorded yet">
            Start the DigitalPulse desktop agent and install the Chrome or Edge extension to begin
            collecting activity. Active time, idle time, and top applications and websites will
            appear here once real events reach the backend.
          </EmptyState>
        </Card>
      </div>
    </>
  );
}

