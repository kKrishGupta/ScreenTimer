# DigitalPulse Windows executable audit — 2026-11-08

**Decision: NOT READY.** Candidate builds and collection-disabled Windows execution pass. Real employee-consented activity, enrollment, lifecycle changes, database persistence, private screenshot storage and real-data dashboard acceptance are blocked by lack of isolated staging infrastructure and capture consent. No public EXE/ZIP was replaced and no production records were changed.

Evidence directory: `artifacts/windows-exe-audit-20261108/`. JSON files and logs there are the evidence, not inferred backend outcomes. Existing uncommitted lifecycle/screenshot changes were preserved. This audit does not certify those earlier changes solely from their presence.

## A. Executable inventory

Readable per-artifact appendix: [executable-inventory.md](../artifacts/windows-exe-audit-20261108/executable-inventory.md). Final candidate size: **3,228,160 bytes**. Compiler recorded by Cargo: rustc **1.99.1 (58cf8f9c3, 2026-10-13)**, `x86_64-pc-windows-gnu`, LLVM 23.1.1.

Initial scan: **99 executable paths/archive entries, 59 distinct SHA-256 values**, including build helpers, Rust test executables, dependency tools and workspace junction aliases. These are not 99 shipped agents. All parsed as x64. `inventory-baseline.json` records every path, byte size, SHA-256, PE timestamp, subsystem, imports and certificate-table size. `pe-baseline.json` records Authenticode status and available file/product version metadata for all entries. Final scan: 138 entries (includes new candidate/test builds and inspection copies); see `inventory-final.json` and `pe-final.json`. These counts are snapshots before any subsequently installed audit-tool EXEs.

| Artifact | SHA-256 | Status |
|---|---|---|
| Existing `desktop-agent/target/release/dp-user-agent.exe` | `0575d1b9c4a89c068e6d04f0d96e421718d2ff105d1bda16c500687ae4a02158` | Existing build, not certified current |
| Public/dist ZIP agent (including junction aliases) | `f616f256513a6d1eae386ab653e9bf33a2d3b318f9f6c56ab85db7a4d98b8c7e` | Different from existing release; unchanged |
| Final `artifacts/windows-exe-audit-20261108/target/release/dp-user-agent.exe` | `4198364d1008197a5f0d45e438d5892374d5b8b96f2b56e67d0f18e14658b974` | Built from audited working tree; actual Windows tests recorded |

The agent is PE console subsystem 3, version command `0.1.0`, unsigned, with no embedded release provenance sufficient to prove source correspondence. A PE timestamp or identical version string cannot establish freshness. The candidate's hash was verified unchanged throughout the final runtime run. GNU release configuration: optimization 3, fat LTO, one codegen unit, abort on panic, stripped, no debug info. Debug/test executables are not deployment artifacts. Tool/dependency EXEs have upstream build provenance unknown to this audit; inventory distinguishes their paths and imports. They were inspected, not executed indiscriminately.

Runtime imports include Windows kernel/user/shell/credential/cryptography/WinHTTP APIs and Universal CRT API sets; SQLite is bundled. Screenshot helper additionally needs Windows PowerShell, System.Drawing and Windows Forms. Clean-machine DLL availability and Windows-version matrix remain NOT TESTED. Documentation targets Windows 11 x64, but platform detection checks Windows compilation, not OS build/version. No ARM64/x86 candidate was built.

## B. Architecture and execution flow

Six Cargo crates comprise the workspace. No application build.rs was found. `rust-toolchain.toml` selects stable Windows GNU; Cargo.lock pins dependencies but the compiler itself floats. The manifest declares Rust 1.80; current-toolchain success does not prove all locked dependencies support that MSRV.

