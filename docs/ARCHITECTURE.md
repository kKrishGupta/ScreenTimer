# DigitalPulse — System Architecture

## 1. High-Level Topology (Stage 1 Local Architecture)

```
+-------------------------------------------------------------+
|                      Windows 11 Host                        |
|                                                             |
|  +--------------------+        +-------------------------+  |
|  |  Rust User Agent   |        | Chrome & Edge Extension |  |
|  | (dp-user-agent)    |        | (Manifest V3)           |  |
|  | - Foreground Focus |        | - Tab Domain Tracking   |  |
|  | - Win32 Idle Info  |        | - Browser Focus State   |  |
|  +---------+----------+        +------------+------------+  |
|            |                                |               |
|            | SQLite (Local Buffer)          | Storage       |
|            v                                v               |
|     (sync_queue.db)                  (chrome.storage)       |
|            |                                |               |
|            +---------------+----------------+               |
|                            | REST Batch Ingestion           |
|                            v                                |
|             +------------------------------+                |
|             |    Fastify Backend (Node)    |                |
|             |      http://127.0.0.1:3001   |                |
|             +--------------+---------------+                |
|                            | Prisma ORM                     |
|                            v                                |
|             +------------------------------+                |
|             |   PostgreSQL 18 Database     |                |
|             |      127.0.0.1:5433          |                |
|             +------------------------------+                |
|                            ^                                |
|                            | REST /api/v1 (Vite proxy)      |
|             +--------------+---------------+                |
|             |   React + Vite Dashboard     |                |
|             |      http://localhost:5173   |                |
|             +------------------------------+                |
+-------------------------------------------------------------+
```

## 2. Desktop Agent Modular Breakdown
- `crates/dp-core`: Platform-independent contracts, domain types, and configuration. Shared fixture validation with JS schemas.
- `crates/dp-platform-windows`: Win32 native APIs (`GetForegroundWindow`, `GetWindowThreadProcessId`, `QueryFullProcessImageNameW`, `GetLastInputInfo`).
- `crates/dp-storage`: SQLite local storage using prepared statements and transactional queues for offline buffering.
- `crates/dp-ipc`: Windows Named Pipe definitions (`\\.\pipe\DigitalPulse.Agent.v1`) for service-to-agent communication.
- `crates/dp-user-agent`: Interactive user-session agent running in the logged-in session.
- `crates/dp-service`: Session 0 Windows Service daemon.

## 3. Communication & Data Flow
- **Event Contracts**: JSON Schema Draft 7 in `shared/contracts/schemas` is the single source of truth.
- **Idempotency**: Every event contains an immutable `eventId` (UUID). The backend deduplicates events on ingest.
- **Offline Buffering**: If the backend is unreachable, the agent and extension queue events locally and drain the buffer upon reconnection.

