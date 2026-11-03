# DigitalPulse implementation report

Updated: 2026-11-03

## Status

**PARTIALLY IMPLEMENTED — NOT END-TO-END VERIFIED.** The workspace already contained a large set of ongoing changes before this pass. Those changes were preserved and selectively extended. No complete company-to-manager-to-collector workflow is claimed as verified.

## Changes made in this pass

- Fixed privacy deletion's `baseWhere` temporal-dead-zone defect by constructing the tenant/device filter before querying screenshot metadata.
- Changed new organization registration to persist the Prisma `ORG_ADMIN` enum rather than the legacy family-owner enum.
- Removed process-local analytics category state and synthetic values. Empty productivity scores and prior-period comparisons are now `null`; empty exports contain only their header; database unavailability is surfaced.
- Added an organization-owned `UsageCategory` Prisma model and migration. Category mutation is restricted to organization administrators.
- Applied organization filters and self/direct-report scoping to analytics and CSV queries using authenticated user context.
- Added one-time enrollment hash persistence and hash lookup for newly created enrollment tokens.
- Made persistent enrollment claim and device creation one transaction; device ID collisions cannot update and reassign an existing device.
- Changed active time analytics to union overlapping app/browser intervals and clip durations to UTC date boundaries. App and website category usage remains intentionally separate and may overlap.
- Removed seeded planner tasks/goals and percentage-based task/productivity estimates. Daily activity is tenant/role scoped; missing planned targets and unsupported task attribution remain unavailable. Production-only planner routes without persistence fail closed.
- Replaced the extension's visible device-secret editor with a token-based enrollment form. The returned credential is kept in extension local storage and is not rendered in the popup.
- Added tests asserting tenant context and no synthetic activity in empty analytics results, and updated the registration security expectation.

## Migrations

- `20261103100000_usage_categories`: adds tenant-scoped usage category overrides.
- `20261103110000_hashed_enrollment_tokens`: permits legacy nullable raw tokens and adds a unique hash column. Existing raw legacy token rows are not automatically hashed or migrated.

Apply with `npm.cmd run db:deploy` after configuring `DATABASE_URL`; generate Prisma Client with `npm.cmd run db:generate`.

## Files changed and added in this pass

Changed: `backend/src/modules/privacy/privacy.routes.js`, `backend/src/modules/auth/auth.service.js`, `backend/src/modules/analytics/analytics.service.js`, `backend/src/modules/analytics/analytics.routes.js`, `backend/src/modules/activity/activity.routes.js`, `backend/src/modules/devices/devices.service.js`, `backend/src/modules/notifications/notifications.service.js`, `backend/src/modules/planner/planner.routes.js`, `backend/src/modules/policies/policies.routes.js`, `backend/prisma/schema.prisma`, `apps/browser-extension/popup/popup.html`, `apps/browser-extension/popup/popup.js`, `apps/dashboard/src/pages/DigitalWellbeingPage.jsx`, `apps/dashboard/src/pages/TimePlannerPage.jsx`, `apps/dashboard/src/test/app.test.jsx`, and the focused backend tests for analytics, registration, enrollment, and planner behavior.

Added: `backend/prisma/migrations/20261103100000_usage_categories/migration.sql`, `backend/prisma/migrations/20261103110000_hashed_enrollment_tokens/migration.sql`, `backend/tests/analytics-accounting.test.js`, `docs/DIGITALPULSE_MASTER_IMPLEMENTATION_TRACKER.md`, `docs/DIGITALPULSE_FINAL_PRODUCT_CONTRACT.md`, and this report.

Other files were already modified or untracked before this pass. They were retained as found and are not attributed to this implementation summary.

## Environment variable names

`DATABASE_URL` is required. Optional/local configuration names present in `backend/.env.example`: `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `INVITATION_ACCEPT_URL`, `DEV_ORG_SLUG`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `PASSWORD_RESET_URL`. No values are included here.

## Verification executed

- `npm.cmd test --workspace @digitalpulse/backend` passed 72 tests; 2 PostgreSQL integration tests were skipped because `RUN_INTEGRATION_TESTS` was not enabled. The suite was rerun after the final backend changes.
- `npm.cmd test --workspace @digitalpulse/browser-extension` passed 7 tests.
- `npm.cmd test --workspace @digitalpulse/dashboard` passed 19 tests after refreshing stale navigation/health assertions.
- `cargo test --workspace` passed all Rust workspace tests.
- `npm.cmd run build:dashboard` passed.
- `npx.cmd prisma validate --schema backend/prisma/schema.prisma` passed and `npm.cmd run db:generate` generated Prisma Client.
- `npm.cmd run test:contracts` passed 12 contract tests.
- No PostgreSQL database or installed Chromium extension was available. Backend screenshot API tests passed in the second full run, but that does not verify the complete authorized employee workflow or deployed capture behavior.

## Remaining blockers and risks

- Re-run targeted backend tests after fixture updates and execute the full backend, extension, dashboard, and Rust suites.
- Validate Prisma schema/client and both migrations against disposable PostgreSQL; the migration that introduces hashed enrollment still needs a data migration strategy for any outstanding legacy raw tokens.
- The enrollment transaction passed a Prisma-compatible unit fixture but has not been executed against PostgreSQL. Existing raw enrollment token rows remain unconverted by the migration.
- Device service still contains development in-memory behavior. Review every such fallback for production fail-closed behavior before declaring production readiness.
- Confirm extension permissions, service-worker recovery, actual site blocking, and device secret protection on supported Chrome and Edge versions.
- Confirm Rust credentials use Windows-protected storage and verify collector enrollment, offline queue acknowledgements, and revocation on Windows.
- No real-time dashboard push channel or full PostgreSQL-backed manager workflow was verified in this pass.

## Commands

From `D:\desktop\task2\DigitalPulse`:

```powershell
npm.cmd run dev:backend
npm.cmd run dev:dashboard
npm.cmd run db:generate
npm.cmd run db:deploy
npm.cmd run test:backend
npm.cmd run test:extension
npm.cmd run test:dashboard
```

Rust workspace commands (from `desktop-agent`):

```powershell
cargo test --workspace
cargo run -p dp-user-agent -- --help
```

## Manual verification steps

1. Configure PostgreSQL and the required environment values in `backend/.env` without committing credentials.
2. Generate the client, apply migrations, and start backend and dashboard.
3. Register an organization administrator, create a manager and employee, and assign the employee to the manager.
4. Issue a browser-extension enrollment token, enroll a test extension, and confirm its credential never appears in the popup or logs.
5. Browse allowed and blocked domains; inspect persisted sessions and policy attempts separately.
6. Confirm the manager can see assigned employee activity and cannot query an unassigned employee or another tenant.
7. Disconnect the collector, generate activity, reconnect, and verify acknowledged records are not duplicated.
8. Revoke the device and verify subsequent heartbeat and event synchronization are rejected.