| Component | Responsibility and observations |
|---|---|
| `dp-user-agent/main.rs` | Console entry point; version, enroll, status, oneshot, sync-now, timed/default monitoring. Configuration and UUID load, authorization gates, one-second synchronous sampling loop, periodic heartbeat/sync, final flush. Exclusive Windows file handle now prevents duplicate monitors on the same database path. |
| `dp-core/config.rs`, `contract.rs`, `session_manager.rs` | Environment overrides; event validation; UUID sessions, app/idle interval accounting and subsecond filtering. |
| `dp-storage/repository.rs`, `migrations.rs`, `paths.rs` | SQLite WAL, schema v2, atomic session+queue writes, per-event acknowledgments/quarantine, seven-day synced queue pruning, stable per-user path and non-destructive legacy migration. |
| `dp-platform-windows/foreground.rs`, `idle.rs`, `monitor.rs` | GetForegroundWindow, GetWindowThreadProcessId, QueryFullProcessImageNameW; GetLastInputInfo; app and idle transitions. No keystroke contents/window text captured by these APIs in this implementation. |
| `session_state.rs`, `tray.rs`, `diagnostics.rs` | Input-desktop eligibility, visible screenshot indicator, process CPU and memory measurements. Unknown desktops now fail closed. |
| `credential_store.rs`, `data_protection.rs`, `http.rs` | User Credential Manager device secret, DPAPI screenshot protection, WinHTTP with certificate verification, redirects disabled, phase timeouts and 2 MiB response cap. Headers now reject control characters. |
| `dp-user-agent/sync.rs` | One-time enrollment, authenticated heartbeat, explicit per-event ack validation, screenshot policy/upload/failure reporting. Remote requests require HTTPS and `DP_ALLOW_REMOTE_BACKEND=true`. |
| `dp-user-agent/screenshot.rs` | **Implemented desktop capture**, PowerShell CopyFromScreen of virtual desktop, JPEG encoding, temporary plaintext JPEG then DPAPI retry files, 50-capture queue limit, 24-hour expiry, bounded retry delay, policy/indicator gates. |
| `dp-service`, `dp-ipc` | Placeholders: service exits after reporting reserved named-pipe endpoint. No installed service/working IPC transport. |

Startup → stable SQLite path/identity → Credential Manager or legacy migration → configuration → authenticated heartbeat → finite server allowedFrom/allowedUntil gate → app/idle observations → validated SQLite events → authenticated batches → per-event acknowledgments → final local session close and conditional sync. Screenshot policy is an additional gate, not enrollment consent. Restart loads the same stored UUID/credentials and does not automatically resubmit enrollment tokens.

Default storage is `%LOCALAPPDATA%/DigitalPulse/agent_storage.db`; DP_DB_PATH overrides it. DP_BACKEND_URL, DP_DEVICE_SECRET, DP_ALLOW_REMOTE_BACKEND, DP_IDLE_THRESHOLD_SECS, DP_SYNC_INTERVAL_SECS and DP_LOG affect execution. Defaults are loopback HTTP, 60-second idle, one-second sample and 30-second sync. Agent does not install startup entries, update itself or install a service. Updates are manual distribution/replacement. Portable uninstall requires stopping/revoking the device and deliberate retention/credential cleanup; uninstall was not executed against the operator's installation.

API map (base URL prefix is preserved):

| Request | Persistence/display path |
|---|---|
| POST `/api/v1/devices/enroll` | DeviceService transaction consumes hashed token; device identity and hashed secret stored; raw secret returned once |
| POST `/api/v1/devices/{id}/heartbeat` | X-Device-Secret authentication, lifecycle check, device lastSeen/metadata and monitoring authorization; Devices/Employee Setup status |
| POST `/api/v1/activity/events/batch` | Device auth, tenant/owner/consent/schedule validation, ActivityEvent/ActivitySession transaction, deduplication IDs; analytics/timeline/app views |
| GET `/api/v1/screen-monitoring/device-policy?deviceId=...` | Current employee/org/device screenshot policy |
| POST `/api/v1/screen-monitoring/captures` | Authenticated JPEG and capture metadata headers; private store put and screenCaptureMetadata; cleanup on DB failure; gallery queries |
| POST `/api/v1/screen-monitoring/failures` | Device capture-failure reporting |

The backend rejects revoked/archived credentials on telemetry. Archive restore retains credentials but does not automatically re-enable screenshot capture. Revoked devices cannot be restored through ordinary enrollment. Enrollment token rotation/revocation is distinct from device credential revocation. Source and regression tests support these behaviors; live persistence remains unverified.

## C. Functionality and mandatory acceptance matrix

The 16 requested real acceptance scenarios are counted separately from unit/protocol tests: **2 PASS, 0 observed FAIL, 14 NOT TESTED**. A NOT TESTED item is a mandatory release blocker, not a pass.

