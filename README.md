# DigitalPulse — Family Edition (Stage 2 Production-Hardened MVP)

DigitalPulse is a high-performance, transparent, consent-based digital activity monitoring, digital wellbeing, and family governance platform architected specifically for **Windows 11**.

Stage 2 elevates the verified Stage 1 foundation into an enterprise-hardened local platform featuring cryptographic authentication (scrypt), role-based access control (Family Owner, Adult Member, Supervised Member), secure one-time device enrollment tokens, advanced policy precedence & schedule enforcement, unified notification management with cooldown deduplication, weekly wellbeing analytics, storage-governed screen monitoring with single-viewer locks, sliding-window rate limiting, and self-service privacy deletion workflows.

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
       |  - SQLite Buffer   |                        | - Declarative Net  |
       +---------+----------+                        +---------+----------+
                 |                                             |
                 +----------------------+----------------------+
                                        | Authenticated Batch Sync
                                        v
                      +-----------------------------------+
                      |      Fastify Backend (Node.js)    |
                      |      http://127.0.0.1:3001        |
                      |   - Salted scrypt Authentication  |
                      |   - Family RBAC & Rate Limiting   |
                      |   - One-Time Device Enrollment    |
                      |   - Precedence Policy Engine      |
                      |   - Unified Alert Deduplication   |
                      |   - Quota-Governed Screen Share   |
                      |   - Daily & Weekly Analytics Hub  |
                      +-----------------+-----------------+
                                        | Prisma ORM
                                        v
                      +-----------------------------------+
                      |    PostgreSQL Database (Local)    |
                      |      127.0.0.1:5433 (port 5433)   |
                      +-----------------+-----------------+
                                        | REST Queries / JSON
                                        v
                      +-----------------------------------+
                      |     React + Vite Dashboard        |
                      |      http://localhost:5173        |
                      |   - Overview & Family Members     |
                      |   - Enrolled Device Management    |
                      |   - Activity Timeline & Breakdown |
                      |   - Governed Screen Monitoring    |
                      |   - Time Planner & Wellbeing      |
                      |   - Family Policy Configuration   |
                      |   - Unified Notification Center   |
                      |   - Privacy Charter & Data Export |
                      +-----------------------------------+
```

---

## 2. Stage 2 Milestone Completion Summary

| Milestone | Status | Build | Tests | Notes & Capabilities |
|---|:---:|:---:|:---:|---|
| **1. Architecture Audit & Baseline** | **VERIFIED** | Pass | 12 / 12 Pass | Repository audit, baseline verification, threat modeling (`STAGE_2_AUDIT.md`, `THREAT_MODEL.md`). |
| **2. Authentication & Family RBAC** | **VERIFIED** | Pass | 5 / 5 Pass | Salted scrypt hashing, login rate-limiting lockout, session tokens, Family Owner / Adult / Supervised roles. |
| **3. Device Enrollment & Identity** | **VERIFIED** | Pass | 2 / 2 Pass | One-time enrollment tokens, device HMAC secret issuance, heartbeat telemetry, remote revocation. |
| **4. Advanced Policy Engine** | **VERIFIED** | Pass | 1 / 1 Pass | Precedence resolution (temporary approvals > member rules > household rules), schedules, declarative rules export. |
| **5. Notification & Alert Hub** | **VERIFIED** | Pass | 1 / 1 Pass | Unified alert center, severity tiers, cooldown deduplication, read/unread state management. |
| **6. Advanced Wellbeing Analytics** | **VERIFIED** | Pass | 1 / 1 Pass | Daily & weekly trend analysis, week-over-week deltas, custom category mapping, RFC-4180 CSV export. |
| **7. Screen Monitoring Governance** | **VERIFIED** | Pass | 1 / 1 Pass | High-frequency capture storage warning, storage quota pruning, tokenized single-viewer live screen locks. |
| **8. Reliability & Rate Limiting** | **VERIFIED** | Pass | 1 / 1 Pass | Sliding-window IP rate limiting, bounded queues, memory safeguards, health check bypass. |
| **9. Security & Privacy Controls** | **VERIFIED** | Pass | 1 / 1 Pass | Privacy disclosure charter, confirmed self-service data deletion, audit logging. |
| **10. Release Readiness & Final QA** | **VERIFIED** | Pass | **112 / 112 Pass** | Release Rust binary (`dp-user-agent.exe`), production Vite build, Windows one-click startup script. |

---

## 3. Comprehensive Test Results

```text
========================================================================================
Test Suite                                  Framework            Tests Passed   Status
========================================================================================
1. shared/contracts                         Node Test Runner      12 / 12       PASS
2. apps/browser-extension                   Node Test Runner       5 / 5        PASS
3. backend (API, Auth, Screen, Policies)    Node Test Runner      51 / 51       PASS
4. apps/dashboard                           Vitest                15 / 15       PASS
5. desktop-agent (All 5 Crates)             Cargo Test            29 / 29       PASS
----------------------------------------------------------------------------------------
Total Automated Verification:                                    112 / 112 PASS (100%)
========================================================================================
```

---

## 4. How to Run DigitalPulse Stage 2

Install dependencies from the repository root before starting either server:

```powershell
cd D:\desktop\task2_updated\DigitalPulse
npm install
```

The project uses one root lockfile for all npm workspaces. Running `npm install`
inside `apps` also installs the workspace dependencies. Vite is pinned to 7.3.7
for the dashboard and its plugins so they resolve the same build tool.

To start the dashboard from `apps`:

```powershell
cd D:\desktop\task2_updated\DigitalPulse\apps
npm start
```

### Option A: One-Click Startup (PowerShell)
```powershell
cd D:\desktop\task2\DigitalPulse
.\scripts\start-all.ps1
```

### Option B: Individual Terminal Startup

#### Terminal 1 — Fastify Backend Server
```powershell
cd D:\desktop\task2\DigitalPulse
npm run dev:backend
```
> Running on `http://127.0.0.1:3001` with PostgreSQL connection on port 5433.

#### Terminal 2 — React Dashboard
```powershell
cd D:\desktop\task2\DigitalPulse
npm run dev
```
> Open in your browser: **[http://localhost:5173](http://localhost:5173)**.

#### Terminal 3 — Rust Windows Desktop Agent
```powershell
cd D:\desktop\task2\DigitalPulse\desktop-agent
.\target\release\dp-user-agent.exe
```

---

## 5. Security & Privacy Guarantees
- **No Keystroke Logging**: Zero keyboard hooks exist in the codebase.
- **No Clipboard Snooping**: Clipboard contents are never accessed.
- **Domain-Only Tracking**: Strips all search queries, parameters, and form data.
- **Strict Loopback Binding**: All servers reject non-localhost network bindings.
- **Audited Access**: Every administrative action, screen view, and policy change generates an immutable `AuditLog` entry.
