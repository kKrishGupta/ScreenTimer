import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

export default function WebsitesPage() {
  const fetchWebsites = useCallback((opts) => api.websites({}, opts), []);
  const { data, error, loading, reload } = useApi(fetchWebsites, { intervalMs: 60_000, staleTimeMs: 30_000 });

  const websites = data?.websites ?? [];
  const maxDuration = websites.length > 0 ? Math.max(...websites.map((w) => w.durationSeconds)) : 1;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Website Usage"
          description="Active time and visits per website domain (Chrome and Edge extensions)."
        />
        {websites.length > 0 && (
          <Button onClick={reload} className="self-start sm:self-auto">
            Refresh
          </Button>
        )}
      </div>

      <Card>
        {loading && !data && <LoadingState label="Loading website analytics…" />}
        {error && <ErrorState error={error} onRetry={reload} />}

        {!loading && !error && websites.length === 0 && (
          <EmptyState title="No website usage recorded">
            Install the DigitalPulse extension in Chrome or Edge. Only domain names are tracked.
            Page content, search queries and form data are never collected.
          </EmptyState>
        )}

        {websites.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th scope="col" className="py-3 px-4 w-12 text-center">#</th>
                  <th scope="col" className="py-3 px-4">Domain</th>
                  <th scope="col" className="py-3 px-4 w-1/3">Time Distribution</th>
                  <th scope="col" className="py-3 px-4 text-center">Visits</th>
                  <th scope="col" className="py-3 px-4 text-right">Total Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {websites.map((site, index) => {
                  const pct = Math.min(100, Math.round((site.durationSeconds / maxDuration) * 100));
                  return (
                    <tr key={site.domain} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 text-center text-xs font-mono text-slate-500">
                        {index + 1}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-100">
                        <span className="text-purple-300 font-mono">{site.domain}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-purple-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-slate-400 w-10 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center font-mono text-slate-300">
                        {site.visitCount}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-emerald-400 whitespace-nowrap">
                        {formatDuration(site.durationSeconds)}
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
