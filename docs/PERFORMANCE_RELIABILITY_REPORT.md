# DigitalPulse Performance and Reliability Report

Date: 2026-11-13

## Outcome

The dashboard now loads authenticated feature pages on demand, shares and cancels duplicate reads, pauses polling while hidden or offline, and applies bounded transient retries. The screenshot gallery starts at 12 metadata records, limits image concurrency to four, defers binary requests until cards approach the viewport, validates delivered image bytes, and renders explicit loading and failure states. Backend list queries return a narrow projection and have tenant/time indexes. The default PostgreSQL pool is reduced from 10 to 5 connections and is configurable within a safe 1-10 range.

No deployment, production database operation, credential/device change, WebView2 change, or monitoring-frequency change was performed.

## Before and after

These request figures are deterministic calculations from the configured polling intervals for one visible page after its initial load. They exclude user-triggered mutations and image binaries.

| Scenario | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Visible overview | 21 requests/minute | 6.67 requests/minute | 68.3% |
| Visible screenshot page | 12 requests/minute | 1 request/minute | 91.7% |
| Backend health | 4 requests/minute per poller | 0.67 requests/minute, shared by query key | 83.3% per poller |
| Employees/devices directory refresh | every 30 seconds | every 180 seconds with 120-second freshness | 83.3% polling reduction |
| App/site activity page refresh | every 5 seconds | every 60 seconds while mounted and visible | 91.7% |
| Live monitoring refresh | every 5 seconds | every 15 seconds while mounted and visible | 66.7% |
| Usage-report activity endpoints | mostly every 5 seconds | every 60 seconds while mounted and visible | 91.7% per endpoint |
| Planner tasks/goals/analytics | every 5 seconds | every 60 seconds while mounted and visible | 91.7% per endpoint |
| Policy lists/violations | every 5 seconds | every 60 seconds while mounted and visible | 91.7% per endpoint |

Additional measured/build facts:

- Production Vite build: initial JavaScript 316.92 kB (98.69 kB gzip). Feature chunks include Screen Monitoring at 17.57 kB (5.95 kB gzip), Employees at 36.63 kB (8.41 kB gzip), Devices at 30.69 kB (8.30 kB gzip), and Reports at 6.80 kB (2.39 kB gzip). These chunks are not requested until their route is opened.
- Screenshot metadata page maximum changed from 24 to 12. Binary requests start at zero for offscreen cards and are capped at four concurrent requests. Actual byte reduction depends on viewport size and stored JPEG sizes; no production screenshots were downloaded for measurement.
- Gallery database work remains two queries (one narrow `findMany`, one `count`) rather than introducing joins or N+1 reads. Rows per page are halved and the new organization/device/time and organization/employee/time indexes match the gallery filters.
- A comparable pre-change browser-load trace, production response-latency series, Render CPU/memory series, and production database timing were not available. Aggregate backend metrics now report request count, error count, error rate, and average response time every 100 completed requests without recording URLs, query strings, bodies, credentials, or image contents.

## Reliability and security behavior

- Auth and password-reset entry routes stay eagerly loaded so fragment/query credentials are scrubbed synchronously. Authenticated feature routes use `React.lazy` and `Suspense`.
- Cache entries are cleared on login, logout, and organization-scope changes, preventing cross-tenant reuse.
- Simultaneous reads with the same key share a promise. Obsolete filter/navigation requests are aborted when no observer remains. Aborted requests are not retried.
- GET retries are limited to two for HTTP 429/502/503/504, use exponential delay plus jitter, honor bounded `Retry-After`, and do not retry 401/403, cancellation, timeout, or generic network errors.
- Screenshot images use credentialed, `no-store` requests and in-memory object URLs that are revoked. JPEG/PNG content type and magic bytes are validated; signed URLs are refreshed only once after 401/403.
- Screenshot metadata/image access remains organization-scoped and user-bound. Private image responses remain `private, no-store, max-age=0`.
- The Windows capture helper rejects a uniformly near-black synthetic sample before JPEG encryption/persistence. It does not log pixels or screenshots. Consent, schedule, authorization, revocation, durable queue, stop, and sign-out behavior were not changed.

## Black-thumbnail investigation

The prior metadata HTTP 200 result only proved that metadata existed. The implementation now distinguishes the relevant failure classes:

- non-image or invalid JPEG/PNG delivery becomes an explicit unavailable placeholder;
- 401/403 image delivery triggers one metadata refresh;
- browser delivery remains private and uncached;
- the Windows capture helper detects uniformly near-black content before upload.

This establishes guards for capture-side uniform-black frames and delivery/render failures without examining or logging real employee screenshots. It does not prove which historical records were capture-side failures because production image inspection was intentionally not performed.

## Verification

