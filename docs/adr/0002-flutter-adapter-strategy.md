# ADR 0002: Flutter capability adapters

- Status: Validated for M1; production authentication policy deferred to M2
- Date: 2026-08-26

## Proposed decision

Route operations by capability, preferring Flutter MCP and falling back to Flutter CLI, VM Service, or ADB only for the missing capability. Product services depend on `DeviceController`, never on a tool name.

## M1 evidence required

- Exact MCP tool names, response fixtures, Driver extension requirements, and timeout behavior
- Screenshot and Hot Reload behavior on a real Windows 11 / Android session
- ADB screenshot metadata and latency
- Authentication, project mismatch, and retryable error classification

## 2026-08-27 Windows spike

- Initial evidence recorded Flutter 3.29.3 / Dart 3.7.2; Dart 3.7.2 did not expose `dart mcp-server`.
- The SDK was updated on 2026-08-27 to Flutter 3.47.1 / Dart 3.13.1, satisfying the official Dart 3.9+ MCP prerequisite. A fresh `GET /m1/report` detects the MCP stdio server waiting for a JSON-RPC handshake and confirms Flutter CLI device discovery; exact MCP tool names and responses still require a running debug app.
- On 2026-08-28, an authorized Android device returned a valid 1080x2640 PNG screenshot through `adb exec-out screencap -p` in 382 ms. The Agent validates metadata only and does not persist the image.
- The Mobile app gates `enableFlutterDriverExtension()` behind `--dart-define=ENABLE_FLUTTER_DRIVER=true`. With that flag, MCP discovered and connected to `devpilot_mobile` through DTD, and `flutter_driver_command` returned a PNG screenshot response. The response was validated and discarded without persistence.
- An intentionally missing Driver target timed out with `isError: true` in 308 ms; a subsequent idempotent screenshot succeeded in 922 ms. Treat this class as bounded-retryable for read-only operations.
- An invalid app URI returned `isError: true` in 1 ms and instructed the client to refresh `dtd listConnectedApps`; do not retry an unchanged URI.
- M1 intentionally has no pairing identity or production authentication surface. Authentication and authorization error classes belong to M2.

See [`docs/m1/windows-spike-2026-08-27.md`](../m1/windows-spike-2026-08-27.md). Implement these classifications behind `DeviceController` in M2; do not couple product services to individual MCP tool names.

Accept or amend this ADR only after the capability matrix is measured.
