# DigitalPulse screenshot and device-lifecycle repair report

Date: 2026-11-08 (Asia/Calcutta)

Deployment decision: **NOT READY**

This report continues the completed screenshot-monitoring repair with device lifecycle management. Starting HEAD was `483e6edefb06a375757eb7bf363c45381d254458`. The continuation began from a clean working tree. No reset, production deployment, production-data mutation, destructive migration, credential replacement or enrollment replacement was performed.

## Architecture and compatibility

The mandatory pre-change audit is recorded in `docs/device-lifecycle-architecture-audit.md`. Device records are shared by authentication, heartbeat, activity ingestion, screenshot policy/upload, employee assignment and historical activity/capture relations, so lifecycle actions retain device rows.

Authentication remains the repository's HttpOnly cookie/session implementation with canonical `SUPER_ADMIN`, `ADMIN` and `EMPLOYEE` RBAC. The directive's JWT description did not match the codebase; the working authentication system was not replaced.

Lifecycle, connection and screenshot authorization are separate:

- Lifecycle: pending enrollment token, active, revoked or archived.
- Connection: online, offline or unknown, derived from an authenticated heartbeat.
- Screenshot authorization: authorized, unauthorized or expired, independently gated by enrollment, ownership, tenant, device selection, account state, acknowledgement, employee consent, administrator authorization and employee/organization schedules.

An online collector is not automatically authorized. An offline collector is not revoked. Revoked and archived collectors cannot become operational through an ordinary heartbeat.

## Implemented repairs

1. Enrollment tokens remain cryptographically random, SHA-256 hashed, expiring and one-time. They now record creator, consuming device, maximum/use count and one-time expiry audit state. Raw tokens and device secrets are never audited.
2. Creating a token does not modify existing devices. Re-enrolling the same stable active ID updates only the exact matching organization/employee/collector row and rotates its secret. Mismatched, revoked or archived IDs fail closed. A genuinely new stable ID creates a separate row.
3. Revocation is administrator-only and tenant-scoped. It records actor, time and reason; clears the server secret hash/salt and screenshot selection; rejects heartbeat, activity and screenshot authentication; preserves the device and all historical references; and is not restorable.
4. Archival is administrator-only and tenant-scoped. It disables operation and screenshot selection, excludes the row from normal lists, preserves credentials/history for explicit restore, and never restores a revoked credential.
5. Duplicate handling is review-only. Candidate groups require the same tenant, employee, collector type, normalized display name and platform, but stable IDs are shown separately and are never merged or deleted automatically.
6. Bulk revoke/archive requires explicit checkbox selection and returns per-device success/failure. Every successful lifecycle action writes its own audit event.
7. The dashboard adds All, Active, Offline, Pending, Revoked and Archived filters; separate status columns; employee/device metadata; details/audit history; pending-token revoke; authorize/revoke/archive/restore actions; confirmation/reason dialogs; duplicate review and recoverable bulk results. Existing consent, schedule, time-zone and self-enrollment UI remains.
8. Browser collectors show explicit Revoked/Archived status, stop monitoring/capture/upload and preserve stable identity plus queued events. Archived collectors resume only after a healthy heartbeat confirms administrator restore.
9. The Windows agent parses structured lifecycle rejection, persists/displays lifecycle state, stops collection/synchronization and preserves Credential Manager identity plus SQLite queues. Its screenshot scheduler now honors the approved 60-second minimum.
10. Screenshot capture remains fail-closed with employee-operated optional `<all_urls>` permission, visible badge, active focused non-incognito HTTP(S) tab, generation/attempt invalidation, policy recheck, bounded upload, private storage and tenant-scoped audited image access.
11. Gallery, employee-capture, metadata, private-image and latest-capture status queries require `expiresAt > now`. Retention cleanup and explicit deletion intentionally remain able to find expired rows.

## Schema and migration

`backend/prisma/migrations/20261108010000_device_lifecycle_management/migration.sql` is additive only. It adds token accountability fields, revocation actor/reason fields, archival fields, indexes and a token usage-bounds check. Existing device IDs, secret hashes, ownership and historical records are not rewritten. Prisma validation and client generation pass. The migration was not run against any database.

## Additive APIs

- `POST /api/v1/devices/enrollment-tokens/:tokenId/revoke`
- `POST /api/v1/devices/:id/archive`
- `POST /api/v1/devices/:id/restore`
- `GET /api/v1/devices/:id`
- `GET /api/v1/devices/:id/audit`
- `GET /api/v1/devices/duplicate-review`
- `POST /api/v1/devices/bulk-actions`
- `GET /api/v1/devices?includeArchived=true`

