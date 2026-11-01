import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

export default function ApplicationsPage() {
  const fetchApps = useCallback((opts) => api.apps({}, opts), []);
  const { data, error, loading, reload } = useApi(fetchApps, { intervalMs: 5000 });

  const apps = data?.apps ?? [];
  const maxDuration = apps.length > 0 ? Math.max(...apps.map((a) => a.durationSeconds)) : 1;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Application Usage"
          description="Active foreground time and session count per application."
        />
        {apps.length > 0 && (
          <Button onClick={reload} className="self-start sm:self-auto">
            Refresh
          </Button>
        )}
      </div>

      <Card>
        {loading && !data && <LoadingState label="Loading application analytics…" />}
        {error && <ErrorState error={error} onRetry={reload} />}

        {!loading && !error && apps.length === 0 && (
          <EmptyState title="No application usage recorded">
            Start the DigitalPulse desktop agent. Each application you focus will appear here
            with its total active time.
          </EmptyState>
        )}

        {apps.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th scope="col" className="py-3 px-4 w-12 text-center">#</th>
                  <th scope="col" className="py-3 px-4">Application</th>
                  <th scope="col" className="py-3 px-4 w-1/3">Usage Distribution</th>
                  <th scope="col" className="py-3 px-4 text-center">Sessions</th>
                  <th scope="col" className="py-3 px-4 text-right">Total Active Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {apps.map((app, index) => {
                  const pct = Math.min(100, Math.round((app.durationSeconds / maxDuration) * 100));
                  return (
                    <tr key={app.name} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 text-center text-xs font-mono text-slate-500">
                        {index + 1}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-100">
                        <div>{app.name}</div>
                        {app.executable && app.executable !== app.name && (
                          <div className="text-xs text-slate-400 font-mono">{app.executable}</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-sky-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-slate-400 w-10 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center font-mono text-slate-300">
                        {app.sessionCount}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-emerald-400 whitespace-nowrap">
                        {formatDuration(app.durationSeconds)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
