# Production server connection

## Administrator-managed extension builds

Set `EXTENSION_LOCAL_BACKEND_URL` and `EXTENSION_PRODUCTION_BACKEND_URL` in
`backend/.env`. Local unpacked development uses the first URL; published employee
downloads use the second. Configure the source extension locally with:

```powershell
npm.cmd run extension:local
```

Build production downloads with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-employee-downloads.ps1 -ExtensionsOnly -Overwrite -Deployment Production
```

The build embeds only this public URL and restricts manifest host permissions to
that origin. The popup no longer allows editing. Reload the extracted updated
extension; changing `.env` alone does not update installed browsers. For loading
the source folder directly, first run `node scripts/configure-browser-extension.mjs`.
An unpacked extension can still be modified by someone who controls the computer;
use enterprise browser deployment policies for tamper resistance.

The editable-server workflow described below is superseded by managed builds.

The extension expects API routes at `/api/v1` on the configured origin. Enter
`https://api.your-company.example` (or that origin followed by `/api/v1`).
Do not enter a dashboard-only hostname. The extension verifies the health response
before saving, without sending device secrets or cookies. This checks compatibility,
not ownership: obtain the address from your administrator.

HTTPS is required remotely; loopback HTTP is only for development. Existing
credentials and pending activity cannot be moved to another host using settings.
Use a separately enrolled browser profile for a different environment.

## Backend deployment

- Set `NODE_ENV=production`, `DATABASE_URL` with TLS, `PUBLIC_APP_URL`, and the
  matching `CORS_ORIGINS`. Keep the existing authentication and tenant boundaries.
- Set `TRUSTED_PROXIES` to the actual ingress proxy IPs/CIDRs, comma separated.
  The default is now no trusted proxy, including in production. Do not blindly
  trust all addresses. Restrict direct access to the origin at the network layer.
  Without a correct proxy configuration, IP rate limits see the proxy's address.
- Route `/api/v1/*` to the backend without rewriting it to frontend HTML.
- Use `/api/v1/health/live` for liveness (no database query) and `/api/v1/health`
  for database readiness. Both responses disable caching.
- Download and reload the rebuilt extension after updating runtime files.

These changes are connection hardening, not a certification of production scale.
Before multiple backend replicas, review process-local sessions, rate limits,
policy/grace caches and fallbacks; shared storage, capacity tests, monitoring,
database pooling and deployment-specific proxy configuration remain required.
No production host or database is changed by these source edits.