| # | Scenario | Status | Actual evidence / limitation |
|---|---|---|---|
| 1 | Launch EXE | PASS | Final candidate version, unenrolled and denied-monitor processes executed on Windows; exit/PID/log records |
| 2 | Enroll valid token | NOT TESTED | No isolated authorized backend/test account; no successful live enrollment attempted |
| 3 | Restart enrolled identity | NOT TESTED | Local UUID continuity verified; actual enrolled Credential Manager continuity still requires staging |
| 4 | Heartbeat persisted | NOT TESTED | Local fixture requests observed, not production/staging DB writes |
| 5 | Approved activity persisted | NOT TESTED | Capture/activity consent and staging absent |
| 6 | Disconnect network | NOT TESTED | Connection-refused simulation passed; physical network not disabled |
| 7 | Restore network | NOT TESTED | Local HTTP 503→denied-policy recovery passed; real network restoration not exercised |
| 8 | Restart backend | NOT TESTED | No live backend restart authorized/executed |
| 9 | Revoke enrollment token, existing device unaffected | NOT TESTED | Backend regression coverage only |
| 10 | Revoke device | NOT TESTED | HTTP lifecycle fixture and backend unit tests only |
| 11 | Archive device | NOT TESTED | HTTP lifecycle fixture and backend unit tests only |
| 12 | Restore archive | NOT TESTED | Backend regression coverage only |
| 13 | Extended stability | NOT TESTED | Two-minute offline smoke completed; insufficient for extended realistic soak |
| 14 | Dashboard real agent data | NOT TESTED | 11 component tests passed; no real agent data/UI persistence chain |
| 15 | Unauthorized agent requests | NOT TESTED | Live unauthenticated gallery GET rejected; agent credential/tenant matrix only tested locally |
| 16 | Graceful shutdown | PASS (timed path) | Timed monitor exits 0, writes accounting summary and releases lock; console Ctrl+C/window-close paths remain NOT TESTED |

Additional features: service hosting/automatic update are NOT IMPLEMENTED. Foreground detection, idle/session tracking, screenshots, queueing and batch sync are IMPLEMENTED; real consented monitoring/screenshot acceptance is NOT TESTED. Status/unenrolled safety, invalid identity/configuration, duplicate lock/restart, denied-policy no-events behavior PASS in controlled Windows tests. No actual private screenshots were taken.

## D. Actual Windows execution evidence

`latest-runtime.txt` identifies the final runtime subdirectory. Its `runtime-results.json` contains **20 passed, 0 failed**, PID, exit code, elapsed time, timeout state and exact final executable hash. Per-scenario stdout/stderr files are retained. The test harness had a post-run summary variable-name error after saving results; it was corrected, and the completed artifacts were independently read and checked. It did not invalidate or rerun the recorded process observations.

Scenarios: version, unenrolled monitor, status twice, unenrolled oneshot/sync rejection, missing/invalid token, zero interval, invalid URL, corrupt identity, denied monitor, duplicate rejection, restart, revoked/archived protocol responses, 503 recovery, refused connection, forced termination and restart. All use isolated audit DBs and synthetic invalid credentials. The local HTTP server **always denies collection**; its successful response does not authenticate a real device. The 23 observed requests are listed in `protocol-requests.json`, including method/path/status, authenticated-header presence and request-body bytes; no secret values are logged.

Final denied-monitor sample: PID 18064; working set 13,348,864 bytes; peak 13,381,632 bytes; 197 handles; 7 threads; 0.046875 CPU seconds at sample time. These are measurements for a short paused run, not production performance guarantees. Inspect its summary log for elapsed/tick counts. SQLite inspection showed zero activity sessions and unchanged local identity across status/restart. No telemetry or image upload request was made.

`stability.json`: PID 20120, exit 0, no forced timeout, 25 samples over approximately 120 seconds, final working set 13,504,512 bytes, 200 handles, 0.0625 cumulative CPU seconds. `stability.stdout.log` records bounded retries and zero activity. Initial working-set growth includes loading WinHTTP/runtime libraries; two minutes cannot establish leak freedom. Active CPU/memory, sustained screenshot load, wire transfer totals, long-duration queue growth and multi-day stability remain NOT TESTED.

The first preliminary runtime run used a preceding build and is retained only as preliminary evidence. The final run explicitly records `unchanged_during_run: true` for the final hash. Build log PowerShell NativeCommandError formatting around cargo stderr is not itself a command failure; command exit status and Cargo completion lines determine success.

## E. Defects and repairs

