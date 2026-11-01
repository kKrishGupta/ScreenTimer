import { AlertIcon, InboxIcon } from './icons.jsx';
import { Button } from './Card.jsx';

export function EmptyState({ title, children, icon: Icon = InboxIcon }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 px-6 py-12 text-center"
    >
      <Icon width={32} height={32} className="mb-3 text-slate-500" />
      <h3 className="text-base font-medium text-slate-200">{title}</h3>
      {children && <div className="mt-2 max-w-md text-sm text-slate-400">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/5 px-6 py-10 text-center"
    >
      <AlertIcon width={28} height={28} className="mb-3 text-rose-400" />
      <h3 className="text-base font-medium text-rose-200">Unable to load data</h3>
      <p className="mt-2 max-w-md text-sm text-rose-200/70">{error?.message ?? 'Unknown error'}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-12 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-accent-400" />
      {label}
    </div>
  );
}

