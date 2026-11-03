# DigitalPulse production deployment

The repository includes a single-origin Docker Compose deployment for a Linux host. Caddy terminates HTTPS, serves the Vite build with SPA route fallback, and proxies `/api/v1` to Fastify. PostgreSQL stores application records and hashed sessions. The backend runs `prisma migrate deploy` before starting. Device enrollment remains deferred.

## Current deployment status

No public host, DNS name, production PostgreSQL URL, or SMTP credentials are configured in this workspace. Docker Compose configuration parses, but this machine has no available Docker daemon. Therefore there is no production frontend URL, backend URL, health URL, PostgreSQL deployment status, or live email result to report. The local browser dashboard build and unit/component tests are verified separately in `IMPLEMENTATION_STATUS.md`.

## Environment variables

Copy `deploy/production.env.example` to a private `.env.production` at the repository root. Keep real secrets out of Git, tickets, logs, and this documentation.

| Variable | Required | Runtime use |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection for production. Remote production URLs must use `sslmode=require` or stronger. The Compose migration command changes the schema without resetting application rows. |
| `DATABASE` | Compatibility only | Accepted by the backend and Prisma config only when `DATABASE_URL` is absent. Compose accepts it as a fallback too. Set `DATABASE_URL` for all new environments; it wins if both are present. |
| `NODE_ENV` | Set by Compose | Compose sets `production`; this enables secure cookies, disables public registration, validates HTTPS/CORS, and requires persistent authentication storage. |
| `PORT` | Set by Compose | Fastify listens on internal port `3001`. `HTTP_PORT` and `HTTPS_PORT` expose the dashboard/Caddy ports on the host. |
| `FRONTEND_URL` | No | Not read by this checkout. Use `PUBLIC_APP_URL` for the dashboard's HTTPS origin and `PUBLIC_APP_DOMAIN` for its DNS host. |
| `CORS_ORIGINS` | Yes | Exactly one HTTPS origin, equal to `PUBLIC_APP_URL`. This is checked at startup. |
| `SESSION_SECRET` | No | Not used by the current session architecture. Sessions use random opaque tokens, store only SHA-256 token hashes in PostgreSQL, and are validated/revoked against that database. Do not add an unused secret as a substitute for persistent storage. |
| `SMTP_HOST` | When email is enabled | SMTP host; the example defaults to Gmail. |
| `SMTP_PORT` | When email is enabled | SMTP port; the example defaults to `465`. |
| `SMTP_USER` | When email is enabled | SMTP account name. |
| `SMTP_PASS` | When email is enabled | SMTP credential. Compose maps this name to the backend's `SMTP_PASSWORD` setting. |
| `EMAIL_FROM` | Optional with SMTP | Sender address; Compose maps it to the backend's `SMTP_FROM` setting. If omitted, the SMTP account is used. |
| `PASSWORD_RESET_URL` | No | Compose derives `https://<PUBLIC_APP_DOMAIN>/reset-password`. An override must stay on the same HTTPS origin. |
| `PUBLIC_APP_DOMAIN` | Yes | DNS name served by Caddy; its A/AAAA records must reach the host. |
| `PUBLIC_APP_URL` | Yes | HTTPS dashboard origin. Compose derives the invitation and reset URLs from it. |
| `SMTP_SECURE` | Email setting | Defaults to `true` for TLS on port 465. |
| `LOG_LEVEL` | No | Backend log level; defaults to `info`. |
| `HTTP_PORT`, `HTTPS_PORT` | No | Host ports for Caddy; default to `80` and `443`. |

`SMTP_PASSWORD` and `SMTP_FROM` remain accepted by direct backend configuration for compatibility. Invitation and reset email delivery is not considered successful unless SMTP actually accepts the send operation. With no SMTP configuration, invitations remain copyable and password reset requests do not expose reset tokens in API responses.

## Isolated PostgreSQL integration database

