import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage({ mode = 'employee' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  
async function submit(event) {
  event.preventDefault();

  if (busy) return;

  setError('');
  setBusy(true);

  try {
    const result = await login(
      { email: email.trim(), password },
      { remember, loginType: mode }
    );

    const role = result.user.role;
    const requestedRoute = location.state?.from;
    const requestedPath = requestedRoute?.pathname;

    const canResumeInvitation =
      requestedPath === '/accept-invitation' ||
      requestedPath === '/invitations/accept';

    const canResumeEmployeePath =
      role === 'EMPLOYEE' &&
      requestedPath?.startsWith('/employee-portal');

    const canResumeAdminPath =
      ['ADMIN', 'SUPER_ADMIN'].includes(role) &&
      requestedPath &&
      !requestedPath.startsWith('/employee-portal');

    const resumePath =
      canResumeInvitation ||
      canResumeEmployeePath ||
      canResumeAdminPath;

    const target = resumePath
      ? `${requestedPath}${requestedRoute.search || ''}${requestedRoute.hash || ''}`
      : roleDestination(role);

    navigate(target, { replace: true });

  } catch {
    setError('Unable to sign in. Check your credentials and try again.');
  } finally {
    setBusy(false);
  }
}


  function roleDestination(role) {
    if (role === 'EMPLOYEE') return '/employee-portal';

    if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
      return '/';
    }

    throw new Error('Unsupported account role.');
  }

  const portalTitles = {
    employee: { title: 'Employee Login', description: 'Sign in to your personal DigitalPulse workspace.' },
    admin: { title: 'Organization Admin Login', description: 'Manage your organization and employees.' },
    'super-admin': { title: 'Super Admin Login', description: 'Access the DigitalPulse platform administration portal.' },
  };

  return (
    <AuthShell title={portalTitles[mode].title} description={portalTitles[mode].description}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email" type="email" value={email} onChange={setEmail} required autoComplete="email" />
        <Field label="Password" type="password" value={password} onChange={setPassword} required autoComplete="current-password" />
        <div className="flex items-center justify-between text-xs">
          <label className="flex items-center gap-2 text-slate-400">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember me
          </label>
          <Link className="text-sky-400 hover:text-sky-300" to="/forgot-password">Forgot password?</Link>
        </div>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button disabled={busy} className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {mode === 'admin' && <p className="mt-6 text-center text-sm text-slate-400">
        New organization?{" "}
        <Link className="text-sky-400" to="/organization/register">
          Register your organization
        </Link>
      </p>}
      {mode === 'employee' && <p className="mt-6 text-center text-sm text-slate-400">
        Need an account? Ask your organization administrator for an invitation.
      </p>}
    </AuthShell>
  );
}

function AuthShell({ title, description, children }) {
  return (
    <main className="grid min-h-screen place-items-center bg-surface-950 px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-surface-900/90 p-8 shadow-2xl">
        <div className="mb-8">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-emerald-400">DigitalPulse</p>
          <h1 className="mt-3 text-2xl font-semibold text-white">{title}</h1>
          <p className="mt-2 text-sm text-slate-400">{description}</p>
        </div>
        {children}
      </section>
    </main>
  );
}

export function Field({ label, type = 'text', value, onChange, ...props }) {
  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';
  const inputType = isPassword && visible ? 'text' : type;

  return (
    <label className="block text-sm text-slate-300">
      {label}
      <span className="relative mt-1.5 block">
        <input
          {...props}
          type={inputType}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full rounded-lg border border-white/10 bg-surface-950 px-3 py-2.5 text-white outline-none focus:border-sky-400 read-only:cursor-default read-only:bg-slate-800/80 read-only:text-slate-300 ${isPassword ? 'pr-20' : ''}`}
        />
        {isPassword && (
          <button
            type="button"
            aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            onClick={() => setVisible((current) => !current)}
            className="absolute inset-y-0 right-2 px-2 text-xs font-medium text-sky-400 hover:text-sky-300"
          >
            {visible ? 'Hide' : 'Show'}
          </button>
        )}
      </span>
    </label>
  );
}

export function ErrorMessage({ children }) {
  return <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{children}</p>;
}

export { AuthShell };
