# DigitalPulse device enrollment deferral (historical)

Updated: 2026-11-03

> **Superseded:** Self-service enrollment for an employee's or organization administrator's own device is now implemented. This file records the earlier deferred phase. See [DEVICE_MONITORING_IMPLEMENTATION.md](./DEVICE_MONITORING_IMPLEMENTATION.md) for current APIs, authorization gates, verification results, and remaining rollout checks. Monitoring remains paused until explicit administrator authorization, employee consent, organization time zone, and an active schedule are all verified.

The notes below describe the temporary state before the self-enrollment flow was enabled. They are retained as implementation history and should not be used as the current setup instructions.

## Current development behavior

Employee invitations, acceptance, account activation, and the employee directory remain the onboarding path. After acceptance, employees land on `/employee-setup`, where they can read the Windows, Chrome, and Edge installation instructions and check the backend device records for their account.

Enrollment-token entry and token creation are temporarily hidden from the employee setup page and extension popup. The popup background listener also rejects `enroll_browser` messages while `CONFIG.ENROLLMENT_UI_ENABLED` is `false`. This is a temporary UI and worker gate; the server APIs, token hashing and consumption service, Windows agent contract, and extension enrollment client remain in the repository.

The extension continues local domain tracking and queue persistence. It does not send heartbeat, event, or policy requests without a device credential. The popup keeps showing backend reachability, current domain, pending queue count, and last successful sync/heartbeat. Without enrollment it shows:

> Device enrollment is not configured yet. Please contact your administrator.

The local extension ID used to tag queued events is not a backend device record and is not shown as an assigned device. Queue entries are retained until the backend acknowledges them after a future authenticated enrollment.

The setup page status is derived from the authenticated `/devices` response: no registered device is `Not Installed` unless the employee locally marked installation as started; a device with no heartbeat is `Enrollment Pending`; a fresh authenticated heartbeat is `Connected`; a previously seen but stale device is `Offline`; and revoked devices remain `Revoked`. A locally marked `Installation Pending` value is only a user report in that browser, not proof of an installed or assigned device. This page cannot detect an un-enrolled installation.

## Existing enrollment implementation

- Enrollment tokens are random, short-lived, single-use credentials. New token records persist the token hash; a successful claim and device creation happen transactionally. Token bytes are returned by the token-creation endpoint and must only be shown to the authorized requester.
- Device enrollment consumes a token and returns a device ID and long-lived device secret. The extension keeps that secret in extension local storage and does not return it through the popup message channel. The Windows agent stores its secret locally.
- A device is not connected at enrollment time. The backend marks it online after a credential-authenticated heartbeat and uses the last heartbeat time to compute online status.
- The extension's `background/sync-client.js` still implements token exchange, authenticated heartbeat, and acknowledged queue synchronization. The worker still owns the shared device ID and queue.
- `/devices` scopes employee sessions to their own device records and organization. Invitation acceptance does not create a device record or grant organization-admin permissions.

## API contracts retained for the future rollout

All paths below are mounted under `/api/v1`.

| Purpose | Contract |
| --- | --- |
| Admin token generation | `POST /devices/enrollment-tokens` with an authenticated authorized admin/manager session. Body: `{ userId, deviceKind, expiresInHours, organizationId? }`. The organization is taken from the session except for an authorized super-admin scope. Response: `201 { success, token, expiresAt, ... }`. The raw token must only be displayed to that authorized creator and must never be logged. |
| Employee self-service token generation | `POST /devices/my-enrollment-token` with an authenticated `EMPLOYEE` session. Body: `{ deviceKind: "DESKTOP_AGENT" | "BROWSER_EXTENSION" }`. User and organization IDs are taken from the session; token lifetime is four hours. This endpoint remains available but is not called by the current setup UI. |
| Device token exchange | `POST /devices/enroll` with `{ token, deviceId, name, platform, browser?, agentVersion? }`. Success returns the backend device ID and a device secret once. Invalid, expired, revoked, or consumed tokens are rejected. |
| Heartbeat | `POST /devices/:id/heartbeat` with `X-Device-Secret` and `{ agentVersion?, metrics? }`. A successful authenticated heartbeat establishes or refreshes connected status. |
| Employee device status | Authenticated `GET /devices`; employee sessions receive only their own organization's and account's device records, including kind, browser, status, `lastSeenAt`, and `lastSyncAt`. |
| Activity batch | `POST /activity/events/batch` with `X-Device-Secret`. The extension removes queue entries only after all submitted events are acknowledged. |

## Missing dependencies before re-enabling enrollment

- There is no admin dashboard flow yet that selects an employee/device kind, requests an admin-scoped token, and gives the authorized admin a safe copy/retry experience. The backend admin API contract is present.
- The employee setup UI does not currently expose token generation, and the extension popup token field is hidden and disabled. Re-enable both only as one coordinated rollout after the admin flow and employee install instructions are ready.
- The Windows agent release archive and browser extension archive are not published under the dashboard download paths. The current dashboard checks for a real archive before enabling a download action; it does not fabricate a URL or token.
- The backend/browser behavior has unit coverage, but this deferral change has not been validated with a newly loaded Chrome and Edge extension, a Windows installer, or a live heartbeat.

## Remaining integration tests

Before re-enabling the feature, test the complete lifecycle against PostgreSQL and real clients:

1. Admin issues a token for an employee and the correct device kind; verify only a hash persists and the token is not logged.
2. Install the published Windows package and Chrome/Edge extension; exchange each token exactly once and confirm correct organization, employee, kind, and browser association.
3. Verify invalid, expired, revoked, wrong-kind, and already-consumed tokens fail without creating or reassigning devices.
4. Verify enrollment alone stays offline; a valid heartbeat connects the device, and missing/invalid credentials never do.
5. Verify queue batches persist across worker restart and are removed only after complete backend acknowledgement.
6. Verify device revocation stops heartbeat, event ingestion, and policy sync; confirm directory and employee setup status refresh accurately.
7. Confirm the extension popup never displays the long-lived device secret and that both Chrome and Edge remain usable after service-worker restart.

To re-enable the popup entry point later, coordinate the dashboard and popup UI changes, then set `CONFIG.ENROLLMENT_UI_ENABLED` to `true`. Do not enable that flag before the admin token workflow, published packages, and integration tests are ready.
