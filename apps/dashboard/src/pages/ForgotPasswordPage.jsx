import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [resetLink, setResetLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    setResetLink('');
    try {
      const result = await api.requestPasswordReset(email.trim());
      setMessage(result.message || 'If an account exists for that email, a reset instruction has been processed.');
      if (result.resetToken) {
        const params = new URLSearchParams({ token: result.resetToken, email: email.trim() });
        setResetLink(`${window.location.origin}/reset-password?${params.toString()}`);
      }
    } catch (err) {
      setError(err.message || 'Unable to request a password reset.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthShell title="Reset your password" description="Request a secure password-reset link.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email" type="email" value={email} onChange={setEmail} required autoComplete="email" />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{message}</p>}
        {resetLink && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
            <p className="font-medium">Development reset link</p>
            <p className="mt-1 break-all text-xs text-amber-100/80">{resetLink}</p>
            <Link className="mt-2 inline-block text-sky-300 hover:text-sky-200" to={resetLink.replace(window.location.origin, '')}>Open reset form</Link>
          </div>
        )}
        <button disabled={busy} className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : 'Send reset link'}</button>
      </form>
      <p className="mt-6 text-center text-sm"><Link className="text-sky-400" to="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}
