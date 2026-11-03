# DigitalPulse simplify implementation status

Updated: 2026-11-03

## Delivery status

**Invitation onboarding passes the PostgreSQL and separate-browser end-to-end flow; broader product journeys remain partially verified.** This continuation repairs the employee onboarding and directory paths, adds employee schedule editing, narrows the primary navigation to five sections, and adds scoped activity reports and CSV export. Real SMTP delivery and the Windows agent/extension monitoring journey still require deployment verification.

## Final integrated update (2026-11-03)

- Employee invitation acceptance now sends the employee directly to the device setup guide. The employee self-service enrollment endpoint remains, but its setup-page token controls are temporarily hidden; the organization and employee IDs still come from the signed-in session. Token creation fails closed if PostgreSQL persistence is unavailable. See [DIGITALPULSE_ENROLLMENT_DEFERRED.md](DIGITALPULSE_ENROLLMENT_DEFERRED.md).
- The Windows agent now reads the backend's `deviceSecret` enrollment response, authenticates its heartbeat, checks the HTTP result, and sends heartbeats during monitoring. The backend records a device as online only after a valid heartbeat; enrollment alone leaves it offline. Production heartbeat updates fail instead of returning a false healthy response when they cannot be persisted.
- The extension popup shows device enrollment, heartbeat, last successful sync, pending event count, and backend status separately. The future enrollment exchange remains in the background worker and returns only the device ID/status, never the long-lived secret. The popup token field and worker entry point are temporarily disabled by a feature flag. The worker is the sole source of the browser device ID, shared by enrollment, heartbeat, and queued events. Queue batches are removed only after the backend acknowledges every submitted event, and queue mutation is rechecked to protect concurrent syncs.
- The extension queue regression test starts with 159 events: a 50-event acknowledged batch leaves 109; partial acknowledgement and missing credentials leave all 159 queued.
- Employee profiles now show the requested no-device message, statuses, em dash for the missing heartbeat, install guide action, and setup invitation with a copyable fallback link. Activity and app/site totals come from persisted sessions; missing data is shown as “No data available”. Device authentication hashes are stripped from employee API responses.
- The employee setup guide discloses the collected data, provides Windows, Chrome, and Edge installation instructions, and distinguishes installation, enrollment, offline, and heartbeat-confirmed connection status. Installer downloads stay disabled until actual packages are published.

The configured Neon PostgreSQL database initially lacked four application migrations. After approval, the pending notification, usage category, device-token-hash, and invitation migrations were applied. The invitation lifecycle and browser acceptance tests then passed against that database, and both tests removed their isolated test organizations. The Windows release package build remains unavailable because `link.exe` is missing and the Rust GNU target download could not resolve `static.rust-lang.org`.

## What changed

- `Invite Employee` opens an independent modal and submits employee name, email, department, role, workdays, shift hours, and time zone. Invitations are stored in PostgreSQL, expire after seven days, and persist a SHA-256 token hash instead of the bearer token. The backend returns the generated link to the authorized creator whether email succeeds or fails. The modal switches to a success state with copy confirmation; email failure leaves the invitation active and offers a resend that rotates the token. Invitation links put the token in the URL fragment, and the dashboard posts it to backend validation so it does not appear in backend request logs. The directory shows pending, accepted, expired, and revoked status, expiry, resend, copy, and revoke actions.
- `Add New Employee` starts the same authenticated onboarding lifecycle. It does not create a passwordless account; the account and organization membership are created only when the employee accepts and sets a password.
- The directory no longer falls back to seeded employee records when its database query fails. The profile cards no longer show fixed sample activity values. Profile totals are calculated from database activity intervals; active and idle intervals are unioned and clipped to the day. Devices with revoked credentials are excluded.
- Deactivation is an authorized, confirmed soft status change that disables monitoring. Device assignment now checks organization ownership and will not silently take a device from another employee.
- Employee schedules can be edited by day, start/end time, and IANA time zone. Schedule inputs are validated and saved through the employee update endpoint. The report view shows scheduled duration separately from active, idle, and monitored duration.
- Manager navigation now contains Overview, Employees, Activity, Schedule, and Reports. Reports support employee and date-range filters, application and website summaries, daily active-time trends, and CSV export. Employee report filters are checked against organization and manager scope.
- Development/unit fixtures that created fake employees through the old family-member API have been removed from that path; unavailable storage now returns an error instead of pretending a record was saved.

## Root causes fixed

- The invitation dialog was rendered inside the selected employee profile dialog. Clicking Invite with no profile selected therefore rendered no form.
- Employee creation wrote directly to the users table without a password or acceptance flow; on storage errors it could fall back to in-memory records that were not durable.
- Profile KPI values were literal sample strings and policy compliance was hard-coded to zero violations / 100 percent.
- Invitation creation swallowed database errors, stored the raw token, did not preserve the employee schedule, returned a development-only token field, and had no durable revoke/resend/status lifecycle.
- The sidebar exposed many overlapping legacy routes instead of the five primary product areas.

