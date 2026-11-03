# DigitalPulse employee installation and packaging

Verified on 2026-11-03. Release classification: **LOCAL DEVELOPMENT / INTERNAL TEST BUILD**.

The three independently packaged collectors are ready for local download. The complete PostgreSQL-backed employee invitation-to-enrollment browser workflow is **not yet verified**: no isolated `TEST_DATABASE_URL` is configured. Public production distribution and installation on separate employee computers also require an HTTPS deployment and real-browser rollout checks.

## What changed

- Employee Setup now uses the existing consent, own-account enrollment and monitoring-status APIs. It provides three independent download cards, package checks/retry, four-hour token expiry, copy feedback and duplicate-submission guards. Raw tokens stay in React state for the current page session only. Generating a token changes no consent, role, employment or monitoring authorization setting.
- Installation, enrollment, connection and monitoring authorization are displayed separately. An enrolled device without a heartbeat shows Connection Pending. A server-confirmed authenticated heartbeat is required for Connected. Account and per-device authorization are shown separately from connection and do not claim that live collection is active.
- The download check requires a successful HEAD response, ZIP/octet-stream content type and a positive content length. HTML SPA fallbacks, failed requests and zero-size responses remain unavailable. Checks time out and can be retried.
- The browser popup has backend settings with strict origin validation. Remote HTTP, URL credentials, paths, queries and fragments are rejected. Saving a remote HTTPS origin requests permission for that specific host. Changing hosts with existing credentials or pending events is rejected to protect ownership and queued data. Existing settings and the pending queue are preserved.
- Extension host permissions retain localhost access and replace the previous mandatory `<all_urls>` grant with optional HTTPS origins. Trusted extension contexts retain access to credentials; content scripts are not given storage access. Credential-bearing HTTP calls reject redirects and time out. Popup backend reachability, device heartbeat and monitoring state remain distinct.
- Backend self-enrollment and monitoring APIs were preserved. Tests retain employee-only tenant scope, token hashing, atomic single-use consumption, heartbeat authentication, revocation, explicit consent, administrator approval, schedule boundaries, overnight shifts and daylight-saving behavior.

## Windows storage and credentials

The prior default was `agent_storage.db` in the working directory. The Windows default is now `%LOCALAPPDATA%\DigitalPulse\agent_storage.db`, independent of where PowerShell launches the agent. Parent directories are created; missing `LOCALAPPDATA` or inaccessible storage produces an actionable error instead of falling back to a temporary database. `DP_DB_PATH` remains available for existing installations and recovery.

When no destination exists, one legacy database from the working or executable directory is copied with SQLite `VACUUM INTO`, which includes uncheckpointed WAL contents consistently. A completed snapshot is published without overwriting a concurrently created destination. The source is preserved. Multiple distinct legacy candidates cause an error requesting an explicit `DP_DB_PATH`; records are never silently merged or deleted. Tests verify preservation of identity and queued events across repeated opens. Stop old agents before an upgrade. Databases in other locations are not automatically discovered.

Device credentials continue to use Windows Credential Manager. The installer adds no plaintext device-secret file or SQLite secret storage. Existing legacy-secret migration code remains. `--status` shows local enrollment, storage path and queue counts, and does not claim that a backend heartbeat occurred. `--server` applies consistently to agent commands. Transport URL parsing rejects embedded credentials and supports IPv6 loopback. Running a collector still requires server authorization before live activity is read.

## Packages and URLs

The paths below are served by the dashboard, for example `http://localhost:5173/downloads/...` while its development server is running. A production Vite build also copies them into `dist/downloads`. Actual HTTP delivery was verified from the production build with a temporary loopback preview server; no public deployment is claimed.

| Package URL | Bytes | SHA-256 |
| --- | ---: | --- |
| `/downloads/digitalpulse-windows-agent.zip` | 1,573,152 | `94ef1fc2c321de7aaad65c56234cf892487f21d3eaf2b2ab3c6f81912a1cc0a8` |
| `/downloads/digitalpulse-chrome-extension.zip` | 21,671 | `5562095c38f9969287a4b8e98e202df75a90410134f179222c262799a5a8372e` |
| `/downloads/digitalpulse-edge-extension.zip` | 21,610 | `d21ad3fc17c0c70a7a608e9715d267787fe244bdea07e0a932b11db906a0e231` |

