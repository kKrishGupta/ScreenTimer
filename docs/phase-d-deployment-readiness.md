# DigitalPulse Phase D deployment readiness

Date: 2026-11-07. Decision: **NOT READY**.

This is a report-only preparation pass against the current working tree at local HEAD `bdfbfb1ae32f2bbd1f7b7d68f8527deed4988064`. No staging, commit, push, deployment, package rebuild, migration execution, or production-data mutation was performed. Database checks used explicit read-only transactions. No credentials are included.

## Evidence and corrections to the Phase B audit

The Phase B audit was read completely. Its conclusions cannot all be carried forward:

- The actual previous backend output was **145 tests, 131 passed, 10 failed, 4 skipped**. It listed nine failing leaf assertions; the planner parent test also failed. The audit's claim that only nine failures were reproduced is incorrect. Do not waive the reported failures.
- The first requested migration does **not** add the browser-extension enum: it already exists in the schema. It is not purely additive: it backfills capture rows and alters nullability/defaults/foreign keys.
- Previously reported passing checks were 11 screenshot backend tests and 43 extension tests. Rust output lists 13 + 3 + 1 + 6 + 3 + 5 + 8 = **39 passing tests**, although earlier prose said 36. A conditional activity integration test can return early, so even this is not proof of live activity or capture.
- Database connectivity was initially blocked with EACCES inside the sandbox. An approved read-only retry outside the sandbox succeeded in Phase D. Both requested migrations are already applied with matching local checksums.
- The configured local database was inspected; it has **not** been independently established that the Render service uses this same database. Render environment and deployment commit are not available here. The earlier definitive assertion that Render runs the old commit was an inference, not verified deployment metadata.
- Mock capture tests do not exercise browser permission enforcement. Current packaged manifests cannot perform the proposed capture, as detailed below.

No application changes or test repairs were made in Phase D; only this report was created.

## Migration compatibility findings

### Live checks

Connection resolution used `loadConfig().databaseUrl`, so it followed the application's root/backend dotenv loading, canonical DATABASE_URL, and legacy DATABASE fallback. Each connection issued BEGIN READ ONLY and ROLLBACK. Queries read migration names/checksums, information_schema columns, foreign keys, and aggregate counts.

| Migration | Applied time (UTC) | Database checksum matches local bytes |
|---|---|---|
| 20261106130000_screen_monitoring_e2e | 2026-11-06 17:11:05.103 | Yes |
| 20261106190000_organization_monitoring_defaults | 2026-11-06 18:36:33.104 | Yes |

Migration checksums:
- Screen monitoring: `ae73fa7d2012bad84dc53402b935a6731f1e5414b22dedf7d6d34d5d323af478`.
- Organization defaults: `05fa2ac430bd67bcc79054121c3217cddb6733b4c3d10a57beba63f2641efa50`.

Live schema has screen policy settings, nullable capture employee_id/file_path/storage_key, required capture_key/expires_at, device screenshot fields, organization defaults and user override metadata. The capture employee FK is ON DELETE SET NULL. Device user assignment FK is unchanged and ON DELETE SET NULL.

Observed aggregates: **3 devices, 3 assigned, 0 revoked, 0 cross-tenant device/employee assignments, 0 captures, 0 incomplete capture backfills**. These establish current integrity, not historical preservation proof; there is no before-migration snapshot to compare.

Checksums of two older successfully applied migrations differ from the repository, even after normalizing local CRLF to LF:
- `20261102130000_notifications_persistence`
- `20261105170000_simplify_user_roles`

All other successfully applied migrations matched. An older failed P0 migration attempt was marked rolled back before its subsequent successful application. Do not overwrite migration-history checksums or mark migrations applied to hide discrepancies. Recover the applied SQL from the deployment/archive, compare semantics and live schema, and author a reviewed forward correction only where needed. A status command alone is insufficient to prove history/schema consistency.

### 20261106130000_screen_monitoring_e2e

The working copy creates screen_monitoring_settings disabled by default, adds acknowledgement and device capture-selection/status fields, and extends screen_captures. It does not delete/revoke devices or change their IDs, credentials, user_id or organization_id. Employees' organization assignments and consent are not changed; acknowledgement starts null and device selection false on newly added columns.

