import { useCallback, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { AlertIcon, BellIcon } from '../components/ui/icons.jsx';

export default function AlertsPage() {
  const fetchAlerts = useCallback((opts) => api.alerts(opts), []);
  const { data, error, loading, reload } = useApi(fetchAlerts, { intervalMs: 30_000, staleTimeMs: 15_000 });

  const [filterSeverity, setFilterSeverity] = useState('all');
  const [dismissedIds, setDismissedIds] = useState(new Set());

  const alerts = (data?.alerts ?? []).filter((a) => !dismissedIds.has(a.id));
  const filteredAlerts = alerts.filter((a) => (filterSeverity === 'all' ? true : a.severity === filterSeverity));

  const handleDismiss = async (alert) => {
    setDismissedIds((prev) => new Set([...prev, alert.id]));
    if (alert.type === 'policy_violation') {
      try {
        await api.acknowledgeViolation(alert.id);
      } catch {
        // safe fallback
      }
    }
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Alerts & Notification Center"
          description="Real-time household security notices, policy warnings, and digital wellbeing reminders."
        />
        <div className="flex items-center gap-2">
          <Button onClick={reload} className="text-xs">
            Refresh Alerts
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 my-6">
        <button
          onClick={() => setFilterSeverity('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            filterSeverity === 'all'
              ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30'
              : 'text-slate-400 hover:text-white bg-white/5'
          }`}
        >
          All Notifications ({alerts.length})
        </button>
        <button
          onClick={() => setFilterSeverity('warning')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            filterSeverity === 'warning'
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
              : 'text-slate-400 hover:text-white bg-white/5'
          }`}
        >
          Policy Warnings ({alerts.filter((a) => a.severity === 'warning').length})
        </button>
        <button
          onClick={() => setFilterSeverity('info')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            filterSeverity === 'info'
              ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
              : 'text-slate-400 hover:text-white bg-white/5'
          }`}
        >
          System Notices ({alerts.filter((a) => a.severity === 'info').length})
        </button>
      </div>

      <Card>
        {loading && !data && <LoadingState label="Loading alerts…" />}
        {error && <ErrorState error={error} onRetry={reload} />}

        {!loading && filteredAlerts.length === 0 && (
          <EmptyState title="All caught up!">
            There are no active policy alerts or system notifications.
          </EmptyState>
        )}

        {filteredAlerts.length > 0 && (
          <div className="divide-y divide-white/5">
            {filteredAlerts.map((item) => (
              <div key={item.id} className="py-4 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 grid h-8 w-8 place-items-center rounded-lg shrink-0 ${
                    item.severity === 'warning'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      : 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                  }`}>
                    {item.severity === 'warning' ? <AlertIcon width={16} height={16} /> : <BellIcon width={16} height={16} />}
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-slate-100">{item.title}</h4>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        item.severity === 'warning' ? 'bg-amber-500/10 text-amber-300' : 'bg-sky-500/10 text-sky-300'
                      }`}>
                        {item.severity.toUpperCase()}
                      </span>
                      <span className="text-xs text-slate-500 font-mono">
                        {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 mt-1">{item.description}</p>
                    {item.target && (
                      <p className="text-[11px] text-slate-500 font-mono mt-1">Target: {item.target}</p>
                    )}
                  </div>
                </div>

                <Button onClick={() => handleDismiss(item)} className="text-xs shrink-0">
                  Dismiss
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