Existing endpoint paths and response fields remain. The existing omitted-`deviceKind` contract still defaults to a desktop-agent token; explicitly invalid kinds are rejected.

## Main files changed

- `backend/prisma/schema.prisma` and the additive lifecycle migration.
- `backend/src/modules/devices/devices.service.js` and `devices.routes.js`.
- `backend/src/modules/screen/screen.routes.js`.
- `apps/dashboard/src/components/devices/DeviceLifecycleManager.jsx`, `pages/DevicesPage.jsx` and `lib/api.js`.
- `apps/browser-extension/background/sync-client.js`, `service-worker.js` and `popup/popup.js`.
- `desktop-agent/crates/dp-user-agent/src/main.rs`, `sync.rs` and `screenshot.rs`.
- Focused backend, dashboard, browser-extension and Rust tests.
- `docs/device-lifecycle-architecture-audit.md` and this report.

## Automated evidence

| Check | Exact result |
|---|---|
| Full backend suite | 149 total; 145 passed; 0 failed; 4 skipped |
| Focused backend lifecycle suite | 9 passed; 0 failed; 0 skipped |
| Browser extension suite | 67 passed; 0 failed; 0 skipped |
| Full dashboard suite | 8 files; 62 passed; 0 failed |
| Dashboard lint | Completed; 0 errors; 8 pre-existing unrelated warnings |
| Dashboard production build | Passed; existing chunk-size warning remains |
| Desktop-agent Rust workspace | 40 passed; 0 failed; 0 ignored |
| Rust formatting | Passed after `cargo fmt --all` |
| Prisma schema validation | Passed |
| Prisma client generation | Passed |
| `git diff --check` | Passed |

The four skipped PostgreSQL tests are database health, migration/seed lifecycle, invitation lifecycle and PostgreSQL self-enrollment lifecycle. `TEST_DATABASE_URL` is unset, `psql` is unavailable and no PostgreSQL service is installed. Docker was not used, as requested. `DATABASE_URL` was never used as a test fallback.

## Screenshot and service-worker review

The capture factory is instantiated once. Capture listeners invalidate only an established in-flight target; service-worker tab/focus listeners separately reconcile activity state, so they are not duplicate side effects. `stop()` increments generation, clears the deadline/timer, aborts upload and serializes badge removal. `expiryVersion`, deadline comparison and named alarm replacement prevent stale alarms from invalidating or extending a newer lease. Same-target activation and ordinary heartbeat do not invalidate a capture. Fullscreen is accepted when the normal browser window remains focused; minimized, hidden, discarded, inactive, incognito and unsupported targets are rejected.

## Isolated Chrome and Edge candidates

Current candidates were generated under `artifacts/device-lifecycle-candidates-20261108/`, not under public downloads:

| Candidate | SHA-256 |
|---|---|
| Chrome | `4d89a2545d813499dc4fec37b9023dd80abf3d847746a7ff25e646d637aed7dc` |
| Edge | `fa50ef4ab231ff590d1f2473a3fbb861719d636b193a134917ece7841b5c3a59` |

The packaging script verified structure, production HTTPS configuration, permission model, credential-pattern exclusions and sidecars. Public artifacts were not overwritten; their hashes remain `1b767a9186e7e3916cb62f746b7dd42f9e8689394ba29e1901640854aa5bcd05` (Chrome) and `2ec25d8e1dd1eaab6d088330c7e8291ffb8f2b6f024a866b9155c3a61f731c26` (Edge).

The source manifest has no fixed `key`, and no signing key or enterprise update identity is present. Candidate IDs therefore cannot be proven equal to enrolled IDs from repository data. Do not distribute them until installed Chrome and Edge profiles or enterprise policy records confirm identity continuity. No extension storage, device ID or credential was read, cleared or regenerated.

## Manual Chrome/Edge staging acceptance

An employee/operator must approve the browser permission in the browser UI. Automation must not approve it.

