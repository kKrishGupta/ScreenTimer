# DigitalPulse Enterprise — Architecture Specification
## Endpoint Activity Intelligence & Access Governance Platform

DigitalPulse Enterprise provides continuous endpoint visibility, application and website usage analytics, access governance, and digital wellbeing safeguards across company-managed Windows 11 endpoints.

---

## 1. Architectural Layers

### Layer A — Endpoint Layer
Installed on authorized, corporate-managed Windows computers.

1. **Rust Desktop Agent (`dp-user-agent` / `dp-service`)**:
   - Native Win32 foreground window and active application detection via `GetForegroundWindow` and `GetWindowThreadProcessId`.
   - Windows idle detection via `GetLastInputInfo`.
   - Non-overlapping activity interval engine: application sessions are bounded and never double-counted against system idle time.
   - Transient focus flicker suppression (intervals < 500 ms discarded).
   - Local durability: Offline event buffer stored in local SQLite (`wal` mode).
   - Local synchronization engine: Batches up to 50 events every 30 seconds to the control plane.
   - Authenticated ingestion with device tokens.

2. **Chrome & Edge Manifest V3 Browser Extension**:
   - Privacy-conscious domain-level tracking: Captures domain names only; form data, query parameters, search inputs, and page contents are strictly omitted.
   - Native policy enforcement via Manifest V3 `declarativeNetRequest` rules.
   - Synchronizes browsing sessions with local buffer and backend ingestion endpoint.

### Layer B — Centralized Control Plane & Data Pipeline
- **Fastify Backend Server (Node.js)**:
  - High-throughput asynchronous REST API and real-time streaming routes.
  - Device enrollment token lifecycle and heartbeat monitoring.
  - Idempotent ingest pipeline: deduplicates replayed events based on `(deviceId, eventId)`.
  - Native pixel capture engine using .NET `CopyFromScreen` (capturing actual screen pixels, never placeholder SVGs).
  - Centralized Access Governance and Grace Period state machine.
- **PostgreSQL 18 Database with Prisma ORM**:
  - Normalized schema: `Organization`, `Site`, `Department`, `User`, `Device`, `Application`, `Website`, `ActivitySession`, `GraceGrant`, `ScreenCaptureMetadata`, `AuditLog`.
  - Multi-tenant enterprise boundaries enforced on every query via `organizationId`.

### Layer C — Governance & Analytics Web Dashboard
- **React 19 + Vite + Tailwind CSS**:
  - Executive Overview: Real active vs. idle hours, top applications, top websites, backend health.
  - Activity Timeline: Chronological session feed with exact timestamps, application/process details, and durations.
  - Application Analytics: Ranked distribution of active foreground applications.
  - Website Usage: Domain-level corporate browsing analytics.
  - Device Monitoring: Collector health, platform, version, online status, and revocation controls.
  - Access Governance: 15-minute grace period state machine, policy simulation, and MV3 dynamic rule export.
  - Screen Intelligence: Actual screen pixel captures, privacy consent gating, and live view tokens.

---

## 2. Multi-Tenant Organization & RBAC Model

| Role | Scope | Capabilities |
| :--- | :--- | :--- |
| `SUPER_ADMIN` | Platform-wide | Organization provisioning, system health, global audits |
| `ORG_ADMIN` | Organization | Device enrollment, policy configuration, grace resets, employee assignment |
| `MANAGER` | Department | Department analytics, wellbeing reports, approval workflows |
| `EMPLOYEE` | Individual | Personal activity review, wellbeing break notifications, privacy charter |

---

## 3. Technology Matrix

- **Desktop Agent**: Rust 2021, `windows-sys` 0.59, `rusqlite` 0.31, `tokio` 1.43, `reqwest` 0.12.
- **Extension**: Chromium Manifest V3, WebExtensions APIs (`tabs`, `webNavigation`, `idle`, `storage`, `declarativeNetRequest`).
- **Backend**: Node.js 24, Fastify 5.2, Prisma 7.10, PostgreSQL 18.
- **Frontend**: React 19, Vite 8.3, Tailwind CSS 4.

