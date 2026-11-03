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
This script provisions the local PostgreSQL role and database. Keep the database password local and use a URL-encoded password in the connection string.

Copy `backend/.env.example` to `backend/.env` and set the canonical `DATABASE_URL`:
```env
DATABASE_URL="postgresql://DB_USER:URL_ENCODED_PASSWORD@127.0.0.1:5433/DB_NAME?schema=public"
PORT=3001
HOST=127.0.0.1
LOG_LEVEL=info
NODE_ENV=development
```

`DATABASE_URL` is the canonical variable used by Prisma 7 and the backend. `DATABASE` remains a compatibility alias when `DATABASE_URL` is absent; if both exist, `DATABASE_URL` wins. The current Prisma config does not use `DIRECT_URL`. For hosted PostgreSQL, preserve TLS by adding `sslmode=require` (or a stricter supported mode) to the URL.

### 2.2 Migrations and Seeds
```powershell
Push-Location backend
npx.cmd prisma validate
npx.cmd prisma generate
npx.cmd prisma migrate status
Pop-Location

npm.cmd run db:deploy --workspace @digitalpulse/backend
npm.cmd run db:seed --workspace @digitalpulse/backend
```

Review pending migrations before applying them. `db:status` is read-only; `db:deploy` applies committed migrations and does not reset tables. Never run `migrate reset` against a configured application database.

The backend health endpoint runs a harmless PostgreSQL `SELECT 1`. After starting the backend, verify it with:
```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/v1/health
```
The response must report `status: ok` and `database.status: up`. Production startup performs this connectivity check before listening and exits with a sanitized error if PostgreSQL is unavailable.

### 2.3 PostgreSQL Integration Tests
Use a dedicated disposable database in `TEST_DATABASE_URL`, separate from both `DATABASE_URL` and legacy `DATABASE`. Never point it at a production or development application database. Set `RUN_INTEGRATION_TESTS=true` only after applying the reviewed migrations to that isolated test database:
```powershell
$env:TEST_DATABASE_URL = 'postgresql://TEST_USER:URL_ENCODED_PASSWORD@TEST_HOST:5432/DB_TEST?sslmode=require'
$env:RUN_INTEGRATION_TESTS = 'true'
npm.cmd test --workspace @digitalpulse/backend
```
The PostgreSQL integration suites refuse to run when the test URL resolves to the application database. They remain skipped when `TEST_DATABASE_URL` is not configured.

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
5. Sign in to Employee Setup, review the monitoring disclosure, and generate a one-time Browser extension token for this installation. Paste it in the extension popup. Enrollment alone does not authorize monitoring; the server must also verify consent, administrator approval, account status, time zone, and schedule.

The independent Windows, Chrome and Edge download packages, exact installation instructions, rebuild commands, checksums and verified test results are documented in [EMPLOYEE_INSTALLATION_PACKAGING.md](./EMPLOYEE_INSTALLATION_PACKAGING.md). These are local/internal test builds; localhost works only on the backend's computer.

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
