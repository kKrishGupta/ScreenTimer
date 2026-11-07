# DigitalPulse screenshot monitoring repair report

Date: 2026-11-07 (Asia/Calcutta)

Deployment decision: **NOT READY**

This report records the audit and verification performed against the existing DigitalPulse tree. The repository already contained a broad uncommitted screenshot repair effort before this pass; those changes were preserved and not reset.

## Baseline and scope

- HEAD: `bdfbfb1ae32f2bbd1f7b7d68f8527deed4988064`
- Working tree: already modified across browser extension, backend, dashboard, desktop agent, packaging, migrations, tests, and documentation.
- No database reset, destructive migration, credential replacement, enrollment replacement, or production-data mutation was performed.
- The browser flow audited was: optional host permission -> policy -> device/employee authorization -> visible badge -> active tab eligibility -> capture validation -> policy recheck -> bounded upload -> private storage -> metadata -> organization gallery.

## Bugs and repairs verified

The existing repair work addressed these classes of defects:

1. Unattended browser capture was gated by explicit optional `<all_urls>` permission requested from the popup click handler. Permission grant is not treated as consent or server authorization.
2. Screenshot authorization is fail-closed and checks enrollment, revocation, device ownership and tenant, device selection, organization setting, acknowledgement, employee consent, administrator authorization, active account, employee schedule, organization schedule, and the earliest authorization deadline.
3. Capture attempts use a generation and attempt identifier. Target tab changes, navigation, focus loss, idle state, permission removal, expiry, worker restart, and policy denial invalidate pending captures. Same-target activation and normal heartbeat do not invalidate them.
4. The service worker clears stale authorization and the visible badge on startup, serializes sync work, and does not use heartbeat authorization as screenshot authorization.
5. Capture bytes, MIME type, dimensions, size, active HTTP(S) tab, focused normal window, and upload lease are validated before upload. Uploads use a timeout, device-secret authentication, capture keys, and duplicate handling.
6. Backend storage is private and tenant-scoped. Cloudinary uses authenticated assets and signed downloads; local storage is encrypted. Gallery image access is administrator-only, organization-scoped, user-bound, expiring, and audited.
7. This pass fixed an additional expiry gap in `backend/src/modules/screen/screen.routes.js`: gallery, metadata, employee-capture, and image queries now require `expiresAt > now`, so an expired image cannot be served while hourly retention cleanup is pending.

## Files changed in this pass

- `backend/src/modules/screen/screen.routes.js` — enforce expiry at read and image-delivery time.
- `backend/src/modules/devices/devices.routes.js` — restore the standard nested error envelope for unauthorized enrollment-token requests.
- `backend/src/modules/planner/planner.routes.js` — include `deletedId` in successful task deletion responses.
- `backend/tests/analytics-accounting.test.js`, `backend/tests/auth-registration-security.test.js`, `backend/tests/employee-setup-reminder.test.js`, `backend/tests/p0-security-audit.test.js`, `backend/tests/role-scope-regression.test.js` — update obsolete role/query fixtures to the canonical RBAC and expiry contracts.
- `apps/dashboard/src/components/BlockedAttemptNotice.jsx`, `apps/dashboard/src/pages/AcceptInvitationPage.jsx`, `apps/dashboard/src/pages/DeclarativeRulesPage.jsx`, `apps/dashboard/src/pages/DigitalWellbeingPage.jsx`, `apps/dashboard/src/pages/EmployeeSetupPage.jsx`, `apps/dashboard/src/pages/EmployeesPage.jsx`, `apps/dashboard/src/pages/FamilyPoliciesPage.jsx`, `apps/dashboard/src/pages/TimePlannerPage.jsx` — resolve dashboard lint errors without changing screenshot authorization behavior.
- `docs/screenshot-complete-repair-report.md` — this evidence report.

The other modified files listed by `git status` predated this pass and were preserved as user work; they include the extension capture implementation/tests, backend screen implementation/tests, dashboard work, packaging artifacts, and unrelated application changes.

## Permission and security review

The manifest declares `tabs`, `idle`, `storage`, and `alarms`, with local backend host access and optional `<all_urls>` access. The popup explains the scope and calls `permissions.request` only from the grant button. Decline, removal, unavailable permission, and enterprise restriction fail closed. The extension does not capture incognito, hidden, discarded, inactive, unsupported, minimized, or unfocused targets.

Backend upload authorization is evaluated both for the current request and for the capture timestamp. Device identity, secret, ownership, tenant, revocation, consent, schedules, selection, and retention are checked. Cross-tenant gallery and image access is rejected. Secrets, authorization headers, access tokens, image bytes, and signed URLs are excluded from diagnostics.

## Automated verification

| Check | Result |
|---|---|
| Browser extension suite | PASS — 64 tests, 64 passed, 0 failed, 0 skipped |
| Focused screen/backend suites after expiry fix | PASS — 17 tests, 17 passed |
| Dashboard screen test | PASS — 1 file, 4 tests passed |
| Full dashboard suite (single-threaded rerun) | NOT GREEN — 59 total, 31 passed, 28 failed; failures are in existing shell/auth/password-reset/device-schedule expectations outside screenshot monitoring |
| Full backend suite | PASS — 145 total, 141 passed, 0 failed, 4 skipped |
| Dashboard lint | PASS — 0 errors, 8 non-blocking warnings |
| Dashboard production build | PASS — Vite build completed; chunk-size warning remains |
| Prisma schema validation | PASS |
| `git diff --check` | PASS |

