# DigitalPulse — Development & Operations Guide

## 1. System Requirements & Toolchain Configuration
- **Operating System**: Windows 11
- **Node.js**: v20+ or v24+
- **Rust Toolchain**: `stable-x86_64-pc-windows-gnu`
  - GCC Linker: MSYS2 UCRT64 GCC (`D:\Program Files\msys64\ucrt64\bin\gcc.exe`)
- **PostgreSQL**: PostgreSQL 18 running on port 5433

### Setting the PATH for Rust Compilation on Windows:
In every PowerShell session where Rust is invoked:
```powershell
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
```

---

## 2. Step-by-Step Setup

### 2.1 Database Setup
Run the automated database configuration script from the repository root:
```powershell
cd d:\desktop\task2\DigitalPulse
.\scripts\setup-database.ps1
```
This script ensures:
- Role `digitalpulse` is created with password `dev_password_pulse_2026`.
- Database `digitalpulse` exists.
- The `uuid-ossp` extension is enabled.

Verify `backend/.env` contains:
```env
DATABASE_URL="postgresql://digitalpulse:dev_password_pulse_2026@127.0.0.1:5433/digitalpulse?schema=public"
PORT=3001
HOST=127.0.0.1
LOG_LEVEL=info
NODE_ENV=development
```

### 2.2 Migrations and Seeds
```powershell
npm run db:deploy
npm run db:seed
```

---

## 3. Running the Applications

### 3.1 Start the Fastify Backend
```powershell
npm run dev:backend
```
Health endpoint is available at:
`http://127.0.0.1:3001/api/v1/health`

### 3.2 Start the React Dashboard
```powershell
npm run dev:dashboard
```
Dashboard is available at:
`http://localhost:5173`

### 3.3 Running the Desktop Agent
```powershell
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
cd desktop-agent
cargo run --bin dp-user-agent
```
CLI options:
- `--oneshot`: Prints current foreground process, system idle duration, and RAM metrics, then exits immediately.
- `--sync-now`: Immediately flushes all pending events in `agent_storage.db` to the local backend.
- `--run-duration <seconds>`: Runs the monitoring loop for a fixed number of seconds before terminating.

### 3.4 Loading the Browser Extension
1. Open Google Chrome or Microsoft Edge.
2. Go to `chrome://extensions` or `edge://extensions`.
3. Toggle on **Developer mode**.
4. Click **Load unpacked** and choose `DigitalPulse\apps\browser-extension`.
5. The extension will automatically register and monitor active browser domains.

---

## 4. Verification and Automated Testing

Run the full automated test suite across all subsystems:

```powershell
# Shared JSON Schema contracts
npm run test:contracts

# Browser Extension unit tests
npm run test:extension

# Backend Fastify API tests
npm run test:backend

# React Dashboard Vitest tests
npm run test:dashboard

# Pure Rust Agent & Storage test suite
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
cd desktop-agent
cargo test --workspace
```
