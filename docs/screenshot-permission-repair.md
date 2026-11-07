# Chrome/Edge screenshot permission repair

Status: IMPLEMENTED AND AUTOMATED-CHECKED; REAL BROWSER VERIFICATION PENDING.
Date: 2026-11-07. No deployment, commit, backend change or production-data change.

## Root cause and permission model

The source and previous generated manifests had `tabs` and the API origin, but
neither `<all_urls>` nor `activeTab`. `tabs` exposes tab metadata; it does not
authorize screenshots. `captureVisibleTab` requires `<all_urls>` or a temporary
user-invoked `activeTab` grant. An alarm is not a user gesture. The configuration
generator also deleted optional host permissions, so a manifest-only fix would
have been lost during packaging.

References: [Chrome captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab),
[Chrome optional permission requests](https://developer.chrome.com/docs/extensions/reference/api/permissions).

The production manifests now contain:

```json
{
  "permissions": ["tabs", "webNavigation", "idle", "storage", "alarms", "declarativeNetRequest"],
  "host_permissions": ["https://screentimer.onrender.com/*"],
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background/service-worker.js", "type": "module" }
}
```

| Permission | Purpose |
| --- | --- |
| tabs | Existing domain tracking and active-tab URL eligibility checks |
| webNavigation | Existing blocked-navigation reporting |
| idle | Reject idle/locked capture; existing activity timing |
| storage | Existing enrollment, queue, settings and capture diagnostics; no image persistence |
| alarms | Existing 30-second sync scheduler plus authorization-expiry wakeup |
| declarativeNetRequest | Existing website blocking |
| Required API origin | Existing authenticated policy, enrollment, heartbeat and upload requests |
| Optional `<all_urls>` | Browser-required host grant for unattended `captureVisibleTab`; not granted automatically |

No `activeTab`, scripting, debugger, desktopCapture or content-script permission
was added. The broad optional grant is a browser API requirement, not permission
to collect every tab. Code independently restricts capture to HTTP(S), active,
focused, normal, non-minimized/non-fullscreen windows and non-incognito tabs.

## Onboarding and authorization

The popup explains the scope and sensitive-content risk before an employee clicks
Allow scheduled browser screenshots. `permissions.request` is the first async
operation inside that click handler. The browser owns its prompt; no worker
requests permission or accepts prompts. Decline keeps capture off. A separate
button removes the optional grant. A grant is not consent or server authorization.

Every attempt checks browser permission and a pinned toolbar action. The
authenticated screenshot policy remains the authority for employee acknowledgement,
organization monitoring, employee/device assignment, screenshot selection, consent,
revocation and schedule. No backend authorization logic was changed. Deadline,
indicator and target checks precede capture; policy, browser permission, device
identity, target, indicator and both deadlines are checked again before upload.
The original image lease cannot be extended by a later policy response. A shortened
lease shortens indicator/cancellation deadlines. Failed images are not persisted.

Permission removal, unpinning (where the browser emits its settings event),
tab/navigation/focus transitions, idle state, expiry and failures invalidate the
capture generation. Upload cancellation is best effort. A timer plus browser alarm
clears authorization; restart clears stale state and requires a fresh check.
Heartbeat/domain activity cannot turn the screenshot ON badge on. Heartbeat and
screenshot policy have different response fields; the worker regression test
verifies that ordinary domain tracking still works with the existing heartbeat.

## Files changed in this repair

Paths below are relative to the repository. Pre-existing worktree changes were
preserved; this is not a classification of the entire dirty repository.

| File | Change |
| --- | --- |
| apps/browser-extension/manifest.json | Declare optional all-URL screenshot host grant; preserve name, version, worker and identity fields |
| apps/browser-extension/shared/capture-permissions.js | Shared permission descriptor and fail-closed permission check |
| apps/browser-extension/popup/capture-permission.js | Explicit grant/decline/revoke onboarding handlers |
| apps/browser-extension/popup/popup.html | Disclosure and controls; remove hardcoded loopback display |
| apps/browser-extension/popup/popup.js | Initialize permission controls independently of enrollment |
| apps/browser-extension/background/screenshot-capture.js | Permission, pin/badge, deadline, generation and upload checks; expiry/revocation handling |
| apps/browser-extension/background/service-worker.js | Separate heartbeat from screenshot badge authority; clear screenshot state on sync failure |
| apps/browser-extension/shared/backend-settings.js | Remove implicit packaged loopback fallback; fail closed when stored enrolled backend identity is missing |
| apps/browser-extension/tests/screenshot-capture.test.js | Expanded capture safety and lifecycle tests |
| apps/browser-extension/tests/capture-permission.test.js | Popup gesture/denial/grant/removal and manifest tests |
| apps/browser-extension/tests/service-worker.test.js | Execute worker with mocked APIs; test scheduling, badge ownership and enrollment preservation |
| apps/browser-extension/tests/backend-settings.test.js | Missing enrolled backend identity must not redirect credentials |
| apps/browser-extension/tests/blocked-attempts.test.js | Fixture includes backend identity, as real enrollment writes it |
| scripts/configure-browser-extension.mjs | Preserve optional permissions, support staged output and reject non-HTTPS/loopback production origin |
| scripts/package-employee-downloads.ps1 | Candidate output directory; configure staged copies; verify manifests and reject packaged loopback URLs |
| docs/installation/browser-extension.txt | Permission disclosure, same-path update instructions and honest screenshot/privacy limitations |
| docs/screenshot-permission-repair.md | This report |

The existing sync-scheduler and tab-manager changes were inspected but not edited
by this repair. No dashboard, backend RBAC, migration or desktop-agent edits.

Generated artifacts: Chrome and Edge ZIPs with SHA256 sidecars in each of:

- `artifacts/screenshot-permission-candidates/` — superseded, retained.
- `artifacts/screenshot-permission-candidates-v2/` — superseded, retained.
- `artifacts/screenshot-permission-final-candidates/` — final candidates to test.

Existing public-download ZIPs and sidecars were not replaced. Packaging configured
only staged copies, leaving the local development manifest host/deployment intact.
No enrollment storage was edited. Keep the same unpacked installation path/profile
or existing store identity when upgrading; moving/reinstalling an unpacked
extension can change its identity independently of these code changes.

## Executed checks

`npm.cmd test --workspace=@digitalpulse/browser-extension`: **55 passed, 0 failed,
0 skipped**. Includes capture permission granted/denied/unavailable/revoked,
expiry during asynchronous pre-capture and pre-upload work, withdrawal before
upload, hidden/inactive/incognito/minimized/fullscreen targets, indicator failure,
unpinned action, policy-fetch failure, overlap/retry/restart, expiry alarm,
shortened authorization, popup user gesture, worker integration and scheduler.

The first intermediate run was 42/43: blocked-attempts used an enrolled fixture
without its stored backend identity. Real enrollment stores that identity. The
fixture was corrected and a separate fail-closed missing-identity test added.
Intermediate 53/53 and 54/54 runs preceded the final 55/55 run.

`git diff --check`: passed. There is no extension build/lint script in its package;
its runtime is native ESM, copied into MV3 packages. No claim of an unrun lint/build
tool or backend test execution is made.

Final packaging command (executed successfully after tests):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-employee-downloads.ps1 -ExtensionsOnly -Deployment Production -OutputDirectory D:\desktop\task2_updated\DigitalPulse\artifacts\screenshot-permission-final-candidates
```

Both final ZIPs contain 21 entries. ZIP inspection confirmed the module worker,
optional grant, screenshot module, permission helpers and exact Render URL in
both manifest and deployment configuration. All packaged runtime/icon bytes were
compared to current source, excluding intentionally generated deployment config.
SHA256 sidecars match. Text/filename checks found no loopback URL, env file, test
fixture, device-token pattern, private key or credential-bearing PostgreSQL URL.
Pattern scanning is not a mathematical proof that arbitrary unknown secrets
cannot exist; only whitelisted runtime assets and README are packaged.

| Final package | SHA256 |
| --- | --- |
| digitalpulse-chrome-extension.zip | d5d7bbb8f41db1e5d5bb678ce8982bdb9eb375b565876175b2b9573c61b65e6a |
| digitalpulse-edge-extension.zip | 158374257ff3b7e3a97a6c40620caaa5bfeeeec3cd3b763d6614d62c52c9b09e |

The existing public Chrome/Edge hashes remain respectively
`1b767a9186e7e3916cb62f746b7dd42f9e8689394ba29e1901640854aa5bcd05`
and `2ec25d8e1dd1eaab6d088330c7e8291ffb8f2b6f024a866b9155c3a61f731c26`.

## Actual-browser verification: pending employee-operated test

Chrome and Edge executables are installed, but no interactive browser connector
is available to this agent. No browser permission grant, real screenshot, backend
upload or gallery success has been observed. The user offered to test both browsers;
results have not yet been supplied. Mocked tests are not browser permission proof.

Run separately for Chrome and Edge, using the FINAL candidate only:

1. Record extension ID and popup Device ID; back up the current unpacked folder.
   Extract the matching candidate into that SAME installed folder and Reload at
   `chrome://extensions` or `edge://extensions`. Do not uninstall, clear storage,
   re-enroll or load from a different path. Verify both IDs are unchanged and
   the popup backend is `https://screentimer.onrender.com`.
2. Pin DigitalPulse. Use only an explicitly authorized test employee, selected
   device and valid schedule. Do not change consent/authorization merely to force
   a test pass. If backend policy denies capture, retain the reason and investigate.
3. Click Allow scheduled browser screenshots and decline the native prompt.
   Confirm no ON badge or new screenshot. Click again; accept manually only if
   you agree. Confirm permission is granted. Do not automate either browser prompt.
4. Open `https://example.com` in a normal focused, non-incognito window. Click
   Sync Now and close the popup. Keep that tab visible through a five-minute
   capture interval. Do not keep the service-worker inspector focused: that makes
   the test tab ineligible. ON indicates authorization, not delivery.
5. Afterward inspect the worker, requesting ONLY safe diagnostics:

```js
await chrome.permissions.contains({ origins: ['<all_urls>'] });
await chrome.action.getUserSettings();
await chrome.action.getBadgeText({});
await chrome.storage.local.get([
  'dp_screen_capture_error', 'dp_last_screen_capture_at',
  'dp_last_screen_capture_id', 'dp_monitoring_indicator_active'
]);
```

6. Verify the new capture ID/image in the organization gallery and open the image.
   Check employee, device, browser/collector and capture timestamp. Report status
   code and sanitized response only if observing upload traffic. Never export a
   HAR, all storage, request headers, token or device secret.
7. Remove permission with the popup button. Confirm the badge clears and no later
   captures appear. Regrant only with deliberate user approval. Test unpinning,
   minimized/fullscreen windows and incognito; no capture should occur.
8. Reload the worker with permission denied and again with a still-valid grant.
   Check alarm recovery and fresh authorization. A recent successful capture must
   retain its interval across restart. Confirm IDs/enrollment remain unchanged.

Report per browser: prompt/decline/grant/revoke, badge state, capture ID/time,
gallery-open result and sanitized error code. Actual HTTP response/capture ID:
**not yet observed**.

## Remaining limitations

- NOT READY for a claim of successful real browser capture until the above test
  passes in both browsers. Backend deployment eligibility/consent is not verified
  by this local extension repair.
- Server-side withdrawal cannot be learned instantaneously offline. Fresh policy
  is fetched each attempt and before upload; backend authorization remains
  authoritative. Local expiry/revocation cancels work immediately when observed.
- MV3 suspension can delay alarm delivery/badge clearing. Expiry checks still
  fail closed when executing. Already-sent bytes cannot be retracted by aborting
  a request; server-side authorization must also reject ineligible requests.
- Browser tab capture is a window-based API, not an atomic tab-ID snapshot. Target
  checks/events reject known transitions and discard changed-target images before
  upload, but browser-level timing races cannot be eliminated by JavaScript.
- Enterprise site-access restrictions may deny the optional grant. Keep capture
  disabled; do not bypass administrator/browser controls.
- No persistent image retry queue exists. Failed uploads discard the image and a
  later authorized attempt captures anew. Existing backend deduplication remains.