1. Provision an isolated staging PostgreSQL database and set only `TEST_DATABASE_URL`. Apply migrations there and run all four skipped tests first.
2. Use approved staging accounts, an HTTPS backend and harmless HTTP(S) pages. Record each installed Chrome/Edge extension ID and popup device ID before changing files.
3. Back up the installed extension folder. Extract the matching candidate into the same folder and use Reload; do not uninstall, clear storage, move the unpacked path, replace enrollment or generate credentials. Confirm extension ID and device ID are unchanged. For managed deployment, confirm the candidate is signed/deployed under the existing enterprise ID.
4. In Chrome, open the popup, read the disclosure and manually approve the optional host-permission prompt. Separately record decline, grant and removal. Permission alone must leave authorization and the badge off.
5. Repeat the employee-operated permission flow in Edge and confirm the popup identifies Edge while preserving identity.
6. Enable organization policy, acknowledgement, employee consent, device selection, administrator authorization and active employee/organization schedules. Confirm the ON badge appears only after all gates pass.
7. Capture one harmless visible active page independently in Chrome and Edge. Record sanitized attempt/capture IDs, timestamps and HTTP status. Verify PostgreSQL metadata, private object persistence and matching MIME/size/dimensions, then open the image from the organization administrator gallery.
8. Confirm an employee and an administrator from another organization cannot list metadata or fetch the image. Confirm expiry blocks metadata/image delivery before cleanup.
9. During separate pending attempts, switch tabs, navigate, lose focus, minimize, become idle/locked, remove permission, withdraw policy and restart the worker/browser. Confirm bytes are discarded, no upload occurs and stale badge/authorization is cleared.
10. Revoke a staging device with a reason. Confirm heartbeat, activity and screenshot operations return `DEVICE_REVOKED`; the collector shows Revoked; local queues remain; restore fails; audit identifies administrator and reason.
11. Archive a separate device. Confirm it shows Archived and remains non-operational. Restore administratively and confirm only a subsequent healthy heartbeat returns it to Active. Verify history remains.
12. Generate a new token while an existing device stays active and confirm no automatic revoke/disconnect. Reconnect the same stable ID with an approved token and confirm no duplicate row. Enroll a genuinely new stable ID and confirm a separate row.

No actual browser permission grant, real staging capture, database row, private gallery open or live unauthorized-access rejection was observed in this environment. No capture IDs are claimed.

## Final pre-production acceptance audit — 2026-11-08

The requested final audit was attempted without changing application code. A dedicated staging database, approved staging accounts and enrolled test-browser profiles were not available in this environment. The configured application `DATABASE_URL` was not used, contacted or copied into `TEST_DATABASE_URL`. Production data, existing credentials, public ZIPs and deployment state were not modified.

### Environment gate evidence

| Gate | Observed evidence |
|---|---|
| Isolated database | `TEST_DATABASE_URL` absent; `psql` absent; no local PostgreSQL service detected |
| Browser availability | Chrome and Edge executables detected |
| Enrolled test extensions | Profile inspection found 0 installed DigitalPulse extensions across Chrome and Edge profiles |
| Enterprise identity | No Chrome/Edge `ExtensionInstallForcelist` or `ExtensionSettings` identity found |
| Candidate identity material | Source/candidate manifest version `0.1.3`; no manifest `key`; no `update_url`; candidate ID cannot be derived or matched |
| Candidate integrity | Chrome SHA-256 `4d89a2545d813499dc4fec37b9023dd80abf3d847746a7ff25e646d637aed7dc`; Edge SHA-256 `fa50ef4ab231ff590d1f2473a3fbb861719d636b193a134917ece7841b5c3a59` |

### Scenario results

`PASS` is reserved for an observed run against the dedicated staging database and actual test devices. Mocked or in-process automated coverage is listed as supporting evidence only.

