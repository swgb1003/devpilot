# Agent API

M2 listens on `http://127.0.0.1:47831` by default. It is intentionally loopback-only. M3 will introduce the authenticated paired Mobile transport and its certificate trust flow.

## Public local routes

| Method | Path         | Purpose                                    |
| ------ | ------------ | ------------------------------------------ |
| `GET`  | `/health`    | Sidecar liveness and core version          |
| `GET`  | `/m1/report` | M1 Flutter/Android/TLS capability evidence |

Both routes use the success envelope `{ "data": ... }`.

## Authenticated Desktop routes

Every `/api/v1/*` request requires `Authorization: Bearer <DEVPILOT_DESKTOP_TOKEN>`. The configured token must contain at least 32 characters and is compared in constant time.

| Method | Path                          | Purpose                                                   |
| ------ | ----------------------------- | --------------------------------------------------------- |
| `GET`  | `/api/v1/config`              | Non-secret runtime configuration and schema version       |
| `GET`  | `/api/v1/activities?limit=50` | Activity history, newest first; limit is clamped to 1–200 |
| `POST` | `/api/v1/activities`          | Append an Activity record and publish a live event        |
| `POST` | `/api/v1/ws-tickets`          | Issue a single-use, short-lived WebSocket ticket          |

Activity input:

```json
{
  "kind": "agent.started",
  "severity": "info",
  "message": "Agentを起動しました。",
  "metadata": {}
}
```

## WebSocket events

1. Call `POST /api/v1/ws-tickets` with the Desktop bearer token.
2. Connect to `ws://127.0.0.1:47831/api/v1/events?ticket=<ticket>`.
3. The ticket is consumed by the first successful upgrade and cannot be reused.
4. Activity inserts are sent as `activity.created` event envelopes.

The ticket exists to avoid putting the long-lived Desktop token into a WebSocket URL or browser logs. When `DEVPILOT_TLS_CERT_PATH` and `DEVPILOT_TLS_KEY_PATH` are configured together, the same server runs as HTTPS/WSS; M3 supplies the persisted certificate and Mobile fingerprint-pinning lifecycle.

## Error envelope

Failures are machine-readable and safe to display:

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Desktop認証が必要です。",
    "retryable": false,
    "action": "REAUTHENTICATE",
    "traceId": "e05fc4cc-58e2-4acd-8b86-cb4baa59155a"
  }
}
```

Unknown failures do not expose stack traces, environment values, database paths, or tokens. HTTP responses are marked `Cache-Control: no-store`, request bodies are limited to 64 KiB, and CORS is restricted to known loopback/Tauri origins.
