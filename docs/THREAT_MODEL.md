# DigitalPulse — Threat Model & Security Posture (Stage 2)

## 1. Scope & Boundaries

The DigitalPulse platform operates under a transparent, consent-based digital wellbeing philosophy. This threat model applies STRIDE methodology to evaluate local and network threat vectors.

### Trust Boundaries
1. **Windows User Session vs. System**: The desktop agent runs as the current logged-in user (Session 1+). It does not execute as an unconstrained SYSTEM service (Session 0).
2. **Local Loopback Boundary**: All HTTP/WebSocket services strictly bind to `127.0.0.1`. Binding to `0.0.0.0` or public interfaces is explicitly rejected in code.
3. **Browser Sandbox Boundary**: The browser extension operates within Chrome/Edge sandbox constraints.
4. **Household & Role Separation**: Multi-user tenancy within a household prevents unprivileged supervised members from altering family policies or viewing other members' private sessions without consent.

---

## 2. STRIDE Threat Analysis & Mitigations

| Threat Category | Potential Attack Vector | DigitalPulse Stage 2 Mitigation |
|---|---|---|
| **Spoofing** | Rogue application impersonating the desktop agent to forge activity events. | Device enrollment tokens, per-device HMAC secrets, and session validation on ingestion endpoints. |
| **Tampering** | Modifying buffered SQLite activity events or tampering with local policies. | SQLite WAL mode, schema integrity checks, and server-side policy re-evaluation upon batch commit. |
| **Repudiation** | An administrator denying having viewed a screen share or altered a policy. | Immutable `AuditLog` records for every sensitive operation (policy changes, screen capture access, live share starts). |
| **Information Disclosure** | Leakage of private passwords, keystrokes, form contents, or URLs. | **Zero Keystroke / Zero Clipboard policy**: Agent never hooks keyboard. Browser extension collects domain only (`github.com`, never full URL or search queries). |
| **Denial of Service** | Flooding the local Fastify backend with unbounded event batches. | Fastify rate-limiting (`@fastify/rate-limit`), batch payload size limits (max 500 events / 2MB), and memory queue bounds. |
| **Elevation of Privilege** | Supervised child elevating role to Family Owner to bypass restrictions. | Server-side RBAC validation on all administrative endpoints; client-side UI route guards alone are never trusted. |

---

## 3. Explicit Privacy Guarantees
- **No Covert Surveillance**: Monitoring beacons are permanently visible when screen capture or live sharing is active.
- **Right to Pause**: Adult members retain immediate one-click pause and revocation controls.
- **Local Storage Quotas**: Screenshots are stored strictly on local protected disk with automatic retention purging (default: 7 days or 2 GB limit).

