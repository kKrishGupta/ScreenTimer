# DigitalPulse — Product Requirements Document (PRD)

## 1. Executive Summary
DigitalPulse is a lightweight, privacy-focused digital activity monitoring and productivity platform designed for Windows 11. It provides local visibility into application usage, website engagement (via Google Chrome and Microsoft Edge), and system idle time, aggregated and visualized through a local React dashboard.

## 2. Core Philosophy
**Better. Faster. Easier. Safer. Cheaper.**
- **Negligible Resource Footprint**: The background user agent operates with <= 15 MB RAM and <= 1% average CPU.
- **Privacy by Design**:
  - No keylogging.
  - No screen captures or screenshots.
  - No clipboard inspection.
  - No web form or page body parsing.
  - Domain-level tracking only (no search queries, URL parameters, or url fragments).
- **Zero Cloud Dependency**: Operates 100% locally on localhost.

## 3. Product Roadmap & Phasing
- **Stage 1 (Current Focus)**: Local MVP development. Complete local architecture including Rust user-session agent, Windows service scaffold, SQLite local buffer, Chrome/Edge MV3 extension, Fastify + Prisma + PostgreSQL backend, and React dashboard.
- **Stage 2**: System hardening, multi-device management, policies, notifications, and analytics.
- **Stage 3**: Cloud infrastructure deployment.

## 4. Key Functional Requirements (Stage 1)
1. **Foreground Application Detection**: Identify currently focused window, executable name, path, and PID without scraping window contents.
2. **Idle Detection**: Track keyboard/mouse idle time via Win32 `GetLastInputInfo` with a 60-second threshold.
3. **Browser Domain Tracking**: Chrome and Edge Manifest V3 extension tracking active tab domains and browser focus transitions.
4. **Activity Session Accounting**: Calculate start, end, and duration for uninterrupted app/web/idle periods.
5. **Local Persistence**: Durable SQLite buffer in the agent for offline operation; PostgreSQL for centralized local queries.
6. **Backend Ingestion**: REST APIs accepting batched, schema-validated events with idempotency guarantees.
7. **Dashboard Visualization**: Clean dark-themed React UI displaying real metrics, timelines, and application/domain breakdowns.

