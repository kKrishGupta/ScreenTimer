# Device monitoring implementation and rollout status

Updated: 2026-11-03

## Current state

Self-service device enrollment is available to an employee or organization administrator for a device assigned to their own account. The broad admin-issued token API and the device enrollment service remain available for later administrative workflows. Enrollment creates an offline device; it does not authorize monitoring by itself.

The backend accepts activity only when all of these are true:

1. The device credential is valid, the device is not revoked, and it is assigned to a user in the same organization.
2. The user account is active and an organization administrator has explicitly authorized monitoring.
3. The user has explicitly granted current monitoring consent.
4. The organization has a valid IANA time zone and the employee schedule is valid.
5. The current time is inside that schedule, and each submitted event falls entirely inside an authorized schedule window after consent was granted.

Missing or invalid authorization data fails closed. The server heartbeat can still confirm that a device is connected while reporting monitoring as paused. No application or website events are accepted until the gate opens.

The additive migration `20261103150000_monitoring_consent_schedule` adds organization time zone and consent fields. It also changes `monitoring_authorized` to default false and clears old true values because those values did not prove an explicit administrator decision. The migration has not been applied to the configured application database. Apply it through the reviewed deployment migration process before enabling production monitoring.

## Dashboard and API contracts

All API paths below are mounted under `/api/v1`.

| Purpose | Route | Authorization and behavior |
| --- | --- | --- |
| View own monitoring gate | `GET /devices/my-monitoring-status` | Signed-in account only; reports consent, admin authorization, schedule, organization time zone, and current gate reason. |
| Give or revoke own consent | `POST /devices/my-monitoring-consent` with `{ consent: boolean }` | Signed-in account only. The server derives user and organization IDs from the session and records an audit event. Revocation pauses future monitoring immediately. |
| Organization administrator authorizes their own account | `PATCH /devices/my-monitoring-authorization` with `{ authorized: boolean }` | Organization administrator only; only the caller's own account can be changed. |
| Administrator authorizes an employee | `PATCH /employees/:id/monitoring-authorization` with `{ authorized: boolean }` | Organization administrator only; employee is looked up inside the caller's organization. Changes are audited transactionally. Manager and cross-organization attempts are rejected. |
| Set personal working schedule | `PATCH /devices/my-monitoring-schedule` with `{ shiftStart, shiftEnd, workingDays }` | Signed-in account only. Overnight shifts are supported. Schedule times use the organization's configured time zone. |
| Set organization time zone | `PATCH /devices/organization-timezone` with `{ timezone }` | Organization administrator only; validates an IANA time zone and scopes the update to the caller's organization. |
| Create a one-use token for own device | `POST /devices/my-enrollment-token` with `{ deviceKind }` | Employee or organization administrator only; identity and organization come from the session; token expires after four hours. The raw token is returned only to the requester. |
| Consume enrollment token | `POST /devices/enroll` with `{ token, deviceId, name, platform, browser?, agentVersion? }` | Token is single-use and stored as a hash. The response returns the device secret once. |
| Verify device connection and gate | `POST /devices/:id/heartbeat` with `X-Device-Secret` | Returns a healthy heartbeat and the current server monitoring gate. A heartbeat alone does not start monitoring. |
| Submit activity | `POST /activity/events/batch` with `X-Device-Secret` | Requires an assigned, authorized device and active monitoring gate. Response includes accepted, deduplicated, and rejected event IDs. |

The Devices page lets a signed-in employee or organization administrator set their own schedule and consent, and create a token for their own device. Organization administrators also set the organization time zone and authorize their own account. The employee profile exposes the separate administrator authorization control. The existing directory and employee setup status still rely on actual device enrollment and authenticated heartbeat data.

## Collector behavior and stored queues

### Browser extension

- The service worker owns device identity, credentials, event buffering, heartbeats, and sync. The popup receives the one-time enrollment token but never receives the long-lived device secret.
- Website domain sessions start only after an authenticated heartbeat reports an active server authorization window. Tab URL queries and local domain display are suppressed while monitoring is paused. The worker rechecks the current active tab after authorization resumes.
- Existing pending rows are retained unless the backend acknowledges their event IDs. Accepted and deduplicated IDs are removed individually; rejected, malformed, wrong-device, duplicate-conflicting, and unacknowledged rows remain available for review. Rejected events are excluded from automatic retries until explicitly rechecked.
- The extension displays queue audit counts, last sync, backend/device status, and the monitoring pause reason. It does not transmit queued rows when enrollment or monitoring authorization is missing.

