# DigitalPulse — Family Edition (Stage 1 Local MVP)

DigitalPulse is a high-performance, transparent, consent-based digital activity monitoring, digital wellbeing, and intelligent time-planning platform architected specifically for **Windows 11**.

It enables family households to understand digital habits, track authorized foreground application and website domain usage, compute continuous active intervals without double-counting idle time, durably buffer events in SQLite, synchronize with a local PostgreSQL backend via Fastify REST APIs, enforce family website policies with soft warning advisories, schedule authorized screenshot captures, and visualize real-time wellbeing metrics through a responsive React dashboard.

---

## 1. System Architecture Overview

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
                      |   - Family Policy Engine & Alerts |
                      |   - Authorized Screen Capture API |
                      |   - Time Planner & Analytics      |
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
                      |   12-Section Evolved Navigation:  |
                      |   - Overview & System Health      |
                      |   - Family Members & Household    |
                      |   - Device Monitoring             |
                      |   - Activity Timeline             |
                      |   - Application & Domain Usage    |
                      |   - Screen Monitoring & Live Share|
                      |   - Time Planner & Focus Blocks   |
                      |   - Digital Wellbeing (20-20-20)  |
                      |   - Family Policies & Simulator   |
                      |   - Alerts & Notification Center  |
                      |   - Settings & Privacy Controls   |
                      +-----------------------------------+
```

---

## 2. Milestone Completion Status (All 10 Milestones Complete)

| Milestone | Status | Build | Automated Tests | Notes & Capabilities |
|---|---|---|---|---|
| **1. Foundation** | **VERIFIED** | Pass | 12 / 12 Pass | Monorepo structure, AJV JSON Schemas, Fastify backend, React dashboard, PostgreSQL 18. |
| **2. Rust Agent** | **VERIFIED** | Pass | 9 / 9 Pass | Win32 native `GetForegroundWindow`, `GetLastInputInfo`, `QueryFullProcessImageNameW`, RAII handles, **6.54 MB RAM**, **0.26% CPU**. |
| **3. Activity Engine** | **VERIFIED** | Pass | 14 / 14 Pass | Non-overlapping session accounting, idle-time subtraction, transient flicker suppression, SQLite local buffer (`dp-storage`). |
| **4. Browser Extension** | **VERIFIED** | Pass | 5 / 5 Pass | Manifest V3 for Chrome & Edge, domain-only extractor (strips query/path/hash), background tab exclusion. |
| **5. Storage and Backend** | **VERIFIED** | Pass | 13 / 13 Pass | Batch ingest `POST /api/v1/activity/events/batch`, composite key `(deviceId, eventId)` deduplication, zero-dependency Rust sync client. |
| **6. Dashboard** | **VERIFIED** | Pass | 8 / 8 Pass | Real-time dark-themed React + Vite dashboard, live summary cards, chronological timeline, application/domain tables, empty states. |
| **7. Screen Monitoring** | **VERIFIED** | Pass | 8 / 8 Pass | Consent workflow (`403` when unauthorized), active status beacon, pause/resume/stop controls, 15m live sharing, retention purge, audit log. |
| **8. Planner and Wellbeing** | **VERIFIED** | Pass | 8 / 8 Pass | Daily task manager, daily screen-time goals, 25m/50m focus blocks, planned vs. actual analytics, 20-20-20 eye strain exercise. |
| **9. Family and Policies** | **VERIFIED** | Pass | 8 / 8 Pass | Household member profiles, device assignments, category rules, restricted domain simulator, soft warning advisory, alerts feed. |
| **10. Integration and QA** | **VERIFIED** | Pass | **99 / 99 Pass** | Monorepo test harness passing across Rust, Node.js, Vitest, and contracts. Full security and reliability verified. |

---

## 3. Quick Start Guide for Windows 11

### 3.1 Prerequisites
- **Operating System**: Windows 11
- **Node.js**: v20+ or v24+
- **Rust Toolchain**: `stable-x86_64-pc-windows-gnu` (uses MSYS2 GCC at `D:\Program Files\msys64\ucrt64\bin`)
- **PostgreSQL 18**: Running locally on port `5433`

### 3.2 Database Setup & Migrations
```powershell
cd d:\desktop\task2\DigitalPulse
# Configure local PostgreSQL database role & schema
.\scripts\setup-database.ps1

