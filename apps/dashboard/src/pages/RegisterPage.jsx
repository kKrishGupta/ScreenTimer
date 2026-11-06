import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState({ displayName: '', organizationName: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.registerOrganization({
        displayName: form.displayName.trim(),
        organizationName: form.organizationName.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      await login({ email: form.email.trim(), password: form.password }, { loginType: 'admin' });

      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Unable to create the organization.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your organization" description="Set up DigitalPulse and become its initial administrator.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name" value={form.displayName} onChange={update('displayName')} required autoComplete="name" />
        <Field label="Organization name" value={form.organizationName} onChange={update('organizationName')} required />
        <Field label="Work email" type="email" value={form.email} onChange={update('email')} required autoComplete="email" />
        <Field label="Password" type="password" value={form.password} onChange={update('password')} required minLength={8} autoComplete="new-password" />
        <Field label="Confirm password" type="password" value={form.confirmPassword} onChange={update('confirmPassword')} required minLength={8} autoComplete="new-password" />
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button disabled={busy} className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'Creating organization…' : 'Create organization'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-400">Already registered? <Link className="text-sky-400" to="/organization/login">Sign in</Link></p>
    </AuthShell>
  );
}