Each URL has a `.sha256` sidecar. Windows contains exactly `digitalpulse-windows-agent/dp-user-agent.exe` and `README.txt`. Each browser ZIP contains 15 files under its own `digitalpulse-chrome-extension` or `digitalpulse-edge-extension` folder. Both browser runtime trees are byte-for-byte identical to the same source; only their browser-specific READMEs differ. No backend/dashboard source, `.env`, employee database, node_modules, tests, caches, enrollment tokens or device credentials are packaged. The Windows binary is a portable, unsigned user-session executable, not an MSI/service installer.

## Rebuild and verify

The packaging script resolves the repository from `$PSScriptRoot` and works from another working directory. It builds the release agent inside `desktop-agent`, so rustup uses the checked-in GNU toolchain rather than an unrelated default MSVC toolchain. Cargo and a compatible GNU linker must be available. On this workstation the linker directory is `D:\Program Files\msys64\ucrt64\bin`; add the installed linker directory to the build process PATH if needed. Employees do not need this toolchain.

From the repository root:

```powershell
npm.cmd run package:employees
# Intentional replacement of an existing reviewed package set:
npm.cmd run package:employees -- -Overwrite
npm.cmd run verify:employee-downloads
npm.cmd run build --workspace @digitalpulse/dashboard
npm.cmd run verify:employee-download-http
```

The packager checks every native exit code, validates Manifest V3, runtime files and PNG dimensions, stages only approved runtime paths, scans text for credential-like material, writes normalized ZIP paths, opens/reads entries, verifies required files and hashes, then publishes the entire package set. Existing downloads are rejected before building unless `-Overwrite` is explicit. Replacement keeps backups for rollback if publishing fails. Temporary cleanup validates the resolved staging path and unique directory name before recursive removal. The enterprise distribution script remains unchanged; the old Windows-download script is a compatibility wrapper to the new packager.

The standalone verifier compares packaged runtime bytes with the source/release executable, checks sidecar hashes and browser-specific READMEs, and runs the extracted Windows binary with only Windows on PATH. It launches two separate `--status` processes from different working directories with isolated temporary storage and checks the same identity survives. It performs no real backend enrollment, device association or monitoring. The HTTP verifier checks HEAD status/type/size, GET ZIP signature and the hash of every downloaded archive against its sidecar.

## Exact local employee installation

1. Run the backend on the same computer at `http://127.0.0.1:3001`. Start the dashboard, accept the administrator's invitation and sign in as the employee.
2. Open `/employee-setup`. Read the disclosure and give consent only if you agree. The administrator must independently authorize monitoring and configure the organization time zone. Review your work schedule under My Devices.
3. Download the Windows ZIP and extract it. Open PowerShell inside `digitalpulse-windows-agent`. Generate a Windows desktop agent token in Employee Setup, then run:

   ```powershell
   $enrollmentToken = Read-Host 'Paste your one-time token'
   .\dp-user-agent.exe enroll --token $enrollmentToken --server http://127.0.0.1:3001
   Remove-Variable enrollmentToken
   .\dp-user-agent.exe --status
   ```

   When ready to connect, run `.\dp-user-agent.exe`. It remains paused until server consent, approval and schedule checks pass. Check the dashboard heartbeat for Connected; stop with Ctrl+C. Keep `%LOCALAPPDATA%\DigitalPulse` when upgrading or removing the program until pending records have been reviewed.
4. For Chrome, extract its ZIP, open `chrome://extensions`, enable Developer mode, select Load unpacked and choose the extracted `digitalpulse-chrome-extension` folder containing `manifest.json`. Pin DigitalPulse. Generate a separate Browser extension token, paste it in the popup and select Enroll.
5. For Edge, repeat using its own ZIP, `edge://extensions`, and `digitalpulse-edge-extension`. Generate a fresh browser token: each installation consumes its own single-use token.
6. Verify popup/backend heartbeat and dashboard monitoring authorization separately. Review each package's README for errors, revocation, removal and retention. Do not erase the pending queue to resolve authorization or installation errors.

`127.0.0.1` refers to the employee's own computer. This local configuration cannot connect employees on separate computers to the developer's backend. No screenshots or live screen sharing are enabled by these installation steps.

## Verification results and limits

