// import { useEffect, useRef, useState } from 'react';
// import { Link, useNavigate } from 'react-router';
// import { api } from '../lib/api.js';
// import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

// export default function ForgotPasswordPage() {
//   const navigate = useNavigate();
//   const [email, setEmail] = useState('');
//   const [error, setError] = useState('');
//   const [busy, setBusy] = useState(false);
//   const inFlight = useRef(false);
//   const [retryAt, setRetryAt] = useState(0);
//   const [now, setNow] = useState(Date.now);
//   const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));

//   useEffect(() => {
//     if (!retryAt) return;
//     const timer = setInterval(() => {
//       const currentTime = Date.now();
//       setNow(currentTime);
//       if (currentTime >= retryAt) clearInterval(timer);
//     }, 1000);
//     return () => clearInterval(timer);
//   }, [retryAt]);

//   async function submit(event) {
//     event.preventDefault();
//     if (inFlight.current || retrySeconds > 0) return;
//     inFlight.current = true;
//     setBusy(true);
//     setError('');
//     try {
//       await api.requestPasswordReset(email.trim());
//       // No reset credential crosses into router state. The emailed link is
//       // still required before the password fields can be used.
//       navigate('/reset-password', { replace: true, state: { resetRequested: true } });
//     } catch (err) {
//       if (err.status === 429) {
//         const requestedWait = Number(err.retryAfterSeconds);
//         const waitSeconds = Number.isFinite(requestedWait) && requestedWait > 0 ? Math.min(3600, Math.ceil(requestedWait)) : 60;
//         const currentTime = Date.now();
//         setNow(currentTime);
//         setRetryAt(currentTime + waitSeconds * 1000);
//         setError('Too many requests. Please wait for the countdown before requesting another link.');
//       } else if (err.code === 'RESET_EMAIL_NOT_CONFIGURED') {
//         setError('Password-reset email is unavailable. Please contact your administrator to enable email delivery.');
//       } else {
//         setError('The reset email could not be sent. Please try again later or contact your administrator.');
//       }
//     } finally {
//       inFlight.current = false;
//       setBusy(false);
//     }
//   }
//   return (
//     <AuthShell title="Reset your password" description="Request a secure password-reset link.">
//       <form onSubmit={submit} className="space-y-4">
//         <Field label="Work email" type="email" value={email} onChange={setEmail} required autoComplete="email" disabled={busy} />
//         {error && <ErrorMessage>{error}</ErrorMessage>}
//         <button disabled={busy || retrySeconds > 0} className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : retrySeconds > 0 ? `Try again in ${retrySeconds}s` : 'Send reset link'}</button>
//       </form>
//       <p className="mt-6 text-center text-sm"><Link className="text-sky-400" to="/login">Back to sign in</Link></p>
//     </AuthShell>
//   );
// }



import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { AuthShell, ErrorMessage, Field } from './LoginPage.jsx';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const inFlight = useRef(false);

  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);

  const retrySeconds = Math.max(
    0,
    Math.ceil((retryAt - now) / 1000)
  );

  useEffect(() => {
    if (!retryAt || retrySeconds === 0) return;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [retryAt, retrySeconds]);

  async function submit(event) {
    event.preventDefault();

    if (inFlight.current || retrySeconds > 0) return;

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      setError('Please enter your email address.');
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError('');

    try {
      await api.requestPasswordReset(normalizedEmail);

      // Always show the same message, regardless of account existence.
      setSubmitted(true);

    } catch (err) {
      if (err.status === 429) {
        const requestedWait = Number(err.retryAfterSeconds);

        const waitSeconds =
          Number.isFinite(requestedWait) && requestedWait > 0
            ? Math.min(3600, Math.ceil(requestedWait))
            : 60;

        const currentTime = Date.now();

        setNow(currentTime);
        setRetryAt(currentTime + waitSeconds * 1000);

        setError(
          'Too many requests. Please wait before requesting another link.'
        );

      } else if (err.code === 'RESET_EMAIL_NOT_CONFIGURED') {
        setError(
          'Password-reset email is currently unavailable. Please contact your administrator.'
        );

      } else {
        setError(
          'We could not process your request. Please check your connection and try again.'
        );
      }

    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <AuthShell
        title="Check your email"
        description="Your password-reset request has been received."
      >
        <div className="space-y-5">

          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4"
          >
            <div className="mb-2 flex items-center gap-2 text-emerald-400">
              <span aria-hidden="true">✉</span>
              <span className="font-semibold">Check your inbox</span>
            </div>

            <p className="text-sm leading-6 text-emerald-300">
              Please check your email. If an account exists for this email address,
              we will send you a password-reset link. Please check your
              inbox and spam folder.
            </p>
          </div>

          <p className="text-sm leading-6 text-slate-400">
            The link will allow you to securely choose a new
            password.
          </p>

          <p className="text-sm text-slate-400">
            Didn't receive an email?
          </p>

          <button
            type="button"
            onClick={() => {
              setSubmitted(false);
              setError('');
            }}
            disabled={retrySeconds > 0}
            className="text-sm font-medium text-sky-400 hover:text-sky-300 disabled:opacity-50"
          >
            {retrySeconds > 0
              ? `Request another link in ${retrySeconds}s`
              : 'Request another reset link'}
          </button>

          <div className="border-t border-white/10 pt-4 text-center">
            <Link
              className="text-sm font-medium text-sky-400 hover:text-sky-300"
              to="/login"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Request a secure password-reset link."
    >
      <form onSubmit={submit} className="space-y-4">

        <Field
          label="Work email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="email"
          disabled={busy}
        />

        {error && <ErrorMessage>{error}</ErrorMessage>}

        <button
          type="submit"
          disabled={busy || retrySeconds > 0}
          className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy
            ? 'Sending reset link...'
            : retrySeconds > 0
              ? `Try again in ${retrySeconds}s`
              : 'Send reset link'}
        </button>

      </form>

      <p className="mt-6 text-center text-sm">
        <Link
          className="text-sky-400 hover:text-sky-300"
          to="/login"
        >
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