The PostgreSQL integration suite requires a dedicated, disposable `TEST_DATABASE_URL` and `RUN_INTEGRATION_TESTS=true`. No `TEST_DATABASE_URL` is configured here, and the application database must not be used for fixtures. The integration test compares its host/database path with `DATABASE_URL` and aborts if they match. It creates uniquely named test organizations and removes its fixtures; it does not run `migrate reset` or truncate tables.

Provision an isolated test database using the deployment's normal PostgreSQL process, apply reviewed migrations to that database only, then run from PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://USER:PASSWORD@TEST_POSTGRES_HOST:5432/digitalpulse_test?sslmode=require'
$env:RUN_INTEGRATION_TESTS = 'true'
npm.cmd test --workspace @digitalpulse/backend
```

The regular database integration checks also require `TEST_DATABASE_URL`; they no longer connect to the configured application database. Both integration suites compare the test target against canonical `DATABASE_URL` or legacy `DATABASE` and refuse the same database. They never run `migrate reset`, truncate tables, or use the application URL as a test fallback.

The invitation PostgreSQL test exercises admin and employee login, hashed session persistence and restoration, employee RBAC, invitation creation/acceptance/replay/expiry/revocation/resend, existing same-organization account acceptance, cross-organization conflict, password reset hashing/use/revocation, concurrent acceptance, and shared persistent login throttling. It is skipped until the isolated database and migrated schema are supplied.

## Deploy

1. Provision a Linux Docker host, PostgreSQL database, DNS A/AAAA records, and firewall access for ports 80 and 443.
2. Set private values in `.env.production`: `PUBLIC_APP_DOMAIN`, matching `PUBLIC_APP_URL`, the same single-origin `CORS_ORIGINS`, and `DATABASE_URL`. Add SMTP settings when available.
3. From the repository root, build and start:

   ```sh
   docker compose --env-file .env.production -f docker-compose.production.yml up --build -d
   ```

   The backend image runs `npm run db:deploy --workspace @digitalpulse/backend` and then the Fastify production start command. The dashboard image uses `VITE_API_BASE_URL=/api/v1`, so browser API calls stay on the HTTPS dashboard origin. No localhost API address is embedded in the production build.

   Prisma uses the `DATABASE_URL` passed by Compose. For backward compatibility, Compose falls back to `DATABASE` only if `DATABASE_URL` is unset. The backend runs a sanitized `SELECT 1` check before listening in production, and exits with a clear error if PostgreSQL cannot be reached. `prisma migrate status` is read-only; review the migration list before the deployment command applies it.

4. Verify `https://<PUBLIC_APP_DOMAIN>/api/v1/health` returns HTTP 200 and reports PostgreSQL up. The Compose backend health check probes this endpoint before Caddy serves the dashboard.
5. Provision the first organization administrator using the one-off command below. Pass these values through the deployment secret manager or temporary environment only; do not place them in Compose's persistent environment or commit them.

   ```sh
   docker compose --env-file .env.production -f docker-compose.production.yml run --rm --no-deps \
     -e INITIAL_ADMIN_EMAIL -e INITIAL_ADMIN_PASSWORD -e INITIAL_ADMIN_NAME -e INITIAL_ORGANIZATION_NAME \
     backend node backend/scripts/provision-admin.js
   ```

6. Sign in, create an invitation, and confirm that the returned invitation link uses the configured HTTPS domain. Verify email delivery separately; if email is unavailable, use the real copyable link returned by the backend.

The `20261103130000_hashed_user_sessions` migration revokes prior sessions and replaces plaintext session tokens with hashes, so existing users sign in again after it is deployed. The new `20261103140000_persistent_login_throttling` migration adds hashed login identifiers for shared lockout state. Neither migration resets or deletes application records. The configured application database has not been migrated by this readiness work.

## Live verification still required

After a host and private configuration are supplied, verify HTTPS frontend delivery, `/api/v1/health`, administrator and employee login, role redirects and restrictions, invitation return after sign-in, invitation acceptance, password reset email delivery, and record/session persistence across backend redeployment. Until then, report these checks as pending rather than passed. Keep device enrollment deferred until its separate rollout requirements are met.