- Backend: `$env:NODE_ENV='test'; npm.cmd test --workspace @digitalpulse/backend` — **116 tests, 112 passed, 0 failed, 4 skipped**. The ordinary first run loaded development mode from `.env` and failed in the existing native screenshot capture chain after its PowerShell capture timed out. Test mode passed with the pre-existing screenshot fixture fallback; this does not verify real screen capture, and no screenshot implementation was changed by this work.
- The four skips are the real database health check, migration/seed check, invitation lifecycle and new PostgreSQL self-enrollment lifecycle. All require a separately migrated `TEST_DATABASE_URL` and `RUN_INTEGRATION_TESTS=true`. The new lifecycle covers tenant-derived tokens, hash-only persistence, four-hour expiry, concurrent single-use consumption, pre-heartbeat status, authenticated heartbeat, consent vs administrator approval, directory secret filtering, revocation and expired tokens. These PostgreSQL checks were **not executed**. Neither production nor development application data was used as test fixtures.
- Dashboard: **32 passed**, including invitation return after sign-in, verified vs failed/HTML downloads, token copying, duplicate-click prevention and truthful heartbeat statuses. Production Vite build **passed** with all six download artifacts present.
- Browser extension: **21 passed**, covering existing queue/sync/authentication/monitoring behavior plus backend origin validation, exact-host permission requests, settings preservation and blocked credential/queue migration.
- Rust: `cargo test --workspace` — **35 passed**, including persistent path selection, WAL-consistent copy/reopen, ambiguous-source refusal, URL validation and existing platform/sync tests. `cargo build --release --locked -p dp-user-agent` **passed** with the GNU toolchain.
- All three ZIPs opened and passed file/source/hash inspection. The extracted Windows executable started without GNU/MSYS directories on PATH and kept the same identity across separate process launches. The no-overwrite guard returned nonzero before building or changing packages, as intended. HTTP HEAD and GET of all three ZIPs returned 200 with correct content type, nonzero length, ZIP signature and matching SHA-256.
- Actual unpacked installation in the user's interactive Chrome/Edge profiles and the complete live invitation-to-device heartbeat flow have **not** been executed. No local test is represented as successful PostgreSQL enrollment, email delivery or public deployment. Windows Credential Manager remains the implemented credential storage; the portable smoke test only read an absent credential for its isolated identity, not a real enrolled device secret.

## Production rollout requirements

Deploy the backend over HTTPS, configure trusted CORS and secure cookies, set real production invitation/reset URLs and SMTP, approve the specific extension backend host, and configure explicit process-scoped agent remote permission. Do not enable remote HTTP, disable TLS validation or set `DP_ALLOW_REMOTE_BACKEND=true` globally. Rebuild and verify every package against that approved deployment. Provision a separate migrated test database and pass the real account/invitation/enrollment/heartbeat/revocation tests, then run Chrome/Edge and Windows acceptance tests on separate employee computers before production distribution.

## File inventory for this change

Created: `desktop-agent/crates/dp-storage/src/paths.rs`; `apps/browser-extension/shared/backend-settings.js`; `apps/browser-extension/tests/backend-settings.test.js`; `backend/tests/employee-enrollment-postgres.integration.test.js`; `scripts/package-employee-downloads.ps1`; `scripts/verify-employee-downloads.ps1`; `scripts/verify-employee-download-http.mjs`; `docs/installation/windows-agent.txt`; `docs/installation/browser-extension.txt`; this document; three ZIPs and their three SHA-256 sidecars in `apps/dashboard/public/downloads`.

Modified: `desktop-agent/crates/dp-storage/src/lib.rs`; `desktop-agent/crates/dp-user-agent/src/main.rs` and `sync.rs`; extension `manifest.json`, `background/service-worker.js`, `background/sync-client.js`, `background/policy-sync.js`, `popup/popup.html`, `popup/popup.js`; dashboard `src/pages/EmployeeSetupPage.jsx` and `src/test/app.test.jsx`; `backend/tests/database.integration.test.js` and `backend/tests/invitation-postgres.integration.test.js` (database-target checks normalize PostgreSQL URI aliases); `scripts/package-windows-agent-download.ps1`; root `package.json`; `docs/DEVELOPMENT.md`; `docs/IMPLEMENTATION_STATUS.md`.
