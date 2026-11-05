# Password reset security change

Implemented and verified on 2026-11-05.

## Result

The existing reset page captures the email and reset token in component memory,
then removes both query parameters with `window.history.replaceState` before
paint. React Router is also updated with a replacement navigation. Capture is
side-effect-free, so StrictMode's repeated initialization does not discard the
credentials. The page no longer waits for session lookup before cleaning the URL.

The form renders only new password, confirmation, submit, and sign-in controls.
No token input, including hidden inputs, is rendered. The token is not put in
browser storage, cookies, history state, or shared application state. It survives
ordinary rerenders and is discarded on successful reset, invalid-link rejection,
or unmount. Reloading the cleaned URL requires requesting a new link.

The existing confirmation endpoint and JSON fields remain unchanged:
`POST /api/v1/auth/reset-password-confirm`, with `email`, `resetToken`, and
`newPassword`. Passwords must match and retain the existing eight-character
minimum. Successful reset clears the cached sign-in profile and redirects to
`/login` after showing confirmation.

## Backend protections

- Raw tokens are delivered only through email; the development API token shortcut
  and its visible forgot-password link have been removed.
- Missing SMTP configuration fails safely with HTTP 503 for both known and
  unknown accounts, before generating a token.
- SHA-256 token hashes remain the only reset credentials stored in PostgreSQL.
- `PASSWORD_RESET_TTL_MINUTES` defaults to 30, with valid values from 1 to 60.
  Email content uses the same configured lifetime.
- Persistent tokens are claimed with an atomic unused/unexpired conditional
  update inside the password-change transaction. Sessions are revoked in that
  transaction. Persistent reset fails closed without transaction support.
- Development-only in-memory fallback stores hashes and claims tokens before
  awaiting writes, preventing concurrent reuse.
- Reset request limits are 5 per IP per 15 minutes; confirmation limits are 10
  per IP per 15 minutes, independently of the general API limit.
- Request logs omit URL queries. Reset error responses and SMTP failure logs
  never echo raw exceptions or email bodies. Malformed JSON errors are sanitized.
- Reset API responses use `Cache-Control: no-store` and `Referrer-Policy:
  no-referrer`. HTML metadata, Vite development/preview headers, Vercel headers,
  and emailed links also enforce no-referrer. Vercel reset documents use no-store.

These protections follow the [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Files changed

Frontend:

- `apps/dashboard/src/pages/ResetPasswordPage.jsx`
- `apps/dashboard/src/pages/ForgotPasswordPage.jsx`
- `apps/dashboard/src/App.jsx`
- `apps/dashboard/index.html`
- `apps/dashboard/vite.config.js`
- `apps/dashboard/vercel.json`

Backend:

- `backend/src/modules/auth/auth.service.js`
- `backend/src/modules/auth/auth.routes.js`
- `backend/src/modules/auth/email.service.js`
- `backend/src/shared/config.js`
- `backend/src/app.js`
- `backend/src/middleware/error-handler.js`
- `backend/.env.example`

Tests and report:

- `apps/dashboard/src/test/password-reset.test.jsx` (new)
- `apps/dashboard/src/test/deployment-routing.test.js`
- `backend/tests/password-reset-security.test.js`
- `backend/tests/auth-rbac.test.js`
- `backend/tests/config.test.js`
- `docs/PASSWORD_RESET_SECURITY.md` (new)

## Verification

- Frontend: **45 passed** with `npm test -- --maxWorkers=1
  --no-file-parallelism` from `apps/dashboard`. Initial sandbox worker startup
  timeouts required running with standard forks outside the restricted sandbox.
  A threads-pool retry had a transient download-test failure; the final standard
  forks run passed every frontend test.
- Targeted backend: **28 passed** with `node --test --test-concurrency=1
  tests/password-reset-security.test.js tests/auth-rbac.test.js
  tests/config.test.js` from `backend`.
- Frontend production build passed with `npm run build:dashboard`.
- ESLint passed for the changed reset pages, frontend tests, and Vite config.
- Local `GET /reset-password`: HTTP 200, no-referrer response header and HTML
  metadata confirmed.
- Broader backend suite: **119 passed, 10 failed, 4 skipped**. The failures are
  legacy screen-monitoring tests expecting enabled endpoints; the existing screen
  router explicitly returns HTTP 410. That router and its tests were not changed.

Coverage includes valid links and original API payload, StrictMode, rerenders,
missing/expired/invalid/used tokens, refresh, mismatched/short passwords,
single-use and concurrent consumption, session revocation, email delivery errors,
request throttling, malformed JSON, log confidentiality, login, and forgot-password
navigation.

## Configuration and limits

No database migration or new dependency is required. Existing hashed reset
records remain compatible. SMTP was not configured in the local runtime during
verification; configure the SMTP settings documented in `backend/.env.example`
to deliver new links. Tests use mocked email delivery and never send real mail.

Deploy the frontend configuration changes to apply the Vercel headers in
production. Legacy query-string reset links reach the hosting server on their
initial navigation before JavaScript can clean the address bar; hosting access
logs must also redact sensitive queries. Cleaning browser history cannot erase
an already captured URL or screenshot. The reset rate limiter is per backend
process, consistent with the existing limiter implementation.

PostgreSQL integration tests were skipped because an isolated `TEST_DATABASE_URL`
was not configured. Token persistence/consumption behavior was verified through
Prisma test doubles; no application database was modified for these tests.
