import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

export default function ResetPasswordPage() {
  const params = new URLSearchParams(useLocation().search);
  const navigate = useNavigate();
  const [email, setEmail] = useState(params.get('email') || '');
  const [resetToken, setResetToken] = useState(params.get('token') || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.confirmPasswordReset({ email: email.trim(), resetToken: resetToken.trim(), newPassword: password });
      setMessage('Password updated. You can now sign in.');
      setTimeout(() => navigate('/login', { replace: true }), 1200);
    } catch (err) {
      setError(err.message || 'This reset link is invalid or expired.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Set a new password" description="Use the secure reset link sent to your email.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email" type="email" value={email} onChange={setEmail} required autoComplete="email" />
        <Field label="Reset token" value={resetToken} onChange={setResetToken} required />
        <Field label="New password" type="password" value={password} onChange={setPassword} required minLength={8} autoComplete="new-password" />
        <Field label="Confirm password" type="password" value={confirmPassword} onChange={setConfirmPassword} required minLength={8} autoComplete="new-password" />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        {message && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{message}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm"><Link className="text-sky-400" to="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}