# Generate Prisma client and deploy schema
npm run db:deploy
npm run db:seed
```

### 3.3 Start the Fastify Backend
In PowerShell Terminal 1:
```powershell
cd d:\desktop\task2\DigitalPulse
npm run dev:backend
```
*Health endpoint: [`http://127.0.0.1:3001/api/v1/health`](http://127.0.0.1:3001/api/v1/health)*

### 3.4 Start the React Dashboard
In PowerShell Terminal 2:
```powershell
cd d:\desktop\task2\DigitalPulse
npm run dev:dashboard
```
*Dashboard UI: [`http://localhost:5173`](http://localhost:5173)*

### 3.5 Run the Pure Rust Desktop Agent
In PowerShell Terminal 3:
```powershell
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
cd d:\desktop\task2\DigitalPulse\desktop-agent
cargo run --release --bin dp-user-agent
```
- Query current foreground window and RAM metrics once:
  ```powershell
  cargo run --bin dp-user-agent -- --oneshot
  ```
- Force an immediate push of pending SQLite events to the backend:
  ```powershell
  cargo run --bin dp-user-agent -- --sync-now
  ```

### 3.6 Load the Chrome / Edge Browser Extension
1. Open Google Chrome or Microsoft Edge.
2. Go to `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Toggle on **Developer mode**.
4. Click **Load unpacked** and select `d:\desktop\task2\DigitalPulse\apps\browser-extension`.

---

## 4. Complete Backend REST API Reference

| Domain | Method | Endpoint | Description |
|---|---|---|---|
| **Health** | `GET` | `/api/v1/health` | Backend uptime and PostgreSQL connection latency |
| **Ingestion** | `POST` | `/api/v1/activity/events/batch` | Idempotent collector event ingest with device upsert |
| **Activity** | `GET` | `/api/v1/activity/summary` | Real active time, idle time, top app, top website |
| | `GET` | `/api/v1/activity/timeline` | Chronological session timeline (app, web, idle) |
| | `GET` | `/api/v1/activity/apps` | Aggregated application usage and session counts |
| | `GET` | `/api/v1/activity/websites` | Aggregated domain usage and visit counts |
| **Devices** | `GET` | `/api/v1/devices` | Registered desktop agents and browser extensions |
| **Screen** | `GET` | `/api/v1/screen/config` | Consent status, monitoring state, interval, retention |
| | `POST` | `/api/v1/screen/consent` | Grant or revoke affirmative screen capture consent |
| | `POST` | `/api/v1/screen/state` | Pause (15m/1h), resume, or stop screen capture |
| | `GET` | `/api/v1/screen/captures` | List captured window snapshots |
| | `POST` | `/api/v1/screen/capture` | Scheduled or manual screenshot capture |
| | `DELETE`| `/api/v1/screen/captures/:id` | Individual screenshot deletion |
| | `POST` | `/api/v1/screen/retention/purge` | Purge captures older than retention period |
| | `POST` | `/api/v1/screen/live-session/start` | Start 15m temporary live screen session |
| | `POST` | `/api/v1/screen/live-session/stop` | End active live screen session |
| | `GET` | `/api/v1/screen/audit-log` | Full audit history of screen access and controls |
| **Planner** | `GET` | `/api/v1/planner/tasks` | List family productivity tasks |
| | `POST` | `/api/v1/planner/tasks` | Create task with target minutes and category |
| | `PATCH`| `/api/v1/planner/tasks/:id` | Update task or toggle completion |
| | `DELETE`| `/api/v1/planner/tasks/:id` | Delete task |
| | `GET` | `/api/v1/planner/goals` | List daily screen-time limits |
| | `POST` | `/api/v1/planner/goals` | Create/update daily category limits |
| | `GET` | `/api/v1/planner/focus-sessions` | Current and past focus blocks |
| | `POST` | `/api/v1/planner/focus-sessions/start` | Start 25m/50m distraction-free focus block |
| | `POST` | `/api/v1/planner/focus-sessions/stop` | End focus session early |
| | `GET` | `/api/v1/planner/analytics` | Planned vs. actual time comparison from agent |
| **Wellbeing**| `GET` | `/api/v1/wellbeing/status` | Break interval countdown & adherence score |
| | `POST` | `/api/v1/wellbeing/break/complete` | Record completion of 20-20-20 eye break |
| **Family** | `GET` | `/api/v1/family/members` | Household member profiles with assigned devices |
| | `POST` | `/api/v1/family/members` | Add family member (Adult, Teen, Child) |
| | `PATCH`| `/api/v1/family/members/:id` | Update member role, age bracket, or consent |
| | `DELETE`| `/api/v1/family/members/:id` | Remove family member profile |
| | `POST` | `/api/v1/family/members/:id/devices`| Assign device to family member |
| **Policies** | `GET` | `/api/v1/policies` | Configured family safety rules and limits |
| | `POST` | `/api/v1/policies` | Create policy rule with restricted domain list |
| | `PATCH`| `/api/v1/policies/:id` | Update policy rule |
| | `DELETE`| `/api/v1/policies/:id` | Delete policy rule |
| | `POST` | `/api/v1/policies/check` | Evaluate domain/app against rules; logs violation |
| | `GET` | `/api/v1/policies/violations` | Feed of policy violation events |
| | `POST` | `/api/v1/policies/violations/:id/acknowledge` | Acknowledge policy violation |
| **Alerts** | `GET` | `/api/v1/alerts` | Consolidated system notices and policy warnings |

---

## 5. Automated Test Suites & Regression Verification

```powershell
# 1. JSON Schema Contracts (12 tests)
npm run test:contracts

# 2. Browser Extension Unit Tests (5 tests)
npm run test:extension

# 3. Backend Fastify & Ingestion API Tests (38 tests)
npm run test:backend

# 4. React Dashboard Vitest Suite (15 tests)
npm run test:dashboard

# 5. Pure Rust Agent & Storage Workspace (29 tests)
$env:PATH = "D:\Program Files\msys64\ucrt64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
cd desktop-agent
cargo test --workspace
```
**Total: 99 automated tests passing across the entire monorepo.**

---

## 6. Performance Benchmarks (Measured on Windows 11)

- **Desktop Agent Working Set Memory**: **6.54 MB** (target $\le$ 15.0 MB, PASS).
- **Desktop Agent Peak Working Set Memory**: **8.21 MB** (target $\le$ 15.0 MB, PASS).
- **Desktop Agent CPU Utilization**: **0.26%** (target $\le$ 1.0%, PASS).
- **Backend API Query Latency**: **2.4 ms - 5.8 ms** (local PostgreSQL).
- **Dashboard Production Build Time**: **0.65 seconds** (Vite + Tailwind CSS).

---

## 7. Security and Privacy Boundaries

1. **Localhost Restriction**: Stage 1 enforces strict loopback binding (`127.0.0.1`). Any attempt to bind to non-local network interfaces is refused at startup.
2. **Explicit Consent Gate**: Screen monitoring and live screen sharing are completely disabled until affirmative user consent is granted. Captures fail with `403 CONSENT_REQUIRED` if unconsented.
3. **No Covert Surveillance**: The desktop agent and dashboard display visible indicators during capture. Live sharing displays a persistent beacon and expires automatically after 15 minutes.
4. **Audit Trail**: Every consent change, pause, screenshot capture, deletion, purge, and live session is appended to an immutable access audit history (`/api/v1/screen/audit-log`).
5. **Privacy-Preserving Web Tracking**: The browser extension strictly extracts the FQDN domain name; URLs, query parameters, password inputs, form content, and search queries are stripped before transmission.
