# DigitalPulse Enterprise — STRIDE Threat Model

This document outlines the security architecture and threat defenses of the DigitalPulse Enterprise platform using the STRIDE methodology.

---

## 1. Threat Analysis Matrix (STRIDE)

| Threat Category | Potential Attack Vector | DigitalPulse Defense & Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Rogue agent submits falsified activity batches | One-time enrollment tokens (`dp_enroll_...`) exchanged for persistent device secrets; SHA-256 session tokens. |
| **Tampering** | User alters local SQLite database to erase unauthorized activity | Immutable write-ahead logging; ingest pipeline requires sequential timestamps and rejects future dates. |
| **Repudiation** | User denies visiting prohibited domain or launching unauthorized app | Cryptographic idempotency keys (`eventId`), UTC timestamp binding, and database audit logs. |
| **Information Disclosure** | Snooping on user credentials, keystrokes, or private messages | **Zero Keystroke / Clipboard Logging**: Agent only tracks process names and window titles; passwords, form inputs, URLs paths/query params are never captured. Screen captures require explicit consent and display visible indicators. |
| **Denial of Service** | Malicious loop floods server with billions of mock events | Rate limiting (`@fastify/rate-limit`, 120 req/min), 1 MiB payload limits, and max batch size of 500 events. |
| **Elevation of Privilege** | Normal employee attempts to modify policies or view coworker activity | Multi-tenant RBAC (`SUPER_ADMIN`, `ORG_ADMIN`, `MANAGER`, `EMPLOYEE`) strictly enforced at the API route and database query layer. |

---

## 2. Privacy & Compliance Principles

1. **Transparent Monitoring**: DigitalPulse is an authorized endpoint governance platform, not spyware or covert surveillance software.
2. **Data Minimization**: Website tracking is strictly limited to domain names (e.g. `github.com`). Query strings, tokens, and page contents are stripped before storage.
3. **Audit Trail**: Every administrative policy reset, screen capture view, and device revocation is logged in `audit_logs`.

