# DigitalPulse Enterprise — Authenticated Development Device Enrollment Guide

## Overview

In accordance with P0 security hardening, all activity event ingestion (`/api/v1/activity/events/batch`) and device heartbeat endpoints (`/api/v1/devices/:id/heartbeat`) require cryptographic device authentication. Unauthenticated requests are rejected with `HTTP 401 Unauthorized`. Client-provided device IDs are never trusted without cryptographic credential verification.

To maintain backward compatibility during local development and testing while avoiding hardcoded secrets or security bypasses in production, DigitalPulse uses an authenticated device enrollment workflow.

---

## 1. Architecture & Security Model

```
┌─────────────────────────────────┐
│       Administrator / CLI       │
└────────────────┬────────────────┘
                 │ 1. POST /api/v1/devices/enrollment-tokens (Requires Admin/Manager Session)
                 ▼
┌─────────────────────────────────┐
│      Fastify API Backend        │
└────────────────┬────────────────┘
                 │ 2. Returns short-lived enrollment token (expires in 15 mins)
                 ▼
┌─────────────────────────────────┐
│  Desktop Agent / Extension      │
└────────────────┬────────────────┘
                 │ 3. POST /api/v1/devices/enroll { enrollmentToken, deviceId, name, platform, kind }
                 ▼
┌─────────────────────────────────┐
│      Fastify API Backend        │
└────────────────┬────────────────┘
                 │ 4. Generates cryptographically secure 64-character hex secret,
                 │    stores scrypt hash in DB, binds device to Organization,
                 │    returns raw secret once to client.
                 ▼
┌─────────────────────────────────┐
│     Client Ingestion / Sync     │
│   (Sends X-Device-Secret)       │
└─────────────────────────────────┘
```

---

## 2. Step-by-Step Enrollment Process

### Step 1: Obtain an Admin / Manager Session Token
Login or register an Organization Admin:
```bash
curl -X POST http://127.0.0.1:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "StrongPassword123!"}'
```
*Note the returned session token / cookie.*

### Step 2: Generate an Enrollment Token
Call the enrollment token generation endpoint with the session token:
```bash
curl -X POST http://127.0.0.1:3001/api/v1/devices/enrollment-tokens \
  -H "Authorization: Bearer <SESSION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"platform": "windows_11", "label": "Dev Workstation"}'
```
Response:
```json
{
  "enrollmentToken": "dpenroll_7b29e06180df4e28...",
  "expiresAt": "2026-11-02T22:30:00.000Z",
  "householdId": "household_cuid...",
  "organizationId": "household_cuid..."
}
```

### Step 3: Enroll Device and Obtain Device Secret
Use the enrollment token to register the local device:
```bash
curl -X POST http://127.0.0.1:3001/api/v1/devices/enroll \
  -H "Content-Type: application/json" \
  -d '{
    "enrollmentToken": "dpenroll_7b29e06180df4e28...",
    "deviceId": "dev-desktop-01",
    "name": "Dev Workstation Agent",
    "platform": "windows_11",
    "kind": "desktop_agent"
  }'
```
Response:
```json
{
  "status": "enrolled",
  "deviceId": "dev-desktop-01",
  "deviceSecret": "91ab7e20cf3a8...",
  "heartbeatIntervalSeconds": 60,
  "householdId": "household_cuid..."
}
```

---

## 3. Configuring Local Agents

### A. Rust Desktop Agent (`dp-user-agent`)
Set the environment variable `DP_DEVICE_SECRET` before starting the agent:

**PowerShell:**
```powershell
$env:DP_DEVICE_SECRET = "91ab7e20cf3a8..."
.\dp-user-agent.exe
```

**Command Prompt / System Env:**
```cmd
set DP_DEVICE_SECRET=91ab7e20cf3a8...
dp-user-agent.exe
```

When `DP_DEVICE_SECRET` is present, `dp-user-agent` includes the `X-Device-Secret: <secret>` header on all batch posts to `/api/v1/activity/events/batch`.

### B. Chrome / Edge Browser Extension
Store the secret in extension storage via Developer Tools Console or options:
```javascript
await chrome.storage.local.set({ dp_device_secret: "91ab7e20cf3a8..." });
```
The service worker automatically attaches `X-Device-Secret` to subsequent event sync batches.

---

## 4. Device Management Operations

### Heartbeat
Devices send periodic heartbeats to maintain connectivity status:
```bash
curl -X POST http://127.0.0.1:3001/api/v1/devices/dev-desktop-01/heartbeat \
  -H "X-Device-Secret: 91ab7e20cf3a8..." \
  -H "Content-Type: application/json" \
  -d '{"agentVersion": "0.1.0", "status": "active"}'
```

### Secret Rotation
Admins or enrolled devices can rotate their credentials:
```bash
curl -X POST http://127.0.0.1:3001/api/v1/devices/dev-desktop-01/rotate-secret \
  -H "X-Device-Secret: 91ab7e20cf3a8..."
```
Response returns a new `deviceSecret`. The previous secret is immediately invalidated.

### Revocation
Admins can revoke compromised or decommissioned devices:
```bash
curl -X POST http://127.0.0.1:3001/api/v1/devices/dev-desktop-01/revoke \
  -H "Authorization: Bearer <ADMIN_SESSION_TOKEN>"
```
Once revoked, any ingestion or heartbeat attempts return `HTTP 403 Forbidden`.

