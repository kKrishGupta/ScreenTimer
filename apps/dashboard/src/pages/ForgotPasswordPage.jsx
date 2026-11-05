import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));

  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || retrySeconds > 0) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await api.requestPasswordReset(email.trim());
      // No reset credential crosses into router state. The emailed link is
      // still required before the password fields can be used.
      navigate('/reset-password', { replace: true, state: { resetRequested: true } });
    } catch (err) {
      if (err.status === 429) {
        const requestedWait = Number(err.retryAfterSeconds);
        const waitSeconds = Number.isFinite(requestedWait) && requestedWait > 0 ? Math.min(3600, Math.ceil(requestedWait)) : 60;
        const currentTime = Date.now();
        setNow(currentTime);
        setRetryAt(currentTime + waitSeconds * 1000);
        setError('Too many requests. Please wait for the countdown before requesting another link.');
      } else if (err.code === 'RESET_EMAIL_NOT_CONFIGURED') {
        setError('Password-reset email is unavailable. Please contact your administrator to enable email delivery.');
      } else {
        setError('The reset email could not be sent. Please try again later or contact your administrator.');
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <AuthShell title="Reset your password" description="Request a secure password-reset link.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email" type="email" value={email} onChange={setEmail} required autoComplete="email" disabled={busy} />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button disabled={busy || retrySeconds > 0} className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : retrySeconds > 0 ? `Try again in ${retrySeconds}s` : 'Send reset link'}</button>
      </form>
      <p className="mt-6 text-center text-sm"><Link className="text-sky-400" to="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}