| ID | Severity | Root cause / repair / evidence |
|---|---|---|
| F1 | High | Screenshot path queried foreground app even with denied activity/screen policy. Query now lazy and only made with effective authorization/visible indicator; unknown foreground fails closed. Regression closure panics if unauthorized read is attempted; denied EXE runs persist no activity. |
| F2 | High | No single-instance protection: simultaneous monitors could share identity and double collect. Exclusive Windows file handle per DB path now lasts through monitoring and releases on exit/crash. Unit test plus actual second-process rejection and restart passed. Path aliases/separate databases remain outside this lock's scope. |
| F3 | High | Invalid/read-failed stored UUID silently replaced identity. Errors now stop startup and retain existing value. Unit and corrupt-DB EXE regression passed. |
| F4 | Medium | Zero sync interval accepted, allowing heartbeat/policy requests each sample. Enforce 5–3600 seconds; boundary tests and EXE zero rejection passed. This is bounded fixed-interval retry, not exponential heartbeat backoff. |
| F5 | High | Session eligibility treated all named desktops except Winlogon as unlocked. Only Default desktop now eligible; unknown/secure/disconnected names rejected in regression test. Real lock/unlock test remains blocked by consent/session requirements. |
| F6 | Medium | WinHTTP header assembly accepted control characters including NUL/CRLF. Shared validation rejects invalid names/control characters before WinHTTP. Regression tests passed. |
| F7 | Medium | Legacy build script reused any existing EXE as latest, selected toolchain from wrong CWD, ignored native exit failures, and killed running employee processes. Now builds locked workspace in agent directory, checks exits, fails copy errors, requires explicit overwrite for existing distribution and does not kill processes. PowerShell parser: zero errors; actual packaging NOT TESTED to preserve release artifacts. |
| F8 | Medium | Strict lint gate failed (test unwraps, DPAPI mutability, opaque HWND lint, needless return, clone slices, source API newer than declared MSRV). Fixed diagnostics without globally weakening lints; targeted HWND allowance documents OS opaque-handle semantics. Full `clippy --workspace --all-targets -- -D warnings` passes. |

Remaining confirmed implementation limitations requiring follow-up before production acceptance:

- Screenshot subprocess `.output()` has no deadline; a hung PowerShell helper can block heartbeat/shutdown. Pending uploads are synchronous and can delay refreshed authorization. Implement a bounded child lifetime and recheck authorization between uploads/capture before consenting staging validation.
- Capture writes a temporary plaintext JPEG before DPAPI; normal-path cleanup exists, but process/OS termination between save and cleanup can leave plaintext until next queue cleanup. Replace the disk handoff or prove restricted ACL/crash cleanup. Do not claim encrypted-at-all-times screenshots.
- Activity sessions and unacknowledged/quarantined activity have no overall disk quota/retention policy. Queue batches are bounded, total disk growth is not. Product-approved retention/drop/backpressure behavior is needed before destructive pruning changes.
- In-progress activity lives only in memory; forced termination can lose the current interval. Control Center's stop action uses Kill and its “zero data loss” copy overstates guarantees. Actual active-interval crash recovery is blocked pending consent/staging.
- Startup enrollment consumes a server token before local Credential Manager persistence; a local credential-write failure needs a documented recovery procedure and staging failure-injection test.
- Console-close handler only flips a flag, while synchronous I/O can delay cleanup beyond Windows close deadlines. Timed shutdown is verified; console-close/Ctrl+C behavior is not certified.
- Config's loopback prefix validation is weaker than transport's exact host check; transport still rejects remote HTTP/unauthorized remote HTTPS. Consolidate URL validation; no demonstrated credential exfiltration through this mismatch.
- Unsigned agent, floating compiler, legacy local-only installer instructions and no embedded build identity remain release/operations gaps. No signing or deployment policy was changed.

These limitations are documented release blockers, not claimed fixes. Their acceptance needs product decisions, a controlled interactive operator and/or staging; this audit does not weaken consent or modify live data to complete them.

## F. Backend/database and security verification

`backend-tests.log`: **32 passed, 0 failed** across device enrollment/lifecycle, activity, monitoring/privacy authorization, screenshot upload/governance and security regressions. Test doubles are used; this is not PostgreSQL evidence. `dashboard-tests.log`: **11 passed, 0 failed** in three related component files. No browser-extension source was changed by this audit.

