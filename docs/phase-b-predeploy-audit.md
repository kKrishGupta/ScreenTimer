# DigitalPulse Phase B Pre-Deployment Repair Audit

Audit date: 2026-11-07

## Final decision

**NOT READY.** The screenshot-specific implementation is well covered by focused tests, but the full backend suite is not green, the PostgreSQL integration tests cannot run without `TEST_DATABASE_URL`, migration status cannot be verified against the configured database, and the working tree contains substantial unrelated and out-of-scope changes. No commit, deploy, database reset, or production-data change was performed.

The reported `145 total / 131 passed / 10 failed / 4 skipped` count was not reproduced exactly. The executed suite reported **145 tests, 131 passed, 9 failed, and 4 skipped**. The nine observed failures are listed below; the count discrepancy itself is a remaining audit issue.

## Backend test failures

| Test | Classification | Finding |
|---|---|---|
| `analytics-accounting.test.js` — overlapping app/browser intervals | Stale fixture/expectation | The numerical result passed (`90` active minutes). The assertion expects a legacy manager `OR` relation. Current analytics scopes canonical employees with `where.device = { userId }`; the current role model normalizes legacy manager values and the service has no manager-specific relation branch. No Phase B diff touches this service. |
| `auth-registration-security.test.js` — invitation uses stored identity | Stale role expectation | The test creates `Roles.MANAGER`, but the canonical role set is now `SUPER_ADMIN`, `ADMIN`, and `EMPLOYEE`. Invited accounts are intentionally created as `EMPLOYEE`; the test expects the removed manager role. Credentials and organization identity remained protected. |
| `auth-registration-security.test.js` — differing existing role | Existing baseline/API-policy mismatch | Existing same-organization accounts are attached without changing credentials or role. The implementation returned `200` and preserved the role; the test expects a legacy `409 INVITATION_ROLE_CONFLICT`. This is unrelated to screenshot monitoring and was not changed. |
| `employee-setup-reminder.test.js` — manager scope | Fixture/isolation problem | `Roles.MANAGER` is not a canonical constant. The test helper falls back to an administrator session, so the “other manager” is authorized and receives the cooldown response. The route itself rejects non-administrators and scopes the target by organization. |
| `p0-security-audit.test.js` — manager accessing assigned employee | Fixture/role-model problem | The manager fixture uses the removed role constant and does not produce the intended canonical manager authorization context. The observed request was rejected with `403`, which is fail-closed. |
| `p0-security-audit.test.js` — revoked device event ingestion | Fixture setup problem | The test cannot create its enrollment token because its admin fixture uses the removed `Roles.ORGANIZATION_ADMIN` constant and authenticates as a non-admin. The `403` occurs before device enrollment; revocation behavior was covered by passing device tests. |
| `p0-security-audit.test.js` — cryptographic heartbeat | Fixture setup problem | Same invalid administrator-role fixture prevents enrollment-token creation. The cryptographic heartbeat implementation was independently exercised by the device tests and does not weaken authentication. |
| `p0-security-audit.test.js` — employee administrative endpoint | Stale response-shape expectation | The endpoint returned `403` with the existing `{ error: 'FORBIDDEN', message: ... }` shape. The test reads `error.message`, which is undefined. Authorization itself is correctly denied. |
| `planner.test.js` — delete task response | Existing baseline/API contract mismatch | The route deletes within organization/user scope and returns `{ success, message }`; the test expects an older `deletedId` field. No Phase B file changes this route. |

No tenth failing test appeared in the executed output. The supplied count and the current run therefore disagree and should be reconciled before deployment.

## Focused screenshot backend tests

Executed focused screen tests:

```text
node --test tests/screen.test.js tests/screen-upload.test.js tests/screen-governance.test.js
```

Result: **11 passed, 0 failed**.

Coverage passed for authenticated upload, image validation, deduplication, tenant/device ownership, consent and acknowledgement, revocation, five-minute authorization, organization schedule including overnight windows, private storage, retention cleanup, admin-only gallery access, and tenant-scoped policy mutations.

## Browser-extension tests

Executed:

```text
npm.cmd test
```

Result: **43 passed, 0 failed**.