Existing capture rows are updated with device user_id, capture_key derived from capture ID, status legacy, and captured_at + 30 days expiry. file_path is retained, storage_key stays null, and employee_id can remain null. No existing capture row is explicitly deleted by the current SQL.

Prerequisites: existing organizations/users/devices/screen_captures, UUID support, valid device FKs and non-null captured_at. A broken/orphan capture-device relationship would leave mandatory backfill values null and fail SET NOT NULL. Unique keys derive from capture UUIDs, so valid existing IDs avoid collisions. CREATE/ALTER/UPDATE/index operations can lock and scan tables; rehearse on a production-like clone and measure before use on another installation. This SQL is not idempotent and must not be pasted/rerun over already-created columns.

The Git HEAD version is different: it deleted rows without employee ownership and used a non-null employee FK with cascade deletion. The inspected database has the safer working-copy version already. Consequently, a checkout of HEAD is **not** an acceptable migration rollback. If another environment applied the earlier version, restore that environment's immutable applied migration and use a new forward migration; do not edit its historical SQL.

Legacy files require separate retention review: current cleanup selects storageKey but not filePath, so a legacy row with storageKey=null may lose metadata at expiry without removal of its old file. The inspected database has zero captures, but preservation/retention on installations with legacy files is not verified.

### 20261106190000_organization_monitoring_defaults

Adds nullable organization shift fields/configuration metadata, weekday defaults, and user schedule_override/configuration_updated_at. It sets schedule_override=true where an existing start, end or timezone is present. It does not overwrite existing schedule values, role, consent, monitoring authorization, employee assignment, device identity or revocation.

The backfill deliberately treats partial explicit schedules as overrides. Such users can remain denied for invalid/incomplete schedules; do not silently fill them or enable monitoring. Runtime schedule propagation updates only users without overrides. Migration availability and application schema/client must be released together.

### Compatibility conclusion

Both requested migrations match and are present in the **configured database**. No destructive reset is needed. Neither should execute again there. Full production compatibility remains blocked by older checksum differences, unverified Render database identity, lack of an isolated migration rehearsal and snapshot comparison, and legacy-retention behavior. Do not run migrate dev, migrate reset, db push, seed, or manual DELETE/UPDATE as deployment preparation.

## Complete change classification

Inventory: 56 modified tracked files, 9 pre-existing untracked files, plus this report = 66 paths. Classification describes technical purpose, not historical authorship or permission to include an entire file. Mixed files require hunk review in a separate release checkout. "Required security fix" does not mean the change is fully verified or approved.

