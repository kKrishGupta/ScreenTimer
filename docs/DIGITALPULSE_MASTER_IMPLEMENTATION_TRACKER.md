# DigitalPulse master implementation tracker

Updated: 2026-11-03

This tracker records verified source changes and actual command evidence. A source implementation is not runtime verification.

| Area | Status | Current evidence / remaining work |
|---|---|---|
| Repository baseline | IMPLEMENTED — NOT RUNTIME VERIFIED | Existing monorepo, dashboard, Fastify/Prisma backend, Rust agent, MV3 extension, migrations, and tests inspected. Working tree already contained extensive changes; those changes were preserved. |
| Privacy deletion | IMPLEMENTED — NOT RUNTIME VERIFIED | Fixed `baseWhere` use-before-definition; tenant/device scope is built before screenshot metadata lookup. Existing authorization suite passed. |
| Registration role | IMPLEMENTED — UNIT TESTED | New organizations persist the `ORG_ADMIN` Prisma enum instead of the legacy family-owner role; registration privilege-escalation tests pass. |
| Analytics tenant / manager scope | IMPLEMENTED — NOT RUNTIME VERIFIED | Daily, weekly, recommendation, and export queries receive trusted session context; organization is mandatory; manager queries include self and direct reports; employee queries are self-scoped. |
| Fake analytics output | IMPLEMENTED — NOT RUNTIME VERIFIED | Removed synthetic productivity score, canned recommendation, and sample CSV records. Database errors now fail visibly. Empty data produces zero totals, a null score/comparison, and header-only CSV. |
| Active duration accounting | IMPLEMENTED — NOT RUNTIME VERIFIED | Activity analytics unions overlapping application/browser intervals and clips them to UTC day boundaries. Category totals remain separate and may overlap; no single score is emitted. |
| Legacy planner analytics | PARTIALLY IMPLEMENTED | Removed seeded task/goal examples, proportional task attribution, fixed daily schedules, and fake percentage splits. Daily active time is tenant/role scoped; unmodeled goals and task attribution return unavailable. Production in-memory-only planner routes fail closed. |
| Persistent usage categories | IMPLEMENTED — NOT RUNTIME VERIFIED | Added tenant-owned `UsageCategory` model and SQL migration; category writes require organization-admin role. Apply migration and generate Prisma client before runtime use. |
| Enrollment token storage | IMPLEMENTED — NOT RUNTIME VERIFIED | New token writes persist SHA-256 hashes; lookup is hash-based; token consumption and unique device creation share a Prisma transaction; production database integration still needs verification. The migration leaves old raw-token rows nullable for controlled transition. |
| Browser extension enrollment UX | IMPLEMENTED — NOT RUNTIME VERIFIED | Popup exchanges one-time token and stores device credential locally without displaying it. Extension sync uses the same stored credential. Chromium load and enrollment are unverified. |
| Windows enrollment / activity | PARTIALLY IMPLEMENTED | Existing Rust agent and CLI changes were present before this work. Secure Windows credential vault integration and live Windows sync lifecycle are unverified. |
| Website policy enforcement | PARTIALLY IMPLEMENTED | Existing policy sync/grace changes and tests were present. Real Chrome/Edge block and temporary grant expiry workflow are unverified. |
| Dashboard and live employee views | PARTIALLY IMPLEMENTED | Existing React pages and APIs were present. No live manager-to-PostgreSQL-to-dashboard runtime workflow was available to verify. |
| Notifications and audit viewer | PARTIALLY IMPLEMENTED | Persistence models and routes were present. Full user-visible lifecycle and audit coverage remain unverified. |
| Password reset ownership / one-time use | PARTIALLY IMPLEMENTED | Existing code hashes tokens, checks account binding, uses atomic update, and revokes sessions. DB-backed concurrency and failure cases still require integration verification. |
| Remote deployment / TLS | NOT VERIFIED | No deployment environment or TLS infrastructure was available; localhost remains configured as the extension default. |
| End-to-end acceptance workflow | BLOCKED BY ENVIRONMENT | No configured PostgreSQL server, installed Windows agent, or loaded Chrome/Edge extension was used in this turn. |

## Immediate follow-up

1. Apply the two new migrations in a disposable PostgreSQL environment and decide how to expire existing plaintext enrollment tokens.
2. Complete all backend and frontend suites after the latest analytics accounting changes.
3. Exercise the manager-to-employee collector workflow with Windows and Chromium infrastructure.