The ten failures from the previous report were resolved as follows: obsolete manager/organization-admin fixtures were converted to the canonical role model; the manager-scope assertion was updated to organization-admin scope; expiry-aware query assertions were updated; planner deletion regained its documented `deletedId`; and the enrollment-token route now uses the standard `{ error: { code, message } }` envelope. No RBAC or tenant-isolation check was relaxed.

The four skipped PostgreSQL tests are: database health, migration/seed lifecycle, invitation lifecycle, and PostgreSQL self-enrollment lifecycle. Both local PostgreSQL ports tested refused connections. `TEST_DATABASE_URL` was intentionally left unset; `DATABASE_URL` was never used as a test fallback.

## Expiry and browser lifecycle review

The organization gallery list, employee capture list, capture metadata endpoint, and private image endpoint all require `expiresAt: { gt: new Date() }`. Retention cleanup and explicit deletion intentionally query expired rows so they can remove them. The extension capture factory registers its browser listeners once per factory instance, invalidates via generation increments, guards stale expiry timers with `expiryVersion`, aborts uploads on invalidation, and serializes badge work. The worker creates one capture factory and one runtime listener set during service-worker evaluation; heartbeat and periodic sync do not establish screenshot authorization. Existing extension lifecycle tests pass.

## Isolated release candidates

Candidates were written to `artifacts/screenshot-release-candidates-20261107/`, not to the public download directory:

| Package | SHA-256 |
|---|---|
| `digitalpulse-chrome-extension.zip` | `21411ef0bd76ad731f3dcb61bf0a498c32a08a85a3a694fd00bd437f5e705c27` |
| `digitalpulse-edge-extension.zip` | `33353afba377673e480d1ab30bb382f24e0bd65b9630ed8f9de8bc98f36165bb` |

Both archives contain the Manifest V3 manifest, service worker, screenshot capture module, popup, shared modules, and icons. Their sidecars match the archive hashes. No key file is packaged; stable extension identity therefore remains dependent on the existing browser deployment/enterprise ID strategy and was not verified in a real profile. Existing enrollment credentials and public ZIPs were not replaced.

## Real-browser and release evidence

Real Chrome and Edge staging acceptance was **not run** in this environment. Therefore the following remain PENDING, not PASS:

- manual Chrome permission grant and real Chrome capture;
- manual Edge permission grant and real Edge capture;
- authenticated upload and persistence using staging accounts;
- opening an actual private image in the organization gallery;
- unauthorized employee image access rejection in a live deployment;
- revocation, expiry, permission-removal, navigation, focus, and worker-restart acceptance in Chrome and Edge;
- production HTTPS package inspection, installation without replacing enrollment, and SHA256 sidecar verification.

No actual capture IDs, staging upload IDs, or real-browser gallery evidence are claimed. Existing ZIPs and sidecars were not overwritten during this pass.

## Remaining limitations and next action

The system should remain **NOT READY** until the four PostgreSQL integration tests run against an isolated database, the remaining dashboard test failures are resolved or their fixtures are proven obsolete, and an operator manually grants the browser permission in both Chrome and Edge and records one real capture through the private gallery.

Exact next manual action: provision an isolated staging PostgreSQL database and approved Chrome/Edge test accounts, run the documented acceptance flow with the extensions pinned, manually approve the optional host permission in each browser, and record sanitized capture IDs plus gallery verification results.

## Manual Chrome/Edge acceptance checklist

An employee/operator must perform the permission action in the browser UI; automation must not approve the prompt.

1. Use the isolated staging HTTPS backend and approved harmless HTTP(S) test page. Confirm the candidate ZIP is installed as an unpacked extension without removing the existing enrolled profile or changing its device ID.
2. In Chrome, open the extension popup, read the permission explanation, and manually click the grant button. Record grant, decline, and removal behavior separately. Confirm permission alone leaves monitoring unauthorized and the badge off.
3. In Edge, repeat the same manual permission steps and confirm the Edge candidate reports Edge while preserving its existing enrollment identity.
4. With administrator policy enabled, employee notice acknowledged, consent granted, device selected, administrator authorization active, schedule active, and a focused normal window, confirm the visible ON badge appears only after policy authorization.
5. On each browser, capture a harmless active HTTP(S) page. Record the sanitized attempt ID, upload response/capture ID, metadata row, byte/MIME/dimension validation, and the organization gallery timestamp. Open the private image as the administrator.
6. Verify an employee or other organization cannot list metadata or fetch the image. Verify expired records return not found/forbidden before cleanup.
7. During a pending attempt, switch tabs, navigate, change focus, enter idle/lock, remove permission, revoke the device, and withdraw policy. Confirm the image is discarded and no upload occurs.
8. Restart the extension service worker/browser and confirm stale authorization and the badge are cleared before a fresh policy check.
9. Repeat the actual capture and gallery-open evidence independently in both Chrome and Edge. Attach only sanitized IDs, timestamps, and status codes to this report.