| File | Classification | Reason / isolation note |
|---|---|---|
| `apps/browser-extension/background/service-worker.js` | Required screenshot feature | Screenshot initialization and alarm integration; mixed activity transition serialization requires hunk review. |
| `apps/browser-extension/background/sync-scheduler.js` | Required screenshot dependency | Serializes shared runtime tasks. |
| `apps/browser-extension/background/tab-manager.js` | Required screenshot dependency | Focus/idle reconciliation shared by worker; broader activity behavior included. |
| `apps/browser-extension/tests/tab-manager.test.js` | Required screenshot dependency | Reconciliation and serialization coverage. |
| `apps/dashboard/public/downloads/digitalpulse-chrome-extension.zip` | Generated package artifact | Chrome/Edge ZIP/checksum: correct API origin and checksum; missing capture permissions blocks distribution. |
| `apps/dashboard/public/downloads/digitalpulse-chrome-extension.zip.sha256` | Generated package artifact | Chrome/Edge ZIP/checksum: correct API origin and checksum; missing capture permissions blocks distribution. |
| `apps/dashboard/public/downloads/digitalpulse-edge-extension.zip` | Generated package artifact | Chrome/Edge ZIP/checksum: correct API origin and checksum; missing capture permissions blocks distribution. |
| `apps/dashboard/public/downloads/digitalpulse-edge-extension.zip.sha256` | Generated package artifact | Chrome/Edge ZIP/checksum: correct API origin and checksum; missing capture permissions blocks distribution. |
| `apps/dashboard/public/downloads/digitalpulse-windows-agent.zip` | Generated package artifact | Windows agent ZIP/checksum: keep outside browser deployment; provenance/desktop safety unresolved. |
| `apps/dashboard/public/downloads/digitalpulse-windows-agent.zip.sha256` | Generated package artifact | Windows agent ZIP/checksum: keep outside browser deployment; provenance/desktop safety unresolved. |
| `apps/dashboard/src/App.jsx` | Unrelated existing work | Organization routing and personal wellbeing. |
| `apps/dashboard/src/components/layout/Layout.jsx` | Unrelated existing work | Navigation and logout destinations. |
| `apps/dashboard/src/context/AuthContext.jsx` | Unrelated existing work | Logout state handling. |
| `apps/dashboard/src/pages/BlockedActivityPage.jsx` | Unrelated existing work | Blocked-attempt employee names/time. |
| `apps/dashboard/src/pages/DevicesPage.jsx` | Required screenshot dependency | Organization schedule UI and duplicate-save prevention; part of defaults dependency. |
| `apps/dashboard/src/pages/DigitalWellbeingPage.jsx` | Unrelated existing work | Personal analytics UI. |
| `apps/dashboard/src/pages/EmployeePortalPage.jsx` | Required screenshot feature | Browser/desktop collector status. |
| `apps/dashboard/src/pages/LoginPage.jsx` | Unrelated existing work | Role destination routing. |
| `apps/dashboard/src/pages/RegisterPage.jsx` | Unrelated existing work | Organization redirect. |
| `apps/dashboard/src/pages/RoleHomePage.jsx` | Unrelated existing work | Home route behavior. |
| `apps/dashboard/src/pages/ScreenMonitoringPage.jsx` | Required screenshot feature | Gallery collector labels and policy/status display; includes additional search/UI work. |
| `apps/dashboard/src/test/app.test.jsx` | Required screenshot dependency | Screen route fixtures and gallery assertions; suite still needs repair. |
| `apps/dashboard/src/test/devices-schedule.test.jsx` | Required screenshot dependency | Organization schedule save coverage. |
| `backend/.env.example` | Required screenshot dependency | Private storage configuration names. |
| `backend/package.json` | Required screenshot dependency | Cloudinary runtime dependency. |
| `backend/prisma/migrations/20261106130000_screen_monitoring_e2e/migration.sql` | Required security fix | Preserves legacy rows and uses SET NULL owner FK; already applied matching local bytes in inspected DB. |
| `backend/prisma/schema.prisma` | Required screenshot dependency | Nullable legacy capture owner and schedule-default fields; substantial formatting noise. |
| `backend/src/modules/auth/auth.service.js` | Required screenshot dependency | Mixed: schedule override writes required by defaults; registration persistence hardening is a separate security change. Do not copy entire file without review. |
| `backend/src/modules/devices/devices.routes.js` | Required screenshot dependency | Transactional organization schedules and timezone propagation. |
| `backend/src/modules/devices/monitoring-authorization.js` | Required screenshot dependency | Shared organization screenshot schedule evaluator. |
| `backend/src/modules/employees/employees.routes.js` | Required screenshot dependency | Explicit employee schedules marked as overrides. |
| `backend/src/modules/policies/policies.routes.js` | Unrelated existing work | Blocked-activity employee/policy joins. |
| `backend/src/modules/privacy/privacy.routes.js` | Required security fix | Delete provider objects before metadata to retain retry references. |
| `backend/src/modules/screen/screen-storage.js` | Required security fix | Authenticated Cloudinary storage, validated keys and signed private retrieval. |
| `backend/src/modules/screen/screen.routes.js` | Required screenshot feature | Browser eligibility, upload policy checks, validation, storage and gallery. |
| `backend/tests/auth-rbac.test.js` | Unrelated existing work | Registration/session fixtures and canonical roles. |
| `backend/tests/auth-registration-security.test.js` | Unrelated existing work | Registration endpoint/role expectations. |
| `backend/tests/monitoring-authorization.test.js` | Required screenshot dependency | Organization schedule inheritance and scope. |
| `backend/tests/p0-security-audit.test.js` | Required security fix | Screen endpoint RBAC assertions; unrelated legacy role fixture failures remain. |
| `backend/tests/role-scope-regression.test.js` | Required security fix | Screen tenant/admin scope and metadata status tests; shared fixtures also serve planner/privacy. |
| `backend/tests/screen-governance.test.js` | Required security fix | Private storage/token access tests. |
| `backend/tests/screen.test.js` | Required screenshot feature | Screenshot gates/schedules/retention tests. |
| `backend/tests/security-regressions.test.js` | Required security fix | Employee rejection on screen admin endpoints. |
| `deploy/production.env.example` | Required screenshot dependency | Cloudinary configuration template. |
| `desktop-agent/crates/dp-core/src/lib.rs` | Unrelated existing work | Formatting only; not needed for browser release. |
| `desktop-agent/crates/dp-platform-windows/src/data_protection.rs` | Unrelated existing work | Formatting only; existing DPAPI semantics. |
| `desktop-agent/crates/dp-platform-windows/src/lib.rs` | Required screenshot dependency | Exports tray module; only needed if desktop fixes ship. |
| `desktop-agent/crates/dp-platform-windows/src/tray.rs` | Required security fix | Visible desktop indicator; separate desktop scope requiring validation. |
| `desktop-agent/crates/dp-storage/src/paths.rs` | Unrelated existing work | Formatting of existing non-destructive SQLite migration; no browser dependency. |
| `desktop-agent/crates/dp-user-agent/src/main.rs` | Required security fix | Desktop deadline/lock/indicator gates; queue safety remains incomplete. |
| `desktop-agent/crates/dp-user-agent/src/screenshot.rs` | Required security fix | Queue-denial cleanup, DPAPI cleanup and retry bounds; missing per-upload recheck remains. |
| `desktop-agent/crates/dp-user-agent/src/sync.rs` | Required security fix | Explicit indicator/deadline parsing and upload acknowledgement validation; includes formatting. |
| `package-lock.json` | Required screenshot dependency | Cloudinary/q dependency resolution. |
| `package.json` | Required screenshot dependency | Extension-only packaging command. |
| `scripts/package-employee-downloads.ps1` | Required screenshot dependency | Required module and worker checks. |
| `scripts/verify-employee-downloads.ps1` | Required screenshot dependency | Checks packaged worker integration; source deployment config can differ. |
| `apps/browser-extension/background/screenshot-capture.js` | Required screenshot feature | Active-tab capture and policy/upload checks; permission/deadline concerns below. |
| `apps/browser-extension/tests/screenshot-capture.test.js` | Required screenshot feature | Mocked capture tests; browser permissions not exercised. |
| `apps/dashboard/src/test/screen-monitoring.test.jsx` | Required screenshot feature | Mocked gallery/status/settings coverage. |
| `backend/prisma/migrations/20261106190000_organization_monitoring_defaults/migration.sql` | Required screenshot dependency | Schedule defaults/override metadata, already applied in inspected DB. |
| `backend/scripts/diagnose-screenshots.js` | Required screenshot dependency | Read-only aggregates; unlike app config, uses cwd dotenv and DATABASE_URL only. |
| `backend/tests/screen-upload.test.js` | Required security fix | Authenticated JPEG upload/private access and revocation regression coverage. |
| `docs/AUTOMATED_SCREEN_MONITORING.md` | Required screenshot dependency | Screenshot operational documentation; desktop-only statements are stale. |
| `docs/phase-b-predeploy-audit.md` | Required screenshot dependency | Prior audit evidence; corrections below supersede erroneous claims. |
| `docs/screenshot-repair-verification.md` | Required screenshot dependency | Prior desktop repair evidence; browser-ineligible statement is stale. |
| `docs/phase-d-deployment-readiness.md` | Required screenshot dependency | This deployment preparation report. |