## Changed files in this continuation

- Backend: `backend/prisma/schema.prisma`, `backend/prisma/migrations/20261103120000_invitation_onboarding/migration.sql`, `backend/src/modules/auth/auth.routes.js`, `backend/src/modules/auth/auth.service.js`, `backend/src/modules/employees/employees.routes.js`, `backend/src/modules/devices/devices.service.js`, `backend/src/modules/analytics/analytics.routes.js`, and `backend/src/modules/analytics/analytics.service.js`.
- Dashboard: `apps/dashboard/src/App.jsx`, `apps/dashboard/src/components/layout/Layout.jsx`, `apps/dashboard/src/lib/api.js`, `apps/dashboard/src/pages/EmployeesPage.jsx`, `apps/dashboard/src/pages/LiveMonitoringPage.jsx`, new `apps/dashboard/src/pages/SchedulePage.jsx`, new `apps/dashboard/src/pages/ReportsPage.jsx`, and `apps/dashboard/src/test/app.test.jsx`.
- Tests: `backend/tests/auth-registration-security.test.js` and `backend/tests/family-policies.test.js`.

The final integrated update also changed `backend/src/modules/devices/devices.routes.js`, `backend/src/modules/devices/devices.service.js`, `backend/src/modules/auth/email.service.js`, `backend/src/modules/employees/employees.routes.js`, `backend/src/modules/activity/activity.routes.js`, `desktop-agent/crates/dp-user-agent/src/main.rs`, `desktop-agent/crates/dp-user-agent/src/sync.rs`, `apps/browser-extension/background/service-worker.js`, new `apps/browser-extension/background/sync-client.js`, `apps/browser-extension/popup/popup.html`, `apps/browser-extension/popup/popup.js`, new `apps/dashboard/src/pages/EmployeeSetupPage.jsx`, `apps/dashboard/src/pages/EmployeePortalPage.jsx`, `apps/dashboard/src/pages/AcceptInvitationPage.jsx`, `backend/tests/device-enrollment.test.js`, new `backend/tests/employee-setup.test.js`, new `backend/tests/invitation-postgres.integration.test.js`, new `apps/browser-extension/tests/sync-client.test.js`, new `scripts/test-invitation-browser-e2e.mjs`, and `scripts/package-windows-agent-download.ps1`.

Other files in this workspace were already modified before this continuation; they were preserved.

## Verification evidence

- `npm.cmd run db:generate` completed successfully.
- `npx.cmd prisma validate --schema backend/prisma/schema.prisma` passed.
- `npm.cmd run test:backend`: 78 passed, 0 failed, 3 PostgreSQL integration tests skipped.
- `npm.cmd run test:dashboard`: 25 passed, 0 failed.
- `npm.cmd run test:extension`: 12 passed, including background-only secret handling, 159-event queue acknowledgement, and authenticated heartbeat handling.
- `cargo test --workspace`: 31 passed, including the Windows agent enrollment response contract.
- `npm.cmd run build:dashboard` passed after the final dashboard changes.
- Invitation flow coverage includes authenticated HTTP creation, PostgreSQL hash-only persistence, email failure while leaving the invite active, validation, acceptance, account activation/login, directory status change, replay rejection, expiry, revocation, resend rotation, and safe cleanup. `RUN_INTEGRATION_TESTS=true node --test tests/invitation-postgres.integration.test.js` passed against Neon. `RUN_INVITATION_BROWSER_E2E=true node ../scripts/test-invitation-browser-e2e.mjs` passed in Chrome: the admin copied the actual link and a separate browser context accepted it, reached employee setup, and updated the directory. The browser test confirmed clipboard contents matched the backend link. Real SMTP delivery was simulated as unavailable.
- Backend unit tests cover invitation acceptance/replay protection, device enrollment and heartbeat/revocation, duplicate event ingestion, analytics interval unioning, and tenant/manager authorization. These use test fixtures; they do not prove a live PostgreSQL, Windows collector, or browser-extension workflow.

## Remaining work before claiming completion

- Run the broader employee invite → accept → device enroll → heartbeat → event ingestion → reports journey against a disposable deployment database; the invitation-only PostgreSQL and browser flow is verified.
- Test invitation delivery and resend with a real configured SMTP service.
- Verify device enrollment and current-status transitions with the Windows agent and loaded Chrome/Edge extension, including an offline queue replay against PostgreSQL.
- Tracking schedule configuration is persisted and reported, but collector event capture is not yet gated by those schedules. Do not claim that tracking stops outside scheduled hours.
- Live-day boundaries and schedule accounting need deployment-time verification across employee time zones and daylight-saving transitions. Historical report date bucketing currently follows the analytics API's UTC calendar-day behavior.
- Verify the extension's website policy enforcement and expiration behavior in actual Chrome and Edge sessions.
