# DigitalPulse device lifecycle architecture audit

Date: 2026-11-08 (Asia/Calcutta)

This audit was completed before device-lifecycle implementation. It describes the existing tree at HEAD `483e6edefb06a375757eb7bf363c45381d254458` and does not authorize a production migration or data mutation.

## Existing model and contracts

- `DeviceEnrollmentToken` already stores a SHA-256 token hash, expiry, one-time `usedAt`, revocation time, organization, employee and collector kind. Raw tokens are returned once and the legacy nullable raw-token column is not populated by current code.
- `Device` uses the collector-generated UUID as its primary key. It already stores organization and employee ownership, collector kind, browser/platform metadata, scrypt-derived secret hash and salt, revocation state, heartbeat/sync timestamps and screenshot-selection/diagnostic fields.
- Connection state is derived from authenticated `lastSeenAt`, not persisted as lifecycle state. Screenshot authorization is independently evaluated from enrollment, revocation, ownership, consent, administrator authorization, acknowledgement, device selection and schedules.
- User authentication is the existing HttpOnly cookie/session implementation with canonical `SUPER_ADMIN`, `ADMIN` and `EMPLOYEE` RBAC. The master prompt's JWT description is not the current implementation and will not be substituted for the working session design.
- `AuditLog` is append-only through application APIs and already records organization, action, actor, JSON details and timestamp. There is no ordinary update/delete endpoint for audit rows.

## Existing flow and dependency map

| Source | Device dependency |
|---|---|
| `devices.routes.js` / `devices.service.js` | Token creation, one-time enrollment, secret verification, heartbeat, listing, revocation and secret rotation |
| auth middleware and `app.js` | Resolves the authenticated device before heartbeat, activity ingestion, browser policy sync and screenshot device routes |
| activity routes | Require the authenticated device ID, organization and assigned employee; update `lastSyncAt`; preserve per-device idempotency |
| screen routes | Reject revoked devices, evaluate screenshot policy independently, enforce device/tenant scope, and associate capture metadata with the retained device row |
| employee routes | Assign devices only inside the administrator's organization and expose employee setup/device state |
| dashboard `DevicesPage` | Shows personal and organization device records but has no archival, lifecycle filters, details or audit-history actions |
| dashboard `ScreenMonitoringPage` | Uses device selection and screenshot policy; lifecycle work must not weaken these gates |
| browser extension sync client | Persists a stable UUID and secret, heartbeats before monitoring, preserves queued events offline, and clears rejected credentials on 401/403 |
| Windows agent | Persists a stable UUID and secret in Windows Credential Manager, heartbeats before collection/sync, and retains its SQLite queue when authorization is unavailable |
| activity/screenshot/audit history | References the device row, so lifecycle operations must retain rather than delete device records |

## Confirmed gaps

1. Archival, archive filtering, restoration and archival enforcement do not exist.
2. Revocation does not clear the stored secret hash/salt, capture-selection flag, or record a reason/administrator ID.
3. Enrollment-token records do not identify the creating administrator or consuming device, and token create/consume/expiry audit coverage is incomplete.
4. Enrollment always creates a row; an existing stable device ID produces a duplicate-key failure instead of an explicit reconnect/re-enrollment decision. Revoked identities must remain rejected.
5. Device list responses overload `status` with connectivity/revocation and do not separately expose lifecycle, connection and screenshot authorization status.
6. There is no safe legacy-duplicate review endpoint. Automatic merging by display name, browser or email would be unsafe and will not be implemented.
7. Enrollment relies on the global IP rate limiter; sensitive token endpoints need a tighter bounded limiter.
8. The dashboard lacks lifecycle filters, revoke/archive confirmations, details, audit history and recoverable bulk action results.
9. The browser extension treats all credential rejection as generic re-enrollment. It needs an explicit revoked/archived status while preserving queued events.
10. The Windows agent fails closed on non-success responses but does not expose a structured revoked/archived status.

## Compatibility design

- Preserve `isRevoked`, existing endpoint paths, response fields and device UUID identity.
- Add archival and actor/reason metadata. Derive lifecycle as `ARCHIVED`, `REVOKED`, or `ACTIVE`; pending enrollment remains a token state because no device row exists before token consumption.
- Keep connection (`ONLINE`, `OFFLINE`, `UNKNOWN`) and screenshot authorization (`AUTHORIZED`, `UNAUTHORIZED`, `EXPIRED`) separate from lifecycle.
- Default device lists will exclude archived rows but continue returning active and revoked rows. An additive query flag will expose archived rows.
- Re-enrolling an existing active stable ID may update that exact row only when organization, employee and collector kind match. Revoked or archived IDs will never be reactivated by token consumption.
- Revocation will atomically disable capture, clear the credential hash/salt, preserve the device/history rows and append an audit event.
- Archive will disable operations while retaining credentials for an explicit administrator-controlled restore. A revoked device cannot be restored.
- Bulk actions will execute explicit per-device lifecycle operations and return per-device results; no token generation will trigger lifecycle changes.

## Baseline evidence

- Backend lifecycle-focused suites: 16 passed, 0 failed, 0 skipped.
- Browser extension suite: 65 passed, 0 failed, 0 skipped.
- Dashboard device/screen suites: 8 passed, 0 failed, 0 skipped.
- Desktop-agent workspace: 39 passed, 0 failed, 0 ignored.

No database reset, migration execution, production data change, credential rotation, device revocation, archive action or deployment was performed during this audit.
