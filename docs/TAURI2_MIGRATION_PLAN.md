# DigitalPulse Tauri 2 migration plan

## Safety baseline

- Preserve `%LOCALAPPDATA%\DigitalPulse\agent_storage.db`, the queue directory,
  DPAPI credentials, and stable device identity in place.
- Keep collection authorization in `dp-user-agent`; the desktop UI may request a
  start but cannot grant consent, administrator approval, or schedule access.
- Pass passwords, session cookies, and enrollment keys only through process
  memory or redirected standard input. Never place them in arguments or logs.
- Do not deploy or exercise production monitoring as part of the build.

## Phases

1. Add a Tauri 2 application with a bundled React/TypeScript frontend, native
   tray, close-to-tray behavior, and restricted Rust commands.
2. Reuse the existing agent enrollment, protected credential store, offline
   SQLite queue, screenshot policy, synchronization, and authenticated named
   pipe controls.
3. Replace the WinForms publish step in the reviewed WiX 5 per-user installer
   pipeline. Keep upgrade codes and data-preserving uninstall behavior stable.
4. Add unit tests for error-code mapping, status parsing, and frontend state;
   run Rust, backend, dashboard, desktop frontend, installer, install/uninstall,
   shortcut, and launch smoke tests available on this Windows host.
5. Record clean-machine, signed-build, production-auth, schedule, revocation,
   sleep/wake, restart, and deployed-download checks as unverified until they
   are actually executed in authorized environments.

## Rollback

The migration does not alter the database schema or credential names. A failed
upgrade can uninstall the UI and install the prior package without deleting the
state under `%LOCALAPPDATA%\DigitalPulse`. Do not remove or overwrite that state
during rollback.