### Windows agent

- The long-lived device secret is stored in Windows Credential Manager, not in the SQLite settings table. The agent migrates a legacy plaintext secret to Credential Manager and removes the SQLite value before continuing.
- Remote device requests use WinHTTP with HTTPS, normal Windows certificate validation, bounded responses, and redirects disabled. Non-loopback remote use requires `DP_ALLOW_REMOTE_BACKEND=true`; local development may use loopback HTTP.
- Offline sessions and the outbound queue are stored transactionally in SQLite WAL. Per-event backend acknowledgements determine which rows are marked synced. Invalid payloads and server-rejected schedule intervals are quarantined with a reason while the original payload remains stored.
- Monitoring is gated by the heartbeat response. The agent closes sessions at the allowed schedule end, pauses while the workstation is locked or the gate is unavailable, and closes intervals before detected system-sleep gaps. Manual live-app queries also require current server authorization.

## PostgreSQL persistence and queue audit limits

PostgreSQL remains the system of record for users, consent, administrator authorization, organization time zone, schedules, devices, events, and normalized activity sessions. No in-memory database or production database reset was introduced.

The reported 316-event browser queue was not readable through this checkout: browser extension local storage is held in the user's installed Chrome/Edge profile and is not exposed to the repository test harness. The extension now provides an in-browser queue audit and preserves each row, but this work did not inspect or classify those 316 live records. Do not infer counts or contents from unit-test fixtures.

## Verification performed

- Backend focused route and schedule tests cover fail-closed missing settings, overnight schedules, repeated/skipped daylight-saving times, explicit self-consent and authorization, administrator-only employee authorization, organization scoping, and authorization audit events.
- Browser extension tests cover authorization-gated collection, enrollment, authenticated heartbeat, a pending queue, per-event acknowledgement, malformed/conflicting rows, and schedule rejection.
- Rust workspace tests cover the SQLite queue, quarantining without deleting payloads, device enrollment response parsing, per-event acknowledgement, and Windows crate compilation on this development machine.
- Dashboard component tests and the production Vite build cover the dashboard's current local UI and route rendering. These do not test a live extension or agent installation.
- A real isolated PostgreSQL integration database is not configured. `TEST_DATABASE_URL` is unset, no PostgreSQL listener is available at `127.0.0.1:5432`, and the configured application database was not reset or used for fixtures. The PostgreSQL lifecycle checks remain skipped.
- No browser profile or Windows Credential Manager live enrollment was available for an end-to-end test. The reported pending queue was not inspected; Chrome/Edge packaging and live device heartbeats remain unverified.

## Rollout gates still required

1. Configure an isolated, migrated PostgreSQL test database in `TEST_DATABASE_URL`, keep it distinct from `DATABASE_URL`, and run the database-backed enrollment/consent/schedule/event lifecycle tests.
2. Apply the reviewed additive migration to the intended deployment database. Verify organization time zones and employee schedules are configured; administrator authorization defaults to false and requires an explicit decision.
3. Inspect the actual browser queue from the user's own extension context using its audit view. Record totals and classifications without copying event domains or payloads into logs. Confirm all 316 rows remain present before and after retry/restart.
4. On a test Windows account, verify Credential Manager write/read/delete, startup authorization, workstation lock/unlock, system-sleep handling, and HTTPS certificate behavior against an isolated backend.
5. Load the extension in separate Chrome and Edge profiles; exercise self-enrollment, denied monitoring, active schedule, overnight/DST boundaries, service-worker restart, partial acknowledgement, and revoked-device behavior.
6. Complete a live test of dashboard authorization and consent revocation. Confirm activity ingestion and downstream analytics stay empty while any gate is closed.

Until those checks pass, keep production collection paused. Device enrollment and monitoring were not live-verified against PostgreSQL or a real collector in this session.