The unchanged manifest and packaging configuration generator must also be part of the forthcoming permission repair review. They are not omitted modified files; they currently have no diff.

Isolation procedure: preserve the current worktree; create a separate release checkout from the verified deployed baseline when its SHA is known. Transfer only reviewed feature/dependency/security hunks and their tests. Include the Cloudinary lockfile dependency and organization-default schema/runtime dependency chain together. Keep routing, blocked-activity, wellbeing and unrelated registration work separate. Desktop fixes belong to a separately reviewed desktop release if included at all. Do not copy all changes in auth.service.js merely to obtain schedule_override writes. No staging or checkout creation occurred in this pass.

## Required production configuration

Repository commands:
- Backend start from repository root: `npm run start:backend` -> backend `node src/server.js`.
- Client generation: `npm run db:generate --workspace @digitalpulse/backend`.
- Migration deployment: `npm run db:deploy --workspace @digitalpulse/backend` -> `prisma migrate deploy`.
- Read-only migration status: `npm run db:status --workspace @digitalpulse/backend`.
- Native Node runtime must satisfy package engines >=20.19; repository Docker image uses Node 22.
- backend/Dockerfile currently runs migration deployment followed by backend start. Review this before rollback because the old image would also execute its migration command. Docker build runs Prisma generate, whose config requires a database URL even at build time; validate build configuration without embedding production credentials in image layers. Do not assume runtime Render variables are present in Docker build.