- Dashboard: 14 files, 98 tests passed.
- Focused cache and screenshot lifecycle: 10 tests passed, including deduplication, cancellation, hidden-tab pause, offline recovery, concurrency limit, invalid image delivery, and one-time signed-URL refresh.
- Backend full suite: 182 passed, 0 failed, 4 skipped because `TEST_DATABASE_URL` was not configured.
- Focused backend configuration/screenshot security: 16 passed, including cross-organization authorization and image token validation.
- Windows user agent: 29 passed, including consent/authorization expiry, durable sync behavior, stop-state guards, encrypted screenshot handling, and uniform-black rejection.
- ESLint: 0 errors (9 pre-existing warnings remain).
- Prisma schema validation: passed.
- Production Vite build: passed.

## Changed files for this optimization

Dashboard implementation and tests:

- `apps/dashboard/src/App.jsx`
- `apps/dashboard/src/components/layout/BackendStatus.jsx`
- `apps/dashboard/src/components/WebsiteBlockingControls.jsx`
- `apps/dashboard/src/components/screenshots/LazyScreenshotImage.jsx`
- `apps/dashboard/src/context/AuthContext.jsx`
- `apps/dashboard/src/hooks/useApi.js`
- `apps/dashboard/src/lib/api.js`
- `apps/dashboard/src/lib/imageRequestQueue.js`
- `apps/dashboard/src/pages/ApplicationsPage.jsx`
- `apps/dashboard/src/pages/AlertsPage.jsx`
- `apps/dashboard/src/pages/BlockedActivityPage.jsx`
- `apps/dashboard/src/pages/DeclarativeRulesPage.jsx`
- `apps/dashboard/src/pages/DevicesPage.jsx`
- `apps/dashboard/src/pages/DigitalWellbeingPage.jsx`
- `apps/dashboard/src/pages/EmployeeSetupPage.jsx`
- `apps/dashboard/src/pages/EmployeesPage.jsx`
- `apps/dashboard/src/pages/FamilyMembersPage.jsx`
- `apps/dashboard/src/pages/FamilyPoliciesPage.jsx`
- `apps/dashboard/src/pages/LiveMonitoringPage.jsx`
- `apps/dashboard/src/pages/OverviewPage.jsx`
- `apps/dashboard/src/pages/ScreenMonitoringPage.jsx`
- `apps/dashboard/src/pages/TimelinePage.jsx`
- `apps/dashboard/src/pages/TimePlannerPage.jsx`
- `apps/dashboard/src/pages/WebsitesPage.jsx`
- `apps/dashboard/src/test/api-request-lifecycle.test.js`
- `apps/dashboard/src/test/app.test.jsx`
- `apps/dashboard/src/test/screen-monitoring.test.jsx`
- `apps/dashboard/src/test/screenshot-lazy-loading.test.jsx`
- `apps/dashboard/src/test/setup.js`
- `apps/dashboard/src/test/use-api.test.jsx`
- `apps/dashboard/vitest.config.js`

Backend, schema, and agent:

- `backend/.env.example`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261113090000_screen_capture_gallery_indexes/migration.sql`
- `backend/src/app.js`
- `backend/src/database/prisma.js`
- `backend/src/modules/screen/screen.routes.js`
- `backend/src/shared/config.js`
- `backend/tests/config.test.js`
- `backend/tests/screen-upload.test.js`
- `desktop-agent/crates/dp-user-agent/src/screenshot.rs`

## Remaining limitations

- The encrypted-at-rest screenshot object format does not support safe storage-provider thumbnail transforms. Generating thumbnails during every read would add CPU and memory pressure to the free-tier backend, so this change does not claim server-generated thumbnails or reduced bytes for an individual visible full-resolution JPEG. A future migration should create and encrypt a bounded thumbnail once during authorized upload, store a separate tenant-scoped key, and backfill only with explicit approval.
- The image endpoint must currently obtain and decrypt the complete AES-GCM object before replying; true streaming requires a versioned chunked-encryption format and storage migration. The response has an exact content length and remains private/no-store.
- The near-black detector intentionally rejects uniformly near-black frames; a legitimately uniform black desktop can be skipped. It does not change capture cadence or scope.
- No Render production telemetry, live browser trace, or production database was accessed. Free-tier sleep and platform unavailability remain possible.
- The index migration was created and validated but not applied. The agent source guard is not deployed and will enter a release only through the existing authorized installer build process.

## Rollback

Prefer reverting the eventual optimization commit as one unit. Before deployment, the source-only rollback is to restore the files listed above and remove the new migration, screenshot component, image queue, screenshot test, and this report. If the index migration is later applied, roll it back independently with:

```sql
DROP INDEX IF EXISTS "screen_captures_organization_id_device_id_captured_at_idx";
DROP INDEX IF EXISTS "screen_captures_organization_id_employee_id_captured_at_idx";
```

Those statements remove only the added indexes and do not delete employee data. Do not roll back by resetting the production database, deleting screenshot records, changing device identity, or clearing the offline queue.
