import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';
import { formatDuration } from '../lib/format.js';

function formatTime(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return isoString;
  }
}

function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function TypeBadge({ type }) {
  switch (type) {
    case 'app_session':
      return (
        <span className="inline-flex items-center rounded-md bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-400 ring-1 ring-inset ring-sky-500/20">
          Application
        </span>
      );
    case 'web_session':
      return (
        <span className="inline-flex items-center rounded-md bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-400 ring-1 ring-inset ring-purple-500/20">
          Website
        </span>
      );
    case 'idle_session':
      return (
        <span className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
          Idle
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-md bg-slate-500/10 px-2 py-0.5 text-xs font-medium text-slate-400">
          {type}
        </span>
      );
  }
}

export default function TimelinePage() {
  const fetchTimeline = useCallback((opts) => api.timeline({ limit: 100 }, opts), []);
  const { data, error, loading, reload } = useApi(fetchTimeline, { intervalMs: 15000 });

  const events = data?.events ?? [];

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Activity Timeline"
          description="Application, website and idle activity synchronized with the backend."
        />
        {events.length > 0 && (
          <Button onClick={reload} className="self-start sm:self-auto">
            Refresh Timeline
          </Button>
        )}
      </div>

      <Card>
        {loading && !data && <LoadingState label="Loading timeline…" />}
        {error && <ErrorState error={error} onRetry={reload} />}

        {!loading && !error && events.length === 0 && (
          <EmptyState title="No timeline entries yet">
            Timeline entries appear when the desktop agent or browser extension sends activity to
            the backend. Start the authorized desktop agent to begin recording.
          </EmptyState>
        )}

        {events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th scope="col" className="py-3 px-4">Time</th>
                  <th scope="col" className="py-3 px-4">Type</th>
                  <th scope="col" className="py-3 px-4">Activity Name</th>
                  <th scope="col" className="py-3 px-4">Details</th>
                  <th scope="col" className="py-3 px-4 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {events.map((ev) => {
                  const activityName =
                    ev.type === 'app_session'
                      ? ev.app?.name || 'Unknown Application'
                      : ev.type === 'web_session'
                      ? ev.web?.domain || 'Unknown Domain'
                      : 'System Idle';

                  const detail =
                    ev.type === 'app_session'
                      ? ev.app?.executable ? `PID: ${ev.app.processId ?? 'N/A'}` : '—'
                      : ev.type === 'web_session'
                      ? `Browser: ${ev.web?.browser || 'web'}`
                      : 'No input detected';

                  return (
                    <tr key={ev.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 whitespace-nowrap text-xs text-slate-400">
                        <span>{formatDate(ev.startedAt)} </span>
                        <span className="font-mono text-slate-200">{formatTime(ev.startedAt)}</span>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <TypeBadge type={ev.type} />
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-100 whitespace-nowrap">
                        {activityName}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-400 whitespace-nowrap">
                        {detail}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-emerald-400 whitespace-nowrap">
                        {formatDuration(ev.durationSeconds)}
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
