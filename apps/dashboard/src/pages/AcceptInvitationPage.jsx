import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

function readInvitationToken(location) {
  const queryToken = new URLSearchParams(location.search).get('token');
  if (queryToken) return queryToken; // Support links issued by earlier builds.
  return new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
}

function isPersonName(value) {
  const name = String(value || '').trim();
  return name.length >= 2 && name.length <= 128 && !name.includes('@') && /\p{L}/u.test(name);
}

function FieldError({ children }) {
  return <p role="alert" className="mt-1 text-xs text-rose-300">{children}</p>;
}

export default function AcceptInvitationPage() {
  const location = useLocation();
  const token = readInvitationToken(location);
  const navigate = useNavigate();
  const { login, logout, user } = useAuth();
  const [details, setDetails] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmPasswordError, setConfirmPasswordError] = useState('');
  const [signInRequired, setSignInRequired] = useState(false);
  const [validating, setValidating] = useState(true);
  const [busy, setBusy] = useState(false);

  const invitedAccountMatches = Boolean(user && details?.email
    && user.email?.trim().toLowerCase() === details.email.trim().toLowerCase());
  const invitationReturnState = useMemo(() => ({
    from: { pathname: location.pathname, search: location.search, hash: location.hash },
  }), [location.pathname, location.search, location.hash]);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setSignInRequired(false);
    if (!token) {
      setError('This invitation link is missing its token. Ask your organization for a new link.');
      setValidating(false);
      return () => { cancelled = true; };
    }
    setValidating(true);
    api.validateInvitation(token).then((result) => {
      if (cancelled) return;
      setDetails(result.invitation);
      setDisplayName(isPersonName(result.invitation?.displayName) ? result.invitation.displayName : '');
      setError('');
    }).catch((err) => {
      if (!cancelled) setError(err.message || 'This invitation link could not be validated. Ask your organization for a new link.');
    }).finally(() => {
      if (!cancelled) setValidating(false);
    });
    return () => { cancelled = true; };
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    if (!token || !details || busy) return;
    setError('');
    setNameError('');
    setPasswordError('');
    setConfirmPasswordError('');

    const acceptingExistingAccount = invitedAccountMatches;
    if (!acceptingExistingAccount) {
      if (!isPersonName(displayName)) {
        setNameError('Enter your full name. It must be a person’s name, not an email address.');
        return;
      }
      if (password.length < 8) {
        setPasswordError('Use a password with at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setConfirmPasswordError('Passwords do not match.');
        return;
      }
    }

    setBusy(true);
    try {
      const result = await api.acceptInvitation(acceptingExistingAccount
        ? { token }
        : { token, displayName: displayName.trim(), password });
      if (!acceptingExistingAccount) {
        const session = await login({ email: result.user.email, password });
        navigate(session.user?.role === 'EMPLOYEE' ? '/employee-setup' : '/', { replace: true });
      } else {
        navigate(result.user?.role === 'EMPLOYEE' ? '/employee-setup' : '/', { replace: true });
      }
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err.code === 'EXISTING_ACCOUNT_REQUIRES_AUTH') {
        setPassword('');
        setConfirmPassword('');
        setSignInRequired(true);
        setError('');
      } else if (err.code === 'INVALID_DISPLAY_NAME') {
        setNameError(err.message);
      } else if (err.code === 'INVALID_PASSWORD') {
        setPasswordError(err.message);
      } else {
        setError(err.message || 'Unable to accept this invitation.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    setBusy(true);
    try {
      await logout();
      navigate('/login', { state: invitationReturnState });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Accept invitation" description={invitedAccountMatches ? 'Accept this invitation with your existing DigitalPulse account.' : 'Create your account using the invitation issued by your organization.'}>
      {validating ? <p role="status" className="text-sm text-slate-300">Checking invitation…</p> : error && !details ? <ErrorMessage>{error}</ErrorMessage> : details ? (
        <div className="space-y-4">
          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-200">
            <p className="font-semibold text-white">{details.organizationName} invited you to DigitalPulse</p>
            <p className="mt-2">{details.displayName && isPersonName(details.displayName) ? details.displayName : 'Employee'} · {details.email}</p>
            {details.department && <p className="mt-1 text-slate-400">Department: {details.department}</p>}
            <p className="mt-1 text-slate-400">Role: Employee</p>
            {details.shiftStart && details.shiftEnd && <p className="mt-1 text-slate-400">Schedule: {details.shiftStart}–{details.shiftEnd} ({details.shiftTimezone || 'local time'})</p>}
            <p className="mt-2 text-xs text-slate-500">Expires {new Date(details.expiresAt).toLocaleString()}</p>
          </section>

          {invitedAccountMatches ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">Signed in as <strong className="text-white">{user.email}</strong>. Your existing password and account role will be kept.</p>
              {error && <ErrorMessage>{error}</ErrorMessage>}
              <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Accepting invitation…' : 'Accept invitation'}</button>
            </div>
          ) : user ? (
            <div className="space-y-4">
              <ErrorMessage>This invitation is for {details.email}, but you are signed in as {user.email}. Switch accounts to continue.</ErrorMessage>
              <button type="button" onClick={switchAccount} disabled={busy} className="w-full rounded-lg border border-white/10 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Signing out…' : 'Sign out and use invited account'}</button>
            </div>
          ) : signInRequired ? (
            <div className="space-y-4">
              <p role="status" className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-3 text-sm text-sky-100">This email already has a DigitalPulse account. Sign in with the invited email to accept this invitation.</p>
              <Link to="/login" state={invitationReturnState} className="block w-full rounded-lg bg-sky-600 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-sky-500">Sign in to accept invitation</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <Field label="Invited email" type="email" value={details.email} onChange={() => {}} readOnly aria-readonly="true" autoComplete="email" />
              </div>
              <div>
                <Field label="Full name" value={displayName} onChange={(value) => { setDisplayName(value); setNameError(''); }} required maxLength={128} autoComplete="name" aria-invalid={Boolean(nameError)} />
                {nameError && <FieldError>{nameError}</FieldError>}
              </div>
              <div>
                <Field label="Password" type="password" value={password} onChange={(value) => { setPassword(value); setPasswordError(''); }} required minLength={8} autoComplete="new-password" aria-invalid={Boolean(passwordError)} />
                {passwordError && <FieldError>{passwordError}</FieldError>}
              </div>
              <div>
                <Field label="Confirm password" type="password" value={confirmPassword} onChange={(value) => { setConfirmPassword(value); setConfirmPasswordError(''); }} required minLength={8} autoComplete="new-password" aria-invalid={Boolean(confirmPasswordError)} />
                {confirmPasswordError && <FieldError>{confirmPasswordError}</FieldError>}
              </div>
              {error && <ErrorMessage>{error}</ErrorMessage>}
              <button disabled={busy} className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Activating account…' : 'Accept invitation'}</button>
              <p className="text-center text-sm text-slate-400">Already have an account? <Link to="/login" state={invitationReturnState} className="text-sky-400 hover:text-sky-300">Sign in with the invited email</Link></p>
            </form>
          )}
        </div>
      ) : null}
    </AuthShell>
  );
}