Screenshot, tab, service-worker, scheduler, and sync coverage passed for authorized active-tab capture, disabled organization policy, missing acknowledgement, expired authorization, inactive/hidden/incognito tabs, authorization withdrawal between capture and upload, upload retry, duplicate prevention, worker restart recovery, and visible monitoring state.

## Desktop-agent findings

Executed:

```text
cargo test --workspace
```

Result: **36 passed, 0 failed** across the Rust workspace.

The inspected agent gates server authorization before reading live activity or sending pending data. A denied/expired gate leaves the local queue intact and does not upload it. Screenshot scheduling bounds the server interval and clears pending capture work when authorization is denied. Queue rows are acknowledged per event; rejected or malformed rows are retained/quarantined rather than silently discarded.

Desktop-agent changes are **not Phase B scope** under the stated instruction not to modify Rust during browser screenshot work. They must be isolated or reverted by the owning workstream before deployment; this audit did not alter them.

## Migration compatibility

`npx.cmd prisma validate --schema prisma/schema.prisma` passed.

The relevant migrations are:

- `20261106130000_screen_monitoring_e2e`: creates organization screen-monitoring settings and screenshot metadata/storage fields, adds acknowledgement and device capture fields, and adds the `BROWSER_EXTENSION` device kind.
- `20261106190000_organization_monitoring_defaults`: adds persisted organization monitoring schedule/default metadata with non-null weekday defaults.

The SQL is additive and uses existing foreign-key/index conventions. It does not reset or delete data. However, `npx.cmd prisma migrate status` could not reach the configured Neon PostgreSQL database; it ended with a schema-engine error after identifying the database, without exposing connection details. Compatibility with the actual production migration history is therefore **not verified**. The four PostgreSQL integration tests were skipped because `TEST_DATABASE_URL` was not configured.

## Phase B file list

These files are directly attributable to the browser screenshot pipeline and its minimum backend/package support:

- `apps/browser-extension/background/service-worker.js`
- `apps/browser-extension/background/screenshot-capture.js`
- `apps/browser-extension/background/sync-scheduler.js`
- `apps/browser-extension/background/tab-manager.js`
- `apps/browser-extension/tests/screenshot-capture.test.js`
- `apps/browser-extension/tests/tab-manager.test.js`
- `backend/src/modules/devices/monitoring-authorization.js`
- `backend/src/modules/screen/screen.routes.js`
- `backend/src/modules/screen/screen-storage.js`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261106130000_screen_monitoring_e2e/migration.sql`
- `backend/prisma/migrations/20261106190000_organization_monitoring_defaults/migration.sql`
- `backend/tests/screen.test.js`
- `backend/tests/screen-governance.test.js`
- `backend/tests/screen-upload.test.js`
- `backend/tests/monitoring-authorization.test.js`
- `scripts/package-employee-downloads.ps1`
- `scripts/verify-employee-downloads.ps1`
- `package.json`
- `package-lock.json`
- `apps/dashboard/src/pages/ScreenMonitoringPage.jsx`
- `apps/dashboard/src/pages/EmployeePortalPage.jsx`
- generated Chrome/Edge extension ZIPs and SHA256 files under `apps/dashboard/public/downloads/`

The following are present in the working tree but are not justified as Phase B browser-screenshot changes: broad dashboard/auth/privacy/policy/device changes, unrelated backend tests and services, desktop-agent/Rust changes, the Windows-agent package and checksum, and other application-wide refactors. They require separate review and must not be silently included in a Phase B deployment.

## Remaining risks and skipped checks

- Full backend suite is not green; the failures are mostly stale expectations or fixture problems, but they must be corrected or explicitly accepted before release.
- The exact tenth failure from the supplied report was not reproduced.
- PostgreSQL integration and migration-status verification remain unavailable without an isolated `TEST_DATABASE_URL`/working database connection.
- The live browser capture and Render deployment were not exercised in this audit.
- The working tree includes unrelated changes and generated artifacts beyond the minimal Phase B scope.

## Evidence-based readiness

The browser screenshot path is **functionally covered in unit/integration-style tests**, and the extension and Rust test suites passed. It is **not deployment-ready** because the full backend suite and production migration verification are incomplete, and the Phase B diff is not isolated from unrelated changes.
