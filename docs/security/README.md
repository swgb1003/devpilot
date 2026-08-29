# Security baseline

The implementation preserves these non-negotiable constraints:

- No source modification without a scoped approval.
- No path outside the registered real project root; reject symlink escape.
- Never expose tokens, authorization headers, VM Service tokens, environment values, or form inputs in logs.
- No automatic Git push, production deploy, secret change, or mass deletion.
- Treat screenshots, logs, project text, and AI output as untrusted input.
- Do not bind product APIs to a public network before the M1 local TLS decision is accepted.

## M2 controls

- Agent host configuration rejects every bind address except `127.0.0.1`.
- `/api/v1/*` requires a randomly generated or explicitly injected Desktop token of at least 32 characters.
- Bearer tokens are compared with a constant-time operation and never appear in response bodies.
- WebSockets use a separate expiring, single-use ticket; the Desktop token is not accepted in the query string.
- SQLite uses foreign keys, a busy timeout, WAL for disk-backed storage, and a versioned schema.
- Activity history defaults to 30-day retention and can be configured only from 1 through 365 days.
- JSON bodies are capped at 64 KiB and structured errors omit internal stack traces.
- CORS permits only the Agent loopback origin, the local Vite origin, and Tauri application origins.

## M2 limitations

The current Desktop bearer token is an Agent bootstrap contract, not a paired Mobile credential. QR pairing, device revocation, certificate fingerprint confirmation, and authenticated LAN exposure belong to M3. Until that work lands, no `/api/v1/*` product route may bind to a LAN or public interface.
