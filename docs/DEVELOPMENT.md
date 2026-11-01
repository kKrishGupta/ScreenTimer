# DigitalPulse — Development & Operations Guide

## 1. Prerequisites
- **OS**: Windows 11
- **Node.js**: v20+ or v24+
- **Rust**: 1.80+ (stable)
- **PostgreSQL**: 17 or 18 (Localhost, port 5433 or 5432)

## 2. Initial Setup

### 2.1 Database Configuration
If PostgreSQL 18 is running on port 5433:
```powershell
# In PowerShell:
d:\desktop\task2\DigitalPulse\scripts\setup-database.ps1
```
Configure `DigitalPulse\backend\.env`:
```env
DATABASE_URL=postgresql://digitalpulse:dev_password_pulse_2026@127.0.0.1:5433/digitalpulse?schema=public
```

### 2.2 Installing Dependencies & Running Migrations
```powershell
cd d:\desktop\task2\DigitalPulse
npm install
npm run db:generate
npm run db:deploy
npm run db:seed
```

### 2.3 Running the Backend
```powershell
npm run dev:backend
# API available at http://127.0.0.1:3001/api/v1/health
```

### 2.4 Running the Dashboard
```powershell
npm run dev:dashboard
# Dashboard available at http://localhost:5173
```

### 2.5 Building and Running the Desktop Agent
```powershell
cd desktop-agent
cargo check --workspace
cargo test --workspace
cargo run --bin dp-user-agent
```

### 2.6 Loading the Browser Extension
1. Open Google Chrome or Microsoft Edge.
2. Navigate to `chrome://extensions` or `edge://extensions`.
3. Enable "Developer mode" (toggle in top right or sidebar).
4. Click "Load unpacked" and select `DigitalPulse\apps\browser-extension`.

