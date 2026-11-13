import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';

const STYLES = {
  ok: { dot: 'bg-emerald-400', text: 'Backend online' },
  degraded: { dot: 'bg-amber-400', text: 'Database unreachable' },
  offline: { dot: 'bg-rose-500', text: 'Backend offline' },
  unknown: { dot: 'bg-amber-400', text: 'Backend status unavailable' },
  loading: { dot: 'bg-slate-500 animate-pulse', text: 'Connecting…' },
};

export function backendStatusKey({ data, error, loading }) {
  if (loading && !data) return 'loading';
  if (error) {
    if (error.code === 'CANCELED') return data?.status ?? 'unknown';
    if (error.code === 'BACKEND_OFFLINE') return 'offline';
    if (error.code === 'NETWORK_ERROR' && !data) return 'offline';
    return 'unknown';
  }
  return data?.status ?? 'unknown';
}

/** Shared backend connectivity indicator, paused while hidden or offline. */
export default function BackendStatus() {
  const { data, error, loading } = useApi(api.health, {
    intervalMs: 90_000,
    staleTimeMs: 60_000,
    queryKey: 'backend-health',
  });
  const key = backendStatusKey({ data, error, loading });
  const style = STYLES[key] ?? STYLES.unknown;
  return (
    <div
      className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300"
      title={data?.database?.error ?? error?.message ?? ''}
      data-testid="backend-status"
    >
      <span className={`h-2 w-2 rounded-full ${style.dot}`} />
      {style.text}
    </div>
  );
}

