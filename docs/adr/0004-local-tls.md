# ADR 0004: Local TLS and pairing trust

- Status: Partially validated; pairing trust decision pending
- Date: 2026-08-26

## Proposed decision

Expose Agent control over HTTPS and WSS on private networks only. Pair with a 256-bit one-time nonce, Desktop approval, Mobile device key, and QR-provided public-key fingerprint pinning.

## M1 evidence required

- Certificate/public-key generation, storage, rotation, and revocation
- Android acceptance with explicit fingerprint pinning
- Private/public Windows network detection and Firewall behavior
- Dynamic-port fallback and reconnect behavior

## 2026-08-27 Windows spike

The Agent generates a fresh local certificate with loopback SANs, completes an HTTPS round trip on `127.0.0.1`, and records a SHA-256 fingerprint and latency. The probe certificate is ephemeral and is never exposed to a Mobile client.

Persistent certificate storage, pairing nonce and Mobile key flow, Android fingerprint pinning, LAN binding, Firewall behavior, rotation, and revocation remain required before accepting this ADR.

See [`docs/m1/windows-spike-2026-08-27.md`](../m1/windows-spike-2026-08-27.md).