For a native Node service with repository root as working directory, proposed commands after blockers are resolved:
```sh
# Build
npm ci --include=dev
npm run db:generate --workspace @digitalpulse/backend
# Controlled pre-deploy migration step (single migration runner)
npm run db:deploy --workspace @digitalpulse/backend
# Runtime start
npm run start:backend
```
Use the existing Render service's actual runtime mode; its live build/start settings were not inspected. Prefer one explicit migration step over concurrent migration attempts on each instance.

| Variable | Required production meaning |
|---|---|
| NODE_ENV | production |
| HOST | 0.0.0.0 |
| PORT | Render-provided listening port; application must honor it |
| DATABASE_URL | Existing approved PostgreSQL database, TLS enabled; compare privately with inspected database. Canonical value overrides DATABASE. Never point tests to production. |
| PUBLIC_APP_URL | Exact HTTPS dashboard origin without path/query/fragment |
| PUBLIC_APP_DOMAIN | If set, must match PUBLIC_APP_URL hostname |
| CORS_ORIGINS | Exactly PUBLIC_APP_URL origin under current validation |
| INVITATION_ACCEPT_URL / PASSWORD_RESET_URL | Same HTTPS dashboard origin; otherwise derived from PUBLIC_APP_URL |
| SCREENSHOT_STORAGE_PROVIDER | cloudinary for current remote storage design; default is local, so set explicitly |
| SCREENSHOT_ENCRYPTION_KEY | Stable random secret at least 32 characters; needed for viewer-token signing even with Cloudinary |
| CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET | Server-only credentials for authenticated image uploads/downloads/deletion |
| SCREENSHOT_STORAGE_DIR | Only for local provider; needs persistent writable storage and existing encryption key. Do not switch providers while old objects remain without an explicit migration. |
| TRUSTED_PROXIES | Only verified proxy IPs/CIDRs if needed; default false; do not use wildcard trust |
| ALLOW_PUBLIC_REGISTRATION | Explicit business choice; default false in production |
| SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / EMAIL_FROM | Existing mail configuration for onboarding/reset delivery; SMTP_PASSWORD and SMTP_FROM aliases supported |
| LOG_LEVEL | Valid configured level; avoid logging credentials or image bodies |
| TEST_DATABASE_URL | Isolated migrated test database only; not the production connection |
| VITE_API_BASE_URL | /api/v1 on dashboard build |
| VITE_DEVICE_BACKEND_URL | https://screentimer.onrender.com for employee setup instructions |
| EXTENSION_PRODUCTION_BACKEND_URL | https://screentimer.onrender.com for extension packaging |

Dashboard production requests use same-origin /api/v1. apps/dashboard/vercel.json rewrites to https://screentimer.onrender.com/api/v1. Local Vite proxy defaults to 127.0.0.1:3001 and can use DP_BACKEND_URL. Local source extension also currently targets loopback; it must not be distributed as the production package.

