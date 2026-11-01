export function Card({ title, action, children, className = '' }) {
  return (
    <section
      className={`rounded-xl border border-white/5 bg-surface-900/80 p-5 shadow-lg shadow-black/20 ${className}`}
    >
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-slate-300">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function Button({ children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-2 rounded-lg border border-white/10 bg-surface-800 px-3 py-1.5 text-sm text-slate-200 transition hover:border-accent-400/40 hover:text-white disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

