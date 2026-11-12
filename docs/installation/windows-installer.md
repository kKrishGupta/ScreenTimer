# DigitalPulse for Windows

Employees download `DigitalPulse-Setup.exe` from the portal and complete the standard WiX setup wizard. The per-user MSI places the self-contained Control Center and managed Rust agent under `%LOCALAPPDATA%\Programs\DigitalPulse`, creates Start Menu/Desktop shortcuts, and registers a Windows uninstall entry.

On first launch, the employee signs in with email, password, and Employee Secret Key. Later launches use email/password sign-in against the existing enrolled device. Credentials are passed to the agent through redirected standard input and are never placed in process arguments.

The application does not start monitoring during installation. Agent start remains an explicit Control Center action, and backend consent, administrator authorization, account, organization timezone, and work-schedule gates remain authoritative.

Upgrade and uninstall replace/remove application binaries only. They never remove `%LOCALAPPDATA%\DigitalPulse`, Windows Credential Manager device secrets, the SQLite queue, or device identity. Close Control Center and stop the agent before an upgrade or uninstall.

Build on Windows with `npm run build:installer`. A production artifact should be Authenticode-signed; use `scripts/build-windows-installer.ps1 -RequireSignature` in the signing release job. Verify with `npm run verify:windows-installer`.