Both existing packaged deployment.js files target https://screentimer.onrender.com. Checked hashes match their sidecars:
- Chrome: `1b767a9186e7e3916cb62f746b7dd42f9e8689394ba29e1901640854aa5bcd05`
- Edge: `2ec25d8e1dd1eaab6d088330c7e8291ffb8f2b6f024a866b9155c3a61f731c26`

These hashes identify inspected artifacts, not approved artifacts. Both manifests lack activeTab and <all_urls>; they only grant the backend host plus tabs/webNavigation/idle/storage/alarms/declarativeNetRequest. Chrome requires activeTab or <all_urls> for captureVisibleTab, and activeTab requires a user invocation. A timer does not grant it. Permission/interaction design must be repaired with explicit user authorization and preserved active-tab/incognito restrictions before packaging again. See [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab). Mock tests bypass this real browser constraint.

No secrets or Render environment values were inspected or printed. Same API URL suggests intended routing, but does not prove deployed Vercel settings or Render database identity.

## Security and functional release blockers

1. **Packaged capture permission absent:** both production ZIPs fail the documented capture permission prerequisite. Backend deployment alone will not fix capture.
2. **Employee status ownership fields omitted:** /screen-monitoring/me selects devices without userId/organizationId and passes them to evaluateDevicePolicy. Selected devices therefore receive DEVICE_OWNER_REQUIRED in that status path. Authenticated device-policy uses a fuller device record, so this can produce contradictory UI/runtime status.
3. **Browser authorization/indicator gaps:** expiry is checked while reading policy, followed by awaited indicator/tab operations before capture/upload, with no final timestamp check directly at each side effect. applyMonitoringState sets the badge on for generic monitoring but does not explicitly clear it on denial. Network failures can leave a stale badge. Deadline-crossing and denial/error tests plus a live indicator check are required.
4. **Desktop queue safety incomplete:** tick checks a cached policy once before flush_pending. try_upload/upload_screen_capture do not fetch current authorization or recheck allowed_until for each queued upload; a slow flush can cross expiry and still transmit pixels. Backend rejects unauthorized persistence, but this does not satisfy the client requirement never to upload after expiry/revocation. Passing queue tests cover denied/invisible entry policy, not mid-flush revocation. Hold the desktop artifact.
5. **Historical migration checksums differ:** reconcile the two older migrations with applied artifacts and live schema before release.
6. **Production identity and snapshot/rehearsal absent:** Render SHA/database identity and rollback target are unverified. No production-like migration replay or restore drill was executed.
7. **Full suite remains red:** nine leaf failures plus failing planner parent total ten failures. Legacy role fixtures/response assertions require repair and security review, not permission loosening. Four isolated PostgreSQL tests remain skipped.
8. **Retention/legacy behavior:** legacy file deletion is incomplete as noted above. Image-serving routes do not explicitly filter expiresAt; expiry is handled by periodic cleanup, so strict expiry access needs review, particularly on cleanup failure/backlog.
9. **Distribution/documentation:** screen device cards still label every device Windows Desktop Agent although gallery cards differentiate browsers. Prior docs incorrectly say browser devices are ineligible. Full source/package parity must be rechecked after repairs; a matching checksum alone only verifies its own ZIP.
10. **Change isolation:** the working tree is mixed and uncommitted. A release manifest and tested clean candidate do not yet exist. No claim is made that the exact live DEVICE_NOT_ELIGIBLE cause or deployed commit is now proven.

Local policy logic accepts non-revoked DESKTOP_AGENT, or BROWSER_EXTENSION with platform.lowercase()=windows and browser.lowercase() in chrome/edge. It then requires selection, employee assignment to the same organization, enabled screen settings, acknowledgement, active account, consent, admin authorization, employee schedule and organization screen schedule. allowedUntil is their earlier deadline, and visibleIndicator is true. Device middleware validates cryptographic credentials and rejects revoked devices. Upload checks current and capture-time policy, metadata/image dimensions, tenant-derived storage keys and duplicate capture keys. Gallery is administrator/tenant scoped with user-bound signed image tokens. These code findings do not resolve the client-side blockers above.

## Safe deployment sequence (future execution only)

