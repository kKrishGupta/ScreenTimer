# DigitalPulse — Database Design

## 1. PostgreSQL Schema (Backend)
Managed via Prisma ORM (`backend/prisma/schema.prisma`).

### Core Tables
1. **`organizations`**
   - Multi-tenant foundation (defaults to `local-dev` in Stage 1).
   - Columns: `id` (UUID), `name`, `slug`, `created_at`, `updated_at`.
2. **`users`**
   - Authorized users / operators.
   - Columns: `id` (UUID), `organization_id`, `email`, `display_name`, `role`, timestamps.
3. **`devices`**
   - Registered desktop collectors and browser extensions.
   - Columns: `id` (UUID), `organization_id`, `user_id`, `kind`, `name`, `platform`, `browser`, `agent_version`, `last_seen_at`, `last_sync_at`.
4. **`applications`**
   - Normalized catalog of observed applications.
   - Columns: `id` (UUID), `organization_id`, `executable_name` (unique per org), `display_name`.
5. **`websites`**
   - Normalized catalog of observed website domains.
   - Columns: `id` (UUID), `organization_id`, `domain` (unique per org).
6. **`activity_events`**
   - Immutable ingestion log with raw JSONB payload for auditing.
   - Columns: `id` (UUID), `organization_id`, `device_id`, `event_id` (unique per device), `schema_version`, `source`, `type`, `payload`, `received_at`.
7. **`activity_sessions`**
   - Normalized projection optimized for analytics queries.
   - Columns: `id`, `organization_id`, `device_id`, `activity_event_id`, `type`, `source`, `application_id`, `website_id`, `process_id`, `browser`, `started_at`, `ended_at`, `duration_seconds`.
8. **`daily_summaries`**
   - Fast aggregate rollups per device/day.
   - Columns: `id`, `organization_id`, `device_id`, `day` (Date), `active_seconds`, `idle_seconds`, `app_seconds`, `web_seconds`, `session_count`.

## 2. SQLite Schema (Desktop Agent Local Buffer)
Managed via `crates/dp-storage`.
- `activity_sessions`: Local record buffer.
- `sync_queue`: Outbound FIFO queue with sync status.
- `agent_state`: Key-value configuration and sync cursors.

