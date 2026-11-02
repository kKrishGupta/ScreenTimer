# DigitalPulse — Stage 2 Architecture Specification

## 1. System Overview

DigitalPulse is a Windows-first, privacy-conscious digital activity monitoring, digital wellbeing, and family governance platform.

```mermaid
graph TD
    subgraph WindowsClient["Windows 11 Monitored Client"]
        Agent["Rust Native Agent (dp-user-agent)"]
        Win32["Win32 APIs (GetForegroundWindow, GetLastInputInfo)"]
        SQLite[("Local SQLite Buffer (agent_storage.db)")]
        Ext["Chrome / Edge MV3 Extension"]
        Agent --> Win32
        Agent --> SQLite
    end

    subgraph BackendLayer["Local Backend Core (Node.js & Fastify)"]
        API["Fastify HTTP Server (127.0.0.1:3001)"]
        AuthMod["Auth & RBAC Module (scrypt / tokens)"]
        EnrollMod["Device Enrollment & Heartbeat"]
        PolicyMod["Family Policy Engine (Evaluation)"]
        ScreenMod["Screen Governance & Quota Manager"]
        NotifyMod["Notification & Alert Hub"]
        Prisma["Prisma ORM Client"]
        API --> AuthMod
        API --> EnrollMod
        API --> PolicyMod
        API --> ScreenMod
        API --> NotifyMod
        API --> Prisma
    end

    subgraph StorageLayer["Data Layer"]
        Postgres[("PostgreSQL 18 (127.0.0.1:5433)")]
        DiskStorage["Protected Local File Storage (Screenshots)"]
        Prisma --> Postgres
        ScreenMod --> DiskStorage
    end

    subgraph FrontendLayer["Family Dashboard (React + Vite)"]
        UI["React 18 Dashboard (localhost:5173)"]
        WSS["Real-time Polling & WebSocket"]
        UI --> API
        UI --> WSS
    end

    Agent --"HTTP/1.1 Batch Sync (Auth Token)"--> API
    Ext --"DeclarativeNetRequest / Activity Push"--> API
```

## 2. Core Subsystems

### 2.1 Rust Desktop Agent (`desktop-agent`)
- **`dp-core`**: Core contracts, domain types, JSON schema serialization.
- **`dp-platform-windows`**: Native Win32 bindings using `windows-sys` and `windows-rs`.
- **`dp-storage`**: Embedded SQLite transaction queue with retry semantics.
- **`dp-ipc`**: Local named pipe protocol for intra-device communication.
- **`dp-user-agent`**: Main user session daemon with HTTP synchronization.

### 2.2 Backend Application (`backend`)
- **Framework**: Fastify 5.x on Node.js 20+ LTS.
- **Authentication**: Salted scrypt password hashing, session tokens, rate limiting.
- **Role-Based Access Control**:
  - `FAMILY_OWNER`: Full household, policy, and device governance.
  - `ADULT_MEMBER`: Self-activity insights, wellbeing goals, consent toggles.
  - `SUPERVISED_MEMBER`: Read-only age-appropriate timeline and time planner.
- **Ingestion Pipeline**: Deduplicating batch receiver (`POST /api/v1/activity/events/batch`).
- **Policy Engine**: In-memory rule cache with sub-millisecond evaluation.

### 2.3 Browser Extension (`apps/browser-extension`)
- **Manifest**: Chrome & Edge Manifest V3.
- **Privacy Core**: `extractDomain` normalizes URLs, aggressively stripping query strings, hash fragments, and credentials.
- **Policy Enforcement**: Dynamically updates `declarativeNetRequest` rules to display soft warning or blocked pages.

### 2.4 Family Dashboard (`apps/dashboard`)
- **Framework**: React 18, Vite, Tailwind CSS, Lucide icons.
- **Theme**: High-contrast, dark-mode design system.
- **Navigation Sections**: Overview, Family Members, Devices, Activity Timeline, App Usage, Web Usage, Screen Monitoring, Time Planner, Wellbeing, Policies, Alerts & Notifications, Privacy & Permissions, Settings.
