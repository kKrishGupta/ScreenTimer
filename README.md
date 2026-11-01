# DigitalPulse — Stage 1 Local MVP

DigitalPulse is a high-performance, privacy-focused digital activity monitoring and productivity platform architected specifically for **Windows 11**.

It monitors authorized foreground computer activity, tracks application and browser website usage, computes precise continuous usage intervals without double-counting idle time, durably buffers events in SQLite, synchronizes with a local PostgreSQL backend via REST APIs, and visualizes real-time metrics through a responsive React dashboard.

---

## Architecture Overview

```
                      +-----------------------------------+
                      |            Windows 11             |
                      +-----------------+-----------------+
                                        |
                 +----------------------+----------------------+
                 |                                             |
                 v                                             v
       +--------------------+                        +--------------------+
       |   Desktop Agent    |                        | Browser Extension  |
       |  (Pure Rust Win32) |                        | (Manifest V3 MV3)  |
       |  - Foreground App  |                        | - Chrome & Edge    |
       |  - Idle Detection  |                        | - FQDN Domain only |
       |  - SQLite Buffer   |                        | - Privacy Stripped |
       +---------+----------+                        +---------+----------+
                 |                                             |
                 +----------------------+----------------------+
                                        | POST /api/v1/activity/events/batch
                                        v
                      +-----------------------------------+
                      |      Fastify Backend (Node.js)    |
                      |      http://127.0.0.1:3001        |
                      |   - Device Auto-Registration      |
                      |   - Idempotent Deduplication      |
                      |   - JSON Schema Contract Guard    |
                      +-----------------+-----------------+
                                        | Prisma ORM
                                        v
                      +-----------------------------------+
                      |    PostgreSQL Database (Local)    |
                      |      127.0.0.1:5433 (port 5433)   |
                      +-----------------+-----------------+
                                        | REST Queries
                                        v
                      +-----------------------------------+
                      |     React + Vite Dashboard        |
                      |      http://localhost:5173        |
                      |   - System Health Indicator       |
                      |   - Activity Summary Metrics      |
                      |   - Chronological Timeline        |
                      |   - Application & Domain Tables   |
                      +-----------------------------------+
```

---

## Key Technical Specifications & Verification

| Component | Technology | Performance & Verification |
|---|---|---|
| **Desktop Agent** | Pure Rust (`windows-sys`, `rusqlite`) | Working Set **6.54 MB** (target $\le$ 15 MB) &bull; CPU **0.26%** (target $\le$ 1.0%) |
| **Local Storage** | SQLite (`rusqlite` bundled) | Offline queue, transaction safety, automatic 7-day pruning |
| **Browser Extension**| Manifest V3 JavaScript | Zero query/hash tracking (domain-only), Edge & Chrome auto-detection |
| **Backend** | Fastify + Prisma + PostgreSQL 18 | Schema-validated batch ingestion, idempotent event deduplication |
| **Frontend** | React 19 + Vite + Tailwind CSS | Auto-refreshing metrics, zero mock data, clear empty states |

---

## Quick Start Guide

### 1. Prerequisites
- **Windows 11**
- **Node.js** v20+ or v24+
- **Rust** `stable-x86_64-pc-windows-gnu` (uses MSYS2 GCC at `D:\Program Files\msys64\ucrt64\bin`)
- **PostgreSQL 18** (running locally on port 5433)

### 2. Configure Environment & Database
```powershell
cd d:\desktop\task2\DigitalPulse
# Database role & schema setup
.\scripts\setup-database.ps1

# Prisma migration & seed
npm run db:deploy
npm run db:seed
```

### 3. Run the Backend & Dashboard
```powershell
# In Terminal 1 (Backend - port 3001):
npm run dev:backend

# In Terminal 2 (Dashboard - port 5173):
npm run dev:dashboard
```

### 4. Run the Desktop Agent
```powershell
# In Terminal 3 (Agent):
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
cd desktop-agent
cargo run --release --bin dp-user-agent
```
To run a one-shot activity query without entering daemon mode:
```powershell
cargo run --bin dp-user-agent -- --oneshot
```
To force an immediate synchronization of pending SQLite events to the backend:
```powershell
cargo run --bin dp-user-agent -- --sync-now
```

### 5. Load the Browser Extension
1. Open Google Chrome or Microsoft Edge.
2. Navigate to `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select `d:\desktop\task2\DigitalPulse\apps\browser-extension`.

---

## Running the Automated Test Suite

Every component includes automated test coverage that verifies compliance with our contracts:

```powershell
# 1. JSON Schema contracts & fixture validation (12 tests)
npm run test:contracts

# 2. Browser extension domain normalization & session tracker (5 tests)
npm run test:extension

# 3. Backend Fastify ingestion, validation, and analytics routes (13 tests)
npm run test:backend

# 4. React dashboard rendering, error handling, and routing (8 tests)
npm run test:dashboard

# 5. Rust desktop agent, Win32 idle tracker, session accounting, and storage (29 tests)
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
cd desktop-agent
cargo test --workspace
```
