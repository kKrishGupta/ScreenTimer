# DigitalPulse Enterprise — End-to-End Data Flow

## 1. Activity Collection & Ingestion Pipeline

```
  [User Activity on Windows 11]
           │
           ├─── Foreground Focus Change (Win32) ──► Rust Agent (dp-user-agent)
           │                                            │
           │                                            ├── Deduplicate & discard < 500ms
           │                                            ├── Buffer to local SQLite (events.db)
           │                                            └── Sync batch every 30s ────┐
           │                                                                         │
           └─── Tab Navigation (Chrome / Edge)  ──► Browser Extension (MV3)          │
                                                        │                            │
                                                        ├── Extract domain only       │
                                                        ├── Buffer to chrome.storage │
                                                        └── Sync batch every 30s ────┤
                                                                                     ▼
                                                                     [Fastify Backend API]
                                                                     /api/v1/activity/events/batch
                                                                                     │
                                                                   Validate Schema & Signature
                                                                                     │
                                                                   Idempotent Deduplication
                                                                   UNIQUE(device_id, event_id)
                                                                                     │
                                                                   Atomic Transaction
                                                                   Write raw ActivityEvent
                                                                   Write normalized ActivitySession
                                                                                     ▼
                                                                     [PostgreSQL 18 Database]
                                                                                     │
                                                                      Indexed Queries by Org/User
                                                                                     ▼
                                                                     [React Executive Dashboard]
```

## 2. Access Governance & Grace Period Flow

```
  [Employee Visits Target Domain]
           │
           ▼
  [Browser Extension Tab Updated]
           │
           ▼
  [POST /api/v1/policies/grace/visit]
           │
           ├─── If NOT_VISITED:
           │       Initiate 15-min countdown: firstVisitedAt = now(), expiresAt = now() + 15m
           │       Status becomes GRACE_ACTIVE. Access ALLOWED.
           │
           ├─── If GRACE_ACTIVE and now < expiresAt:
           │       Remaining time computed from database. Access ALLOWED.
           │
           ├─── If GRACE_ACTIVE and now >= expiresAt:
           │       Transition database status to BLOCKED.
           │       Update dynamic declarativeNetRequest rules.
           │       Redirect user to /api/v1/policies/blocked-page.
           │
           └─── If BLOCKED:
                   Access DENIED. User sees corporate governance advisory.
                   Optional: Administrator triggers POST /api/v1/policies/grace/reset (+15 mins).
```

