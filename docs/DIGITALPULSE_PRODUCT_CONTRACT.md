# DIGITALPULSE — PRODUCT CONTRACT & SYSTEM SPECIFICATION

## 1. Product Identity & Purpose

**DigitalPulse** is an enterprise-grade, company-focused Employee Computer Activity, Screen-Time & Application Intelligence Platform.

Its primary purpose is to help authorized company administrators and managers understand how their employees use company-managed or BYOD work computers during configured working hours.

### Core Questions DigitalPulse Answers:
1. **Active vs Idle**: Which employee is currently actively working vs idle at their workstation?
2. **Current Application**: Which executable/application is currently in the foreground?
3. **Application Duration**: Exactly how many minutes/hours has an employee spent in each application?
4. **Website Domain**: Which specific website domains (eTLD+1) has the employee visited?
5. **Website Duration**: How much time was spent on each website domain?
6. **Blocked Domain Attempts**: Which restricted websites were blocked, and how many times did the employee attempt access?
7. **Reporting Status**: Which endpoints are actively streaming telemetry vs offline or stale?
8. **Temporal Aggregations**: How does application and website usage trend daily, weekly, and monthly across teams?
9. **Top Working Time Consumers**: Which applications and websites consume the vast majority of productive work hours?

---

## 2. System Architecture & Collectors

```
+-----------------------------------------------------------------------------------------+
|                                    ENDPOINT LAYER                                       |
|                                                                                         |
|  +----------------------------------+          +-------------------------------------+  |
|  |       Windows EXE Agent          |          |      Chrome / Edge MV3 Extension    |  |
|  | - Win32 Foreground Tracking      |          | - eTLD+1 Domain Extraction          |  |
|  | - Real Win32 Idle (GetLastInput) |          | - Active Tab Tracking               |  |
|  | - SQLite WAL Buffer Queue        |          | - Dynamic DeclarativeNetRequest     |  |
|  | - Token Enrollment CLI           |          | - Sync Queue & Token Configuration  |  |
|  +-----------------+----------------+          +------------------+------------------+  |
+--------------------|----------------------------------------------|---------------------+
                     | Authenticated Telemetry / Heartbeats         |
                     v                                              v
+-----------------------------------------------------------------------------------------+
|                                    BACKEND INGESTION                                    |
|                                                                                         |
|  - Fastify HTTP API (Port 3001)                                                         |
|  - X-Device-Secret & Bearer Authentication Guard                                        |
|  - JSON Schema Strict Contract Validation (@digitalpulse/contracts)                    |
|  - Organization-Level Multi-Tenant Scoping & Device Authorization                       |
|  - Idempotent Batch Event Deduplication & PostgreSQL Atomic Persistence                |
+--------------------------------------------+--------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                                    DATA PERSISTENCE                                     |
|                                                                                         |
|  - PostgreSQL 16 (Prisma ORM): Organizations, Users, Departments, Devices,              |
|    ActivityEvents, ActivitySessions, Applications, Websites, Policies, GraceGrants,     |
|    Notifications, AuditLogs.                                                            |
+--------------------------------------------+--------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
|                                   ANALYTICS & VISIBILITY                                |
|                                                                                         |
|  - Real-time Live Employee Status Feed (Active, Idle, Offline, Current App, Duration)   |
|  - Organization & Manager-Scoped Query Aggregations                                     |
|  - React 19 + Vite + Tailwind Enterprise Management Dashboard                           |
|  - Dedicated Employee Self-Service Transparency Portal                                  |
+-----------------------------------------------------------------------------------------+
```

---

## 3. Data Contracts & Privacy Boundaries

### What DigitalPulse Collects:
- **Application Metadata**: Lowercase executable file name (e.g., `code.exe`, `chrome.exe`) and window title summary (sanitized).
- **Domain Metadata**: Standardized host domain only (e.g., `github.com`, `stackoverflow.com`).
- **Session Duration**: Start timestamp, end timestamp, duration in seconds.
- **Active / Idle State**: Transition state based on physical user input (keyboard/mouse).
- **Device Identity**: Machine name, collector kind (`DESKTOP_WINDOWS`, `BROWSER_EXTENSION`), agent version.

### What DigitalPulse Never Collects (Privacy Charter):
- **NO Keystroke Logging**: Keystroke monitoring and keyloggers are strictly forbidden.
- **NO Form Data / Passwords**: Browser extension strictly excludes form inputs, credentials, and cookies.
- **NO Full URLs**: URL paths, query parameters, search queries, and fragments are never stored or transmitted.
- **NO Personal Files**: File system scanning, document contents, and personal folders are never inspected.

---

## 4. Role-Based Access Control (RBAC)

1. **Organization Administrator (`ORGANIZATION_ADMIN`, `SUPER_ADMIN`)**:
   - Full tenant governance, user invitation/revocation, department creation, device management, organization-wide policy rules, and company-wide analytics.
2. **Department Manager (`MANAGER`)**:
   - Scoped visibility limited strictly to assigned employees and subordinates within their department. No access to unassigned or sibling departments.
3. **Employee (`EMPLOYEE`)**:
   - Access limited strictly to their own personal activity dashboard (`/employee-portal`), privacy transparency charter, and device enrollment status. Forbidden from accessing administrative resources (HTTP 403).

