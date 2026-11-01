import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useApi } from '../hooks/useApi.js';
import { Button, Card, PageHeader } from '../components/ui/Card.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States.jsx';

function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return isoString;
  }
}

function CollectorBadge({ kind, browser }) {
  if (kind === 'desktop_agent') {
    return (
      <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Windows Desktop Agent
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-400 ring-1 ring-inset ring-sky-500/20">
      Browser Extension ({browser || 'Web'})
    </span>
  );
}

export default function DevicesPage() {
  const fetchDevices = useCallback((opts) => api.devices(opts), []);
  const { data, error, loading, reload } = useApi(fetchDevices, { intervalMs: 5000 });

  const devices = data?.devices ?? [];

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <PageHeader
          title="Device Status"
          description="Desktop agent and browser extension collectors registered locally."
        />
        {devices.length > 0 && (
          <Button onClick={reload} className="self-start sm:self-auto">
            Refresh
          </Button>
        )}
      </div>

      <Card>
        {loading && !data && <LoadingState label="Loading registered collectors…" />}
        {error && <ErrorState error={error} onRetry={reload} />}

        {!loading && !error && devices.length === 0 && (
          <EmptyState title="No collectors have connected yet">
            Devices register automatically the first time the desktop agent or browser extension
            synchronises with the local backend.
          </EmptyState>
        )}

        {devices.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {devices.map((device) => (
              <div
                key={device.id}
                className="rounded-lg border border-white/10 bg-white/[0.02] p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-100">{device.name}</h3>
                    <p className="text-xs text-slate-400 font-mono mt-0.5">{device.platform}</p>
                  </div>
                  <CollectorBadge kind={device.kind} browser={device.browser} />
                </div>

                <div className="border-t border-white/5 pt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Device ID</span>
                    <span className="font-mono text-slate-300 truncate max-w-[200px]" title={device.id}>
                      {device.id}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Version</span>
                    <span className="text-slate-300 font-mono">{device.agentVersion || '0.1.0'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">First Connected</span>
                    <span className="text-slate-300">{formatDate(device.createdAt)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
