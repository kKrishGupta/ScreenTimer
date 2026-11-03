# DigitalPulse Enterprise — Policy Engine & 15-Minute Grace Period

## 1. Overview & Business Rationale

DigitalPulse Enterprise rejects rigid, frustrating binary blocking. Instead, it provides an intelligent **15-Minute Grace Period State Machine** that balances employee autonomy with corporate access governance.

Employees visiting non-work or restricted domains (such as social networks or entertainment portals) receive an immediate, transparent 15-minute grace window each day. Once the allowance elapses, the domain transitions to blocked for the remainder of the calendar day, enforceable directly at the browser network layer.

---

## 2. Finite State Machine Specification

```
   [NOT_VISITED]
         │
         │ First Visit Detected (Today)
         ▼
   [GRACE_ACTIVE] ───────────────┐
   (15-Minute Timer Running)     │
         │                       │
         │ 15 Elapsed Minutes    │ Admin Reset
         ▼                       │
     [BLOCKED] ──────────────────┘
   (Enforced at Network Layer)
         │
         │ Next Calendar Day (UTC 00:00)
         ▼
   [NOT_VISITED]
```

### State Definitions

1. **`NOT_VISITED`**:
   - The domain has not been accessed by the employee/organization during the current calendar day.
   - Access is permitted. 15 minutes of grace time remain intact.

2. **`GRACE_ACTIVE`**:
   - Triggered upon the employee's first visit to the restricted domain.
   - The server records `firstVisitedAt = now()` and `expiresAt = now() + 15 minutes`.
   - **Continuous Elapsed Timer**: The countdown runs based on wall-clock time (`expiresAt - now()`). 
   - Refreshing the browser tab, switching between Chrome and Microsoft Edge, or rebooting the PC **cannot reset or pause** the timer.

3. **`BLOCKED`**:
   - Reached automatically when `now() >= expiresAt`.
   - Subsequent navigation attempts are blocked:
     - Browser extension intercepts the request and redirects to the Enterprise Blocked Page (`/api/v1/policies/blocked-page`).
     - Network requests are blocked via `declarativeNetRequest` dynamic rules.

4. **`ADMIN_RESET`**:
   - An administrator can override the block for legitimate business necessity via `POST /api/v1/policies/grace/reset`.
   - Extends the grant by another 15 minutes and logs an immutable audit event (`resetBy`).

---

## 3. Database Schema & Concurrency Guarantees

The grace state machine is backed by PostgreSQL table `grace_grants`:

```sql
CREATE TABLE "grace_grants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "domain" VARCHAR(253) NOT NULL,
  "status" "grace_status" NOT NULL DEFAULT 'not_visited',
  "grace_minutes" INTEGER NOT NULL DEFAULT 15,
  "first_visited_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3),
  "calendar_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "reset_by" VARCHAR(128),
  "reset_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "grace_grants_org_domain_date_key" UNIQUE ("organization_id", "domain", "calendar_date")
);
```

### Race-Condition Protection
The unique constraint `(organization_id, domain, calendar_date)` prevents race conditions. Opening multiple tabs simultaneously resolves to the same database row, ensuring a single 15-minute countdown starts only once.

