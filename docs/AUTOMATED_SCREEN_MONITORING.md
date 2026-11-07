# Automated Employee Screen Monitoring

DigitalPulse captures authorized Windows work screens in the enrolled desktop agent, uploads compressed JPEG images through device-authenticated APIs, stores them privately, and exposes short-lived authenticated image links in the Organization Admin dashboard. The backend never attempts to capture its own server desktop.

## Architecture

1. An organization admin enables monitoring, configures a minimum five-minute interval, schedule, retention, exclusions, and eligible desktop devices.
2. The employee sees the monitoring notice in the Employee Portal and explicitly acknowledges it. Existing device enrollment, organization authorization, employee consent, and work-shift checks also remain mandatory.
3. The enrolled Windows agent refreshes policy every 30 seconds. During an authorized window it shows a persistent notification-area indicator and uses a non-overlapping scheduler to capture the virtual desktop.
4. JPEG captures are queued locally with Windows DPAPI protection. Uploads use device credentials, an idempotency key, exponential retry, and a bounded queue.
5. The backend re-evaluates the current policy and device ownership, validates the image and timestamp, and uploads it as a Cloudinary `authenticated` asset before transactional metadata.
6. Admin gallery requests are tenant-scoped and return five-minute, user-bound image URLs. Viewing and deletion are audited.
7. An hourly retention job removes expired objects before deleting metadata. Failed object deletions retain their metadata for retry.

The existing `screen_captures`/`ScreenCaptureMetadata` model is extended; no duplicate screenshot table or authentication system is introduced.

## Database migration

Deploy `20261106130000_screen_monitoring_e2e`. It adds persistent organization settings, employee acknowledgement, per-device capture selection/status, storage metadata, retention expiry, and a unique `(deviceId, captureKey)` constraint for duplicate prevention.

```powershell
npm run db:generate -w @digitalpulse/backend
npm run db:deploy -w @digitalpulse/backend
```

## API

All routes are under `/api/v1`.

| Method | Route | Authorization | Purpose |
|---|---|---|---|
| GET | `/screen-monitoring/settings` | Org/Super Admin | Read tenant settings |
| PATCH | `/screen-monitoring/settings` | Org/Super Admin | Update interval, schedule, retention, exclusions |
| GET | `/screen-monitoring/employees` | Org/Super Admin | Device, owner, connectivity, and capture status |
| PATCH | `/screen-monitoring/devices/:deviceId` | Org/Super Admin | Select or deselect an enrolled desktop device |
| POST | `/screen-monitoring/acknowledgement` | Employee | Acknowledge or withdraw the monitoring notice |
| GET | `/screen-monitoring/device-policy?deviceId=...` | Device secret | Fetch effective policy |
| POST | `/screen-monitoring/captures` | Device secret | Upload JPEG/PNG with capture headers |
| POST | `/screen-monitoring/failures` | Device secret | Report capture/upload failure metadata |
| GET | `/screen-monitoring/captures` | Org/Super Admin | Paginated, filtered gallery |
| GET | `/screen-monitoring/employees/:employeeId/captures` | Org/Super Admin | Employee capture history |
| GET | `/screen-monitoring/captures/:captureId` | Org/Super Admin | Capture metadata |
| GET | `/screen-monitoring/captures/:captureId/image` | Org/Super Admin + signed token | Stream private image |
| DELETE | `/screen-monitoring/captures/:captureId` | Org/Super Admin | Delete object and metadata |

Super Admin requests require an explicit `organizationId`. Every device and capture query verifies organization ownership.

## Environment

Required for Cloudinary storage:

```dotenv
SCREENSHOT_STORAGE_PROVIDER=cloudinary
SCREENSHOT_ENCRYPTION_KEY=<unique-random-secret-at-least-32-characters>
CLOUDINARY_CLOUD_NAME=<Cloudinary cloud name>
CLOUDINARY_API_KEY=<server-side API key>
CLOUDINARY_API_SECRET=<server-side API secret>
```

Cloudinary objects are uploaded under `digitalpulse/screenshots/<organization>/<device>/<capture>` with delivery type `authenticated`, so neither originals nor derived images are publicly accessible. DigitalPulse generates a one-minute server-side Cloudinary download URL and proxies the bytes only after its own role, tenant, audit, and five-minute viewer-token checks. Keep `CLOUDINARY_API_SECRET` on the backend only.

For offline/local development, `SCREENSHOT_STORAGE_PROVIDER=local` and `SCREENSHOT_STORAGE_DIR=./storage/screenshots` retain the AES-256-GCM filesystem provider.

## Installation and deployment

1. Configure the backend environment and back up PostgreSQL.
2. Generate Prisma Client and deploy the migration using the commands above.
3. Build the dashboard with `npm run build -w @digitalpulse/dashboard` and deploy it with the backend.
4. Build/package the Windows desktop agent using `scripts/package-employee-downloads.ps1`. Install it through the existing enrollment flow so the user-session agent receives the device ID and secret.
5. In **Organization Admin → Screen Monitoring**, save policy settings and enable an enrolled Windows device.
6. Have the employee open the Employee Portal and acknowledge the persistent notice.

The browser extension continues browser-domain synchronization; full-screen capture intentionally runs only in the enrolled desktop agent.

## Manual end-to-end test

1. Use two organizations and enroll one Windows device in each.
2. Enable monitoring for only the first organization/device with the current day and time inside the policy window.
3. Confirm no screenshot occurs before employee acknowledgement. Acknowledge and confirm the Windows notification-area indicator appears.
4. Wait one configured interval (minimum five minutes). Verify the gallery shows the real desktop image, employee/device names, application, and actual capture timestamp.
5. Disconnect networking for one interval, reconnect, and confirm the queued capture uploads once without duplication.
6. Filter gallery results by employee, device, date, and search; open the viewer and navigate previous/next.
7. Attempt access with the second organization and with an expired/tampered image token; expect denial.
8. Lock Windows, move outside configured hours, disable monitoring, and withdraw acknowledgement in turn; each must stop capture and remove the indicator.
9. Configure a sensitive executable exclusion, focus it at capture time, and confirm the agent reports a skipped/failed state rather than an image.
10. Set a test row's expiry in the past, run/restart the cleanup job, and verify both the private object and metadata are removed.

## Operational notes

- Capture interval is constrained to 300–3600 seconds.
- Images are limited to 5 MiB and validated by MIME type and file signature.
- The upload queue holds at most 50 DPAPI-protected captures and uses exponential backoff.
- Monitoring does not run on browser-only, revoked, unmanaged, locked, unacknowledged, unauthorized, or off-schedule devices.
- Rotate Cloudinary credentials normally. `SCREENSHOT_ENCRYPTION_KEY` signs DigitalPulse viewer tokens and also encrypts local-provider objects; rotate it only after active viewer links have expired, and migrate or expire local objects before changing it.