Read-only requests to the configured live server `https://screentimer.onrender.com` are in `live-readonly.json`: `/api/v1/health/live` timed out on first request; `/api/v1/health` returned 200 with `database.status=up`; unauthenticated `/api/v1/screen-monitoring/captures` returned 401 UNAUTHORIZED. Health reports connectivity, not correct device/event rows. No live enrollment, credential rotation, revoke/archive, database mutation or screen capture occurred. No TEST_DATABASE_URL is configured; operator confirmed only live server availability. Production DB URLs/secrets were not printed.

Credential Manager and DPAPI are supported protection mechanisms in source; SQLite activity and screenshot metadata are plaintext. Default directory inherits user profile ACLs; custom-path ACL hardening and a different-user access test remain NOT TESTED. TLS validation was not disabled; HTTPS redirects disabled; remote opt-in enforced. Full binary secret/provenance certification and cross-account credential isolation still require release/security review. Never interpret lack of a discovered secret as proof none exists in every historical artifact.

Credential-pattern scan: `secret-pattern-scan.json` inspected 25 Rust files plus the candidate EXE for long DigitalPulse credentials, private-key headers and credential-bearing PostgreSQL URLs; **zero matches**. This bounded pattern scan does not prove absence of all secrets or inspect operator credential stores.

## G. Build verification and reproduction

Final evidence: `fmt-final.log`, `check-final.log`, `clippy-final.log`, `tests-final.log`, `debug-final.log`, `release-final.log`.

| Gate | Result |
|---|---|
| cargo fmt --all -- --check | PASS |
| cargo check --workspace --locked | PASS |
| cargo clippy --workspace --all-targets --locked -- -D warnings | PASS |
| cargo test --workspace --locked with local protocol tests enabled | 46 PASS, 0 FAIL; 1 live idle-input test deliberately filtered pending operator consent |
| cargo build --workspace --locked | PASS debug |
| cargo build --workspace --release --locked | PASS release |
| Packaging script parse | PASS; no artifact publication executed |

Clippy was missing and installed with tool approval. **cargo-audit 0.22.2 passed:** 80 locked dependencies, 1,422 RustSec advisories, zero matching known vulnerabilities and no warnings. Advisory database commit `309392b18f6b17022f82c701f300433126901068` (2026-11-06); see `cargo-audit.json` and `dependency-audit-status.md`. This does not certify unknown vulnerabilities or JavaScript/system dependencies. The subsequently installed tooling EXE is separately recorded in `audit-tool-inventory.json` and is not shipped.

Reproduce from `desktop-agent` with `CARGO_TARGET_DIR` set to the audit `target` directory. Set RUN_INTEGRATION_TESTS=1 for Rust local HTTP tests; run tests with `-- --skip get_system_idle_does_not_panic`. Execute `python scripts/audit-windows-runtime.py` from repository root for collection-denied fixture tests, and `python scripts/audit-windows-stability.py` for the offline smoke. Each runtime rerun writes a new directory. Do not use actual device credentials for these harnesses. `scripts/audit-windows-inventory.py` and `scripts/audit-windows-pe.ps1` inspect PE/ZIP metadata without launching discovered tools. Audit helpers are development evidence, not shipped agent dependencies.

## H–I. Deployment decision and next actions

**NOT READY**. Final automated test totals: **109 PASS, 0 FAIL** (46 Rust + 32 backend + 11 dashboard + 20 EXE protocol/startup scenarios), plus the separately recorded two-minute smoke and build gates. One live idle test filtered. Mandatory real acceptance: 2 PASS / 0 observed FAIL / 14 NOT TESTED, with additional security/platform checks noted above. These categories must not be conflated.

1. Provide an isolated migrated PostgreSQL backend, private screenshot store and test employee/admin identities; verify deployed lifecycle migration/schema matches this source.
2. Obtain explicit operator consent and approved applications/screens; validate the real EXE → authenticated backend → actual DB/object rows → dashboard chain, including all token/device lifecycle transitions and unauthorized cross-tenant cases.
3. Repair remaining screenshot child-timeout/crash-plaintext and queue-retention/shutdown gaps, then run controlled crash, lock, sleep, network/DNS/timeout and backend-restart tests.
4. Complete advisory/security review, clean-machine supported-OS tests and an extended active/idle soak; sign/version the candidate and align employee HTTPS instructions.
5. Only after all mandatory gates pass, approve packaging/public artifact replacement. No release publication was performed here.
