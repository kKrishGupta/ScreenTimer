# DigitalPulse Tauri 2 verification report

Date: 2026-11-13 (Asia/Calcutta)

## Release artifact

- Path: `apps/dashboard/public/downloads/DigitalPulse-Setup.exe`
- Version: 0.2.0 (major-upgrade path from the prior 0.1.0 package)
- Size: 4,662,674 bytes (4.45 MiB)
- SHA-256: `88783cca5da263ba8caba462a7e43788354447f588e06273f4ac49ffd8474419`
- Installer: WiX 5 Burn bootstrapper and per-user MSI
- WebView2: official Microsoft Evergreen bootstrapper is embedded and invoked
- Authenticode: **NotSigned**. SmartScreen reputation warnings remain possible.

## Executed checks

| Check | Result | Evidence |
|---|---|---|
| React/TypeScript production build | PASS | TypeScript and Vite production build completed |
| Tauri 2 native build | PASS | Tauri CLI produced the release `DigitalPulse.exe` |
| Desktop frontend tests | PASS | 2/2 |
| Desktop Rust command tests | PASS | 2/2 |
| Rust agent workspace tests | PASS | 67/67 |
| Backend tests | PASS with skips | 182 passed; 4 PostgreSQL integration tests skipped because `TEST_DATABASE_URL` was not configured |
| Dashboard tests | PASS | 89/89 |
| Dashboard production build | PASS | Download artifact and checksum were verified during prebuild |
| Installer generation | PASS | `DigitalPulse-Setup.exe` produced |
| Artifact/source/checksum verification | PASS | release metadata and SHA-256 match current source fingerprints |
| Isolated per-user MSI install | PASS | installed to a temporary isolated target on this Windows host |
| Installed binary smoke launch | PASS | `DigitalPulse.exe --smoke-test` returned success with the agent beside it |
| Uninstall | PASS | MSI uninstall returned success |
| Local-state preservation | PASS | sentinel outside the installer-owned application directory survived install/uninstall |
| Native UI visual launch | PASS | bundled UI rendered from `tauri.localhost`; no development server was used |
| Close X behavior | PASS | window disappeared while the Tauri process remained alive in the tray |
| No console in normal build | PASS | release binary uses the Windows GUI subsystem; child agent starts with `CREATE_NO_WINDOW` |

## Not executed or not fully verified

These items are not marked PASS:

- A genuinely clean Windows 10 and Windows 11 VM installation.
- Graphical Start Menu and Desktop shortcut launches (the shortcuts are authored
  by WiX, but were not clicked in a clean interactive VM).
- Reopening by clicking the notification-area icon; close-to-tray and the tray
  handler were built and close behavior was observed, but tray-icon clicking was
  not automated on this host.
- Login, first enrollment, or existing-device verification against production;
  no authorized isolated employee account was provided.
- Authorized activity or screenshot capture, explicit stop during a real work
  session, consent withdrawal, schedule end, administrator revocation, offline
  queue/reconnect synchronization, sleep/wake, or restart resume. Real monitoring
  and production changes were intentionally not started.
- Upgrade over a prior released installer with real local employee data.
- Website download over deployed Vercel HTTP. The local dashboard build points to
  and verifies the new artifact, but nothing was deployed.
- Authenticode signing and SmartScreen reputation.

## Migration and rollback

The installer owns `%LOCALAPPDATA%\Programs\DigitalPulse`; the agent continues to
own state under `%LOCALAPPDATA%\DigitalPulse`. No database schema, device ID,
DPAPI credential name, queue location, or enrollment record is reset by this
migration. Roll back by uninstalling this UI package and installing the previous
package. Preserve `%LOCALAPPDATA%\DigitalPulse` throughout rollback.

## Deployment readiness

The source, local installer, checksum, dashboard integration, and automated host
checks are ready for a signed release-candidate cycle. Production deployment is
blocked on code signing, clean Windows 10/11 VM validation, authorized test-account
end-to-end checks, and an explicit deployment approval.
