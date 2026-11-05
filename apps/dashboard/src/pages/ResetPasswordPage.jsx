import { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

export default function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  // Capture without side effects: StrictMode may call this initializer twice.
  // Only this mounted component retains the credentials after URL cleanup.
  const [credentials, setCredentials] = useState(() => {
    const params = new URLSearchParams(location.search);
    return { email: params.get('email')?.trim() || '', resetToken: params.get('token')?.trim() || '' };
  });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const hasResetLink = Boolean(credentials?.resetToken);
  const awaitingEmail = location.state?.resetRequested === true && !hasResetLink;

  useLayoutEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('token') && !params.has('email')) return;
    params.delete('token');
    params.delete('email');
    const query = params.toString();
    const cleanUrl = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
    window.history.replaceState(window.history.state, '', cleanUrl);
    // Synchronize the router too, so a later navigation cannot restore the query.
    navigate(cleanUrl, { replace: true, state: null });
  }, [location.pathname, location.search, location.hash, navigate]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => navigate('/login', { replace: true }), 1200);
    return () => clearTimeout(timer);
  }, [message, navigate]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!hasResetLink) return;
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }
    setBusy(true);
    try {
      await api.confirmPasswordReset({ ...credentials, newPassword: password });
      setCredentials(null);
      setPassword('');
      setConfirmPassword('');
      // Reset revokes sessions server-side; clear any cached signed-in profile.
      await logout().catch(() => {});
      setMessage('Password updated. You can now sign in.');
    } catch (err) {
      // Never render server-provided exception text containing request secrets.
      if (err.status === 400) {
        if (err.code === 'PASSWORD_TOO_SHORT') {
          setError('Password must be at least 8 characters long.');
        } else {
          setCredentials(null);
          setError('This reset link is invalid, expired, or already used. Request a new reset link.');
        }
      } else if (err.status === 429) {
        setError('Too many attempts. Please wait before trying again.');
      } else {
        setError('Unable to update your password. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={awaitingEmail ? 'Check your email' : 'Set a new password'} description={awaitingEmail ? 'Open the password-reset link in your email to continue.' : 'Use the secure reset link sent to your email.'}>
      {awaitingEmail ? (
        <div className="space-y-4 text-sm">
          <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-300">If an account exists for that email, check your email inbox and spam folder for a password-reset link. Open that link to choose a new password.</p>
          <p className="text-slate-400">The link is required to verify that you own the account.</p>
          <Link className="inline-block text-sky-400" to="/forgot-password">Request another reset link</Link>
        </div>
      ) : <form onSubmit={submit} className="space-y-4">
        <Field label="New password" type="password" value={password} onChange={setPassword} required minLength={8} autoComplete="new-password" disabled={busy || !hasResetLink} />
        <Field label="Confirm password" type="password" value={confirmPassword} onChange={setConfirmPassword} required minLength={8} autoComplete="new-password" disabled={busy || !hasResetLink} />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {!hasResetLink && !error && !message && <ErrorMessage>This reset link is missing or no longer available. Request a new reset link.</ErrorMessage>}
        {!hasResetLink && !message && <p className="text-sm"><Link className="text-sky-400" to="/forgot-password">Request a new reset link</Link></p>}
        {message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{message}</p>}
        <button disabled={busy || !hasResetLink || Boolean(message)} className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </form>}
      <p className="mt-6 text-center text-sm"><Link className="text-sky-400" to="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}
