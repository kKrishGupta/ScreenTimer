# DigitalPulse — API Specification

Base URL: `http://127.0.0.1:3001/api/v1`

## 1. System Health
### `GET /health`
Returns service status, uptime, and database connectivity.
- **Response 200 OK**:
  ```json
  {
    "status": "ok",
    "service": "digitalpulse-backend",
    "version": "0.1.0",
    "time": "2026-11-02T00:00:00.000Z",
    "uptimeSeconds": 42,
    "database": {
      "status": "up",
      "latencyMs": 2
    }
  }
  ```

## 2. Activity Ingestion
### `POST /activity/events/batch`
Ingests an array of activity events from an authorized collector.
- **Request Body**:
  ```json
  {
    "device": {
      "id": "11111111-2222-3333-4444-555555555555",
      "kind": "desktop_agent",
      "name": "WIN11-DESKTOP",
      "platform": "windows",
      "agentVersion": "0.1.0"
    },
    "events": [
      {
        "schemaVersion": 1,
        "eventId": "22222222-3333-4444-5555-666666666666",
        "deviceId": "11111111-2222-3333-4444-555555555555",
        "source": "desktop_agent",
        "type": "app_session",
        "startedAt": "2026-11-02T00:00:00.000Z",
        "endedAt": "2026-11-02T00:05:00.000Z",
        "durationSeconds": 300,
        "app": {
          "name": "Visual Studio Code",
          "executable": "Code.exe",
          "processId": 1234
        }
      }
    ]
  }
  ```
- **Response 200 OK**:
  ```json
  {
    "accepted": 1,
    "deduplicated": 0
  }
  ```

## 3. Query Endpoints (Dashboard)
- `GET /activity/timeline?from=...&to=...&limit=50`: Chronological activity sessions.
- `GET /activity/apps?from=...&to=...`: Aggregated usage by application.
- `GET /activity/websites?from=...&to=...`: Aggregated usage by domain.
- `GET /devices`: List of registered devices and collector status.

