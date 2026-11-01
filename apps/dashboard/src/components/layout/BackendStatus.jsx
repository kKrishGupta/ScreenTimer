import { api } from '../../lib/api.js';
import { useApi } from '../../hooks/useApi.js';

const STYLES = {
  ok: { dot: 'bg-emerald-400', text: 'Backend online' },
  degraded: { dot: 'bg-amber-400', text: 'Database unreachable' },
  offline: { dot: 'bg-rose-500', text: 'Backend offline' },
  loading: { dot: 'bg-slate-500 animate-pulse', text: 'Connecting…' },
};

/** Live backend connectivity indicator, polled every 15 s from GET /api/v1/health. */
export default function BackendStatus() {
  const { data, error, loading } = useApi(api.health, { intervalMs: 15000 });
  const key = error ? 'offline' : loading && !data ? 'loading' : (data?.status ?? 'offline');
  const style = STYLES[key];
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