Do not execute the write/deploy commands until blockers above have been resolved and a candidate approved. Commands below are proposed, not performed in Phase D.

1. Obtain and record the currently successful Render deployment SHA, dashboard deployment identifier, database identity (privately), storage provider and artifact hashes. Confirm the Render database is the one checked here using read-only history/schema comparisons. Do not infer SHA from local HEAD or HTTP policy output.
2. Reconcile historical migrations. Both requested migrations are already applied on the inspected database: expect them to be no-ops under migrate deploy. Preserve applied SQL and history. For any other database, verify its checksums and schema first; use reviewed forward migrations for semantic differences.
3. Create the isolated release candidate and repair the permission, status, deadline/indicator and relevant retention issues. Keep existing enrolled identity/storage; do not uninstall/re-enroll devices as a deployment shortcut. Resolve the full backend test failures without weakening security.
4. Use a separate staging database cloned from an approved snapshot. Securely inject its DATABASE_URL and TEST_DATABASE_URL into the staging process, ensure neither is production, and run from the candidate repository root:
```sh
npm ci --include=dev
npm run db:generate --workspace @digitalpulse/backend
npm exec --workspace @digitalpulse/backend -- prisma validate
npm run db:status --workspace @digitalpulse/backend
npm run db:deploy --workspace @digitalpulse/backend
npm run db:status --workspace @digitalpulse/backend
npm run test:backend
npm run test:extension
npm run test:dashboard -- --run
npm run lint:dashboard
npm run build:dashboard
git diff --check
```
On Windows use npm.cmd. Focused backend rerun from backend directory:
```sh
node --test tests/screen.test.js tests/screen-upload.test.js tests/screen-governance.test.js
```
If desktop is intentionally included, run `cargo test --workspace` from desktop-agent and add per-upload deadline/revocation tests before any release build. These tests do not start a real monitoring session.
5. Compare migration replay counts, assignments and revocation state with staging snapshot baselines. Test preservation using legacy capture rows, unassigned devices, explicit employee overrides and organization defaults. Verify backup restore separately. Do not copy production screenshots into developer logs.
6. Run real Chrome and Edge acceptance on harmless pages in staging using authorized test employees. Only after source permission changes are reviewed, regenerate affected extension packages in the release checkout with `npm run package:extensions`. Inspect manifest/deployment.js/worker/module, compare all runtime contents to that candidate, and verify SHA256 sidecars. The full download verifier also checks Windows binaries and local config equality; its failure must not trigger replacement of unrelated Windows packages.
7. Take an approved database snapshot and preserve current storage/key configuration before production promotion. Confirm restore capability and the known compatible rollback image. Retain existing device records/credentials and employee assignments.
8. Deploy the exact reviewed backend candidate through the existing Render workflow. Use the build/pre-deploy/start commands above. A migration failure stops promotion. Do not run reset, seed or automatic schema repair. Stop on schema/history drift; never blindly mark it resolved.
9. Run health checks:
```sh
curl --fail --silent --show-error https://screentimer.onrender.com/api/v1/health/live
curl --fail --silent --show-error https://screentimer.onrender.com/api/v1/health
```
Verify status/service/database-up from responses. Health does not prove code SHA, storage or capture functionality. Verify the deployment SHA in the service deployment record separately.
10. Promote the tested dashboard build with /api/v1 same-origin routing. Verify its /api/v1/health reaches the intended service. Distribute corrected Chrome/Edge artifacts to the authorized test group, preserving installed extension ID/storage. Permission updates must be acknowledged normally.
11. Complete the acceptance procedure below before wider rollout. Stop rollout if capture, authorization denial, image privacy, indicator or identity preservation fails.

## Post-deployment screenshot acceptance