| # | Acceptance scenario | Result | Logs and evidence |
|---:|---|---|---|
| 1 | Generate enrollment token A | **NOT TESTED** | No isolated staging database or approved staging administrator account was available. The focused backend suite did verify token generation in-process, but no staging token ID was created or recorded. |
| 2 | Enroll Chrome extension A | **NOT TESTED** | No enrolled DigitalPulse Chrome profile was found and no staging token/backend was available. No device ID or credential was created, replaced or read. |
| 3 | Generate enrollment token B | **NOT TESTED** | Same staging database/account blocker as scenario 1; no token B was created. |
| 4 | Confirm token A is invalid for a new enrollment | **NOT TESTED** | The in-process suite verifies one-time token consumption and replay rejection, but no real token A was consumed or replayed against PostgreSQL. |
| 5 | Confirm existing Chrome device A remains connected and its credential works | **NOT TESTED** | Profile scan found no installed DigitalPulse Chrome extension. There was no before/after heartbeat or credential-authentication log. Automated coverage verifies that an enrolled browser does not resubmit a consumed token or replace credentials. |
| 6 | Enroll a second device using token B | **NOT TESTED** | No second physical/browser test device and no staging token B were available. |
| 7 | Revoke token B and confirm enrolled devices remain unaffected | **NOT TESTED** | No staging token/device existed. Current contract makes tokens one-time; revocation applies to pending unconsumed tokens, while a consumed token is already inactive and returns conflict if revoked. Focused tests verify pending-token revocation blocks enrollment and does not revoke devices. |
| 8 | Revoke device A; reject heartbeat, activity and screenshot upload | **NOT TESTED** | No live device A existed. Supporting tests verify heartbeat rejection, screenshot-upload rejection and collector stop/queue preservation; activity ingestion authenticates through the same lifecycle gate, but no three-request staging log was produced. |
| 9 | Archive another device; stop operation and retain history | **NOT TESTED** | No staging device or persistent historical rows were available. Supporting tests verify `DEVICE_ARCHIVED`, exclusion from normal lists, inclusion with `includeArchived=true`, and row retention. |
| 10 | Restore archived device and verify credential behavior | **NOT TESTED** | No archived staging device existed. The documented contract is credential preservation: restore clears archive state without rotating the secret, and operation resumes only after a healthy authenticated heartbeat. In-process tests verify the original secret remains valid after restore. |
| 11 | Block cross-organization administrator access/modification | **NOT TESTED** | No two-tenant staging accounts/database were available. The focused backend suite verifies tenant-scoped lifecycle HTTP rejection in-process; no live HTTP request/response evidence was produced. |
| 12 | Chrome and Edge identity continuity and local-storage preservation | **NOT TESTED** | Chrome/Edge were installed, but 0 installed DigitalPulse extensions and 0 enterprise identity policies were found. The manifest has no fixed key, so candidate IDs cannot be proven from repository bytes. No same-path reload or before/after storage comparison was performed. |
| 13 | Execute all four PostgreSQL integration tests | **NOT TESTED** | Tests were explicitly invoked with `RUN_INTEGRATION_TESTS=true` and `TEST_DATABASE_URL` absent: **4 total, 0 passed, 0 failed, 4 skipped**. Each skip reported that a separate `TEST_DATABASE_URL` was not configured. `DATABASE_URL` was not used as fallback. |
| 14 | Real screenshot permission, consent, visible tab, upload, persistence and gallery display | **NOT TESTED** | No employee-operated Chrome/Edge permission approval, staging capture ID, upload response, PostgreSQL row, private object, administrator gallery open or unauthorized-access rejection was observed. The 67-test extension suite and focused backend tests are green but simulated. |

### Audit command evidence

The isolated PostgreSQL command produced:

```text
tests 4
pass 0
fail 0
skipped 4
reason: TEST_DATABASE_URL not set (configure an isolated PostgreSQL test database)
```

Additional non-E2E regression evidence collected during this audit:

```text
Focused backend lifecycle/screenshot: 20 passed, 0 failed, 0 skipped
Browser extension:                 67 passed, 0 failed, 0 skipped
DigitalPulse browser profiles:      0 installed extensions found
Enterprise extension policies:      0 configured identities found
```

No actual defect was discovered by these checks, so no application code was modified. This is an incomplete acceptance run, not a failed implementation claim.

## Deployment and rollback

1. Rehearse the additive migration on a staging clone and compare device counts, IDs, assignments, secret hashes and historical foreign keys before/after.
2. Deploy backend before dashboard/collectors. Preserve sessions, storage/encryption/signing keys and all device credentials.
3. Promote only the exact browser candidates that pass identity and real-browser acceptance. Keep same extension IDs and profiles.
4. Roll back application binaries to the previous compatible build while leaving additive columns/indexes in place. Do not drop columns, delete devices/tokens/audits or reset the database.
5. Restore prior extension bytes through the same path/enterprise identity and retain extension storage, Credential Manager entries and local queues.

## Remaining blockers

Status remains **NOT READY** because:

- four mandatory PostgreSQL integration tests have not run against an isolated database;
- Chrome and Edge candidate identity continuity is unverified;
- real employee-operated Chrome and Edge permission/capture/upload/persistence/gallery acceptance is unverified;
- live unauthorized image access, revoke/archive and rollback acceptance is unverified.

Exact next action: provision an isolated staging PostgreSQL database, set only `TEST_DATABASE_URL`, run the four skipped tests, then record installed Chrome/Edge IDs before and after same-path candidate reload.
