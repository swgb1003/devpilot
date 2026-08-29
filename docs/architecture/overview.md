# Architecture overview

## Runtime boundary

```text
Android
  DevPilot Mobile (Flutter)
       | HTTPS JSON + WSS events
Windows 11
  DevPilot Desktop (Tauri + React)
       | starts, monitors, and configures
  DevPilot Agent (TypeScript + Node.js)
       | capability-based adapters
  Flutter MCP / CLI / VM Service / ADB
       |
  Registered Flutter project + Android debug app
```

## Ownership

- Agent SQLite is the source of truth for pairing, projects, jobs, approvals, and activity.
- Agent memory owns active process handles and live session state.
- Mobile caches display data but never stores source code, full logs, or provider credentials.
- Desktop owns local setup and high-risk approvals, not Flutter control logic.
- Adapter implementations translate common capabilities into tool-specific operations.

## M2 implemented boundary

- The Node Agent binds to `127.0.0.1` and owns a SQLite schema for pairings, projects, sessions, jobs, approvals, activities, and test metadata.
- `/api/v1/*` routes use a constant-time checked Desktop bearer token. A short-lived, single-use ticket authorizes each WebSocket upgrade. The server accepts configured TLS material for HTTPS/WSS.
- Activity records are durable, retention-controlled, queryable newest-first, and broadcast as live events.
- Public `/health` and `/m1/report` endpoints remain local bootstrap and evidence routes.
- The Mobile app contains the complete 12-screen design flow as an interactive visual shell. Its data and device operations are mocked until the corresponding later milestones.

## Deferred boundary

M3 introduces QR pairing, Mobile credentials, certificate trust, and the paired HTTPS/WSS channel. Project safety, sessions, AI jobs, Point & Fix, and test execution remain owned by their later milestones.