Use an explicitly authorized test employee and organization. Keep captured content harmless (for example https://example.com). Do not use production employees' pages to test.

1. Record device ID, kind, platform, browser, organizationId, userId, isRevoked and selection without recording secrets. Confirm same organization/user before and after upgrade; use existing enrollment credentials.
2. Verify Chrome and Edge policies separately. With all gates satisfied, expect allowed=true, visibleIndicator=true, future allowedUntil and the configured interval (at least 300 seconds). The device must be assigned and selected; active employee, consent, acknowledgement and organization schedule must all be valid.
3. Check the toolbar indicator physically. Verify it reflects screenshot authorization, goes inactive on expiry/withdrawal, and capture is blocked if indicator setup fails. Inspect only sanitized service-worker errors/status; never dump storage.local, credentials or authorization headers.
4. Focus a non-incognito eligible HTTP(S) tab in the visible browser window and wait the configured interval. Verify actual captureVisibleTab output is JPEG with matching dimensions, fresh metadata/key, policy recheck immediately before upload, and authenticated POST /api/v1/screen-monitoring/captures?deviceId=...
5. Record actual HTTP status and sanitized response: normally 201 with success, captureId and capturedAt. Replay only the same authorized staging capture/key for a deduplication test; expect one record and a deduplicated acknowledgement. No raw tokens, image bodies or signed URLs in logs.
6. Read the capture row by returned ID and confirm device/user/tenant, storage key, status and expiry. Open the organization screen-monitoring gallery, verify employee, device, browser, collector kind and timestamp, then actually open the image. Verify authenticated Cloudinary storage is private and direct unauthenticated access is denied.
7. In staging/approved test records, exercise missing acknowledgement, no assignment, revoked device, disabled organization, missing consent/admin authorization, after-hours/expired policy, inactive/hidden/minimized/incognito tabs, failed indicator and authorization withdrawal between capture and upload. Expect no unauthorized capture/upload, 401 for invalid credentials, and denial for revoked or cross-tenant access. Do not revoke or reassign real production devices for this test.
8. Exercise network failure, service-worker restart and scheduler recovery. Verify no persisted unauthorized browser image, no duplicates from ambiguous upload acknowledgement, and no old desktop queued image transmission after deadline or revocation.
9. Test private-image access as another employee/tenant and with expired/tampered viewer tokens; all must fail. Test expiry and storage deletion failure on isolated staging data; verify expired content is not served and metadata survives provider deletion failure for retry.
10. Archive sanitized evidence: deployed commit IDs, package hashes, device ID, capture ID/time, HTTP response, policy reason codes and gallery verification result. This Phase D pass produced no live screenshot or upload record.

## Rollback procedure

Rollback is conditional on a tested, known compatible previous release; local HEAD is not automatically suitable.

- On failed canary, halt distribution. An authorized operator can disable screenshot monitoring through the existing administrator control for the affected test organization while investigating; do not revoke devices or erase employee consent.
- Promote the previously verified backend/dashboard artifacts through the existing deployment workflow, keeping database connection, device IDs, secrets, storage provider and encryption/signing key unchanged.
- Leave additive columns/tables and valid applied migration records in place. Do not run SQL down migrations, reset, drop columns/tables, or overwrite checksums.
- Ensure the rollback image's startup will not replay incompatible migrations; current Docker CMD contains db:deploy, so test this exact behavior in staging first. The old HEAD migration differs from the version present in the inspected database.
- Old code must be tested against the expanded schema and nullable legacy employee_id, and against the current object storage provider. Do not revert Cloudinary-backed records to a local-only reader.
- Preserve extension identity/storage when reverting to a tested artifact. Do not uninstall, re-enroll or replace device records.
- Verify health, login, policy denials, assignment/heartbeat and private-image behavior after rollback. Keep screenshot collection paused until acceptance passes.
- Database restore is a separate incident operation with explicit approval, a verified backup and reconciliation of post-snapshot writes and object storage. No automatic production restore is part of this plan.

## Remaining evidence required

Live checks in this pass verified the configured database's two migration checksums, relevant columns/FKs and aggregate assignment integrity, plus production ZIP URLs/hashes. Earlier passing tests are historical evidence and were not rerun during this report-only phase. Production backend SHA/environment, actual Render database identity, private provider runtime, real browser capture, end-to-end upload/gallery, clean candidate isolation, full suite repair and migration rehearsal remain unresolved.

**NOT READY**. Database access is now available for the configured database, but older migration mismatches and concrete capture/runtime issues prevent safe production promotion.

