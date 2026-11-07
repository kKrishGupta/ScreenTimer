# Screenshot monitoring repair and verification

## Confirmed runtime cause (7 November 2026)

Read-only queries against the database configured in backend/.env returned two assigned,
non-revoked browser extensions, no DESKTOP_AGENT records, and no screen_captures rows.
No dp-user-agent process was found in the inspected Windows session. Installing an
agent does not enroll it. Browser extensions are intentionally ineligible for this
desktop screenshot feature. The UI collector and enrollment service both use the
correct DESKTOP_AGENT value; no enrollment contract mismatch was found.

## Repairs

- screenshot.rs: authorization/indicator/deadline gate precedes queue upload; denial
  clears sensitive pending files. Retry entries expire after 24 hours and the queue
  remains bounded to 50 captures. Validate queued keys and capture size/JPEG markers.
  Refresh the installed PowerShell helper; report capture/upload failures.
- sync.rs: require explicit visibleIndicator=true, parse allowedUntil, log policy
  reasons, and require a successful capture acknowledgement before queue deletion.
  The wire test checks URL, authentication headers, metadata and raw payload.
- tray.rs/main.rs: agent-owned hidden notification window, message processing,
  recovery when Explorer loses the icon, and fail closed when registering the icon
  fails. The shield is a standard Windows icon, not a custom brand asset. Shell
  registration cannot prove that the user can see an icon hidden in tray overflow.
- screen.routes.js: current authorization and capture-time authorization both apply
  to uploads; the policy deadline is the earlier of the activity and screenshot
  schedule ends. Check JPEG frame dimensions against submitted metadata. A failure
  updating device status cannot delete an already persisted image. Device list
  includes revoked desktop devices and reports policy reasons. Latest capture status
  comes from stored metadata and flags disagreement with cached device status.
- ScreenMonitoringPage.jsx: separate absent enrollment from search results; show
  policy denial, employee email, heartbeat and revoked status. Allow deselection even
  when acknowledgement is absent. Preserve existing gallery, settings and layout.

No database migrations or edits to existing records were performed for this repair.
Cloudinary configuration and authentication architecture are unchanged.

## Automated verification

- cargo test -p dp-user-agent: screenshot queue-denial and upload wire tests, plus
  existing tests. The existing activity integration test returns early unless
  RUN_INTEGRATION_TESTS is set; do not count it as an activity integration run.
- Backend screen, screen-upload, screen-governance and role-scope-regression suites:
  authenticated HTTP injection, real encrypted temporary-file storage, fixture JPEG,
  deduplication, invalid metadata, oversized payload, invalid secret, excluded app,
  revoked consent/device, private gallery/image retrieval and cache-update failure.
  Database objects are test doubles. Cloudinary tests mock the provider.
- Dashboard screen-monitoring tests: empty enrollment, policy diagnostics, device
  selection, settings save, returned image URL, viewer, search and deletion.
- Dashboard production build and targeted lint.

These checks are not a live employee screenshot acceptance test.

## Real Windows acceptance still required

1. Build and deploy the updated backend/dashboard and rebuild the Windows user agent
   (`cargo build --release -p dp-user-agent` in desktop-agent). Ensure the installed
   executable is the rebuilt version, not the previous installer payload.
2. Sign in as the intended employee and create a Windows Desktop Agent enrollment
   token using the existing device setup page. Enroll from that employee's Windows
   session against the same backend used by the organization dashboard. Do not paste
   the enrollment token or device secret into logs or this report.
3. Verify a DESKTOP_AGENT record with correct organization/user assignment and a
   recent heartbeat. `node scripts/diagnose-screenshots.js` from backend gives a
   read-only aggregate check; compare the organization device list for exact scope.
4. Have the employee personally acknowledge the screenshot notice and consent.
   Have an administrator authorize monitoring, enable the screenshot policy and
   select that device. Preserve the saved schedules; test during an authorized window.
5. Start the agent in the employee's unlocked interactive Windows session. Verify
   SCREEN_POLICY_FETCHED reports allowed=true and physically confirm the tray icon
   and tooltip are visible. Check Explorer restart behavior and tray overflow.
6. Wait for the configured interval. Verify capture/upload logs, a stored metadata
   row and successful authenticated image retrieval in the gallery. Compare the
   actual captured timestamp, device and employee against the database record.
7. Withdraw consent or disable monitoring. Verify the next policy refresh stops
   collection, pending images are cleared, and backend uploads are rejected even
   before the client refreshes. Also test workstation locking and schedule end.

Enrollment, real agent heartbeat, on-screen indicator visibility, actual work-screen
capture, live Cloudinary upload and gallery display remain unverified until these
steps are completed. Do not report production success based on fixture tests.
