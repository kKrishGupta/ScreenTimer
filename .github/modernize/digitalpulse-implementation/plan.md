# Modernization Plan: DigitalPulse Integrated Workflow Implementation

**Project**: DigitalPulse  
**Plan folder**: `.github/modernize/digitalpulse-implementation`

## Technical Framework

- **Language**: TypeScript/JavaScript, JSX, Rust desktop agent
- **Framework**: Fastify, Prisma, React, Vite, Manifest V3, Rust/Win32
- **Build Tool**: npm workspaces; Cargo workspace for the desktop agent
- **Database**: PostgreSQL via Prisma; SQLite buffering in the desktop agent
- **Key dependencies**: Fastify, Prisma, React, Vitest, Node test runner,
  Chrome/Edge MV3 APIs, Rust crates

## Overview

This plan turns the current DigitalPulse repository into an evidence-backed,
integrated implementation rather than relying on completion claims in existing
documentation. The existing codebase remains authoritative. Work will first
freeze a reproducible repository baseline, then close the highest-impact gaps
across identity/tenant boundaries, device and browser synchronization, and
dashboard data workflows. Documentation will be updated only with evidence
from source inspection and commands that actually run.

The plan preserves the Windows-first, localhost-only, privacy-first product
contract. It does not authorize cloud deployment, unsupported runtime claims,
or removal of existing functionality.

## Current Evidence and Constraints

- `docs/PROJECT_GAP_AUDIT.md` explicitly distinguishes static evidence from
  end-to-end verification and identifies authentication/tenant isolation,
  enrollment/sync, real data wiring, and several governance workflows as
  partial or unverified.
- `docs/PRD.md` remains authoritative for Stage 1 privacy constraints,
  including no keylogging, clipboard inspection, screenshots, URL parameters,
  or page-body parsing.
- The repository is a mixed npm/Rust workspace; the plan metadata therefore
  records `typescript` as the primary application language and calls out Rust
  validation separately.
- The working tree already contains uncommitted changes. The baseline task
  must record them and avoid overwriting unrelated work.

## Phases and Dependencies

1. **Baseline and contract** — inventory source, scripts, tests, current
   working-tree state, and authoritative product requirements; create/update
   the three requested evidence-based documents.
2. **Identity and isolation** — verify and improve authentication, session
   handling, role checks, organization scoping, and cross-tenant negative
   cases. Depends on the baseline.
3. **Collection and synchronization** — verify device enrollment, heartbeat,
   offline/idempotent ingestion, browser extension queue/policy sync, and
   privacy-preserving domain handling. Depends on identity and isolation.
4. **Real-data product workflows** — connect dashboard pages to the real API
   contracts and improve analytics, policies, notifications, audit, and
   employee/device views without replacing working behavior. Depends on
   collection and synchronization.
5. **Security and release evidence** — scan/remediate dependency issues where
   feasible, validate localhost/configuration safeguards, and improve startup
   or packaging only when the repository evidence justifies it. Depends on
   implementation phases.
6. **Focused validation and reporting** — run targeted npm, Vitest, Node,
   Cargo, and build commands that are available; update the implementation
   report with exact commands, results, and remaining limitations. Depends on
   all prior phases.

## Validation Strategy

Validation is evidence-first and bounded to the repository's available
tooling. Expected checks include focused backend, dashboard, extension, and
contract tests; dashboard production build; and `cargo test --workspace` when
the Rust toolchain is available. Database-backed or browser-loaded workflows
must be labeled unverified when PostgreSQL, Chrome/Edge, Windows services, or
other required runtime infrastructure is unavailable. No plan step may claim
runtime verification from static inspection alone.

## Deliverables

- `docs/DIGITALPULSE_PRODUCT_CONTRACT.md`
- `docs/DIGITALPULSE_IMPLEMENTATION_TRACKER.md`
- `docs/DIGITALPULSE_IMPLEMENTATION_REPORT.md`
- Focused source/test changes for the highest-priority integrated gaps
- Exact validation evidence and an explicit limitations section

## Open Questions & Questionnaire

- [x] Scope → Implement the most important missing integrated workflows while
  preserving working functionality.
- [x] Deployment → Inspect and improve deployment only where needed and
  feasible; do not broaden into an unsupported cloud migration.
- [x] Verification → Run focused tests/builds and report exact evidence without
  claiming unsupported runtime verification.
