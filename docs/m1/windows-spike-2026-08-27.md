# M1 Windows technical-spike evidence

Date: 2026-08-27

Updated: 2026-08-28

## What was exercised

- A Tauri-owned Node sidecar starts from `apps/agent/dist/index.js`, detects an unexpected exit, performs one automatic restart, and stops its child process on request and application shutdown.
- The Agent generates a fresh loopback-only self-signed certificate, serves one HTTPS request on `127.0.0.1`, and returns the SHA-256 certificate fingerprint and round-trip latency.
- The Agent probes Flutter MCP, Flutter CLI, and ADB without treating tool discovery as proof that a real Android capability is available.

## Measured environment

| Surface                | Result      | Evidence                                                                                                                                                          |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node sidecar lifecycle | Pass        | Rust test starts, kills, restarts once, and stops a real Node Agent child process.                                                                                |
| Local TLS              | Pass        | HTTPS loopback round trip succeeded in 14-28 ms with a newly generated SHA-256 fingerprint. The certificate is ephemeral and never persisted.                     |
| Flutter CLI            | Available   | Flutter 3.29.3 / Dart 3.7.2. `flutter --version` completed in 6,846 ms; `flutter devices --machine` completed in 794 ms. No authorized Android target was listed. |
| Flutter MCP            | Unavailable | `dart mcp-server --help` exited 64 because Dart 3.7.2 has no `mcp-server` command. The current official MCP documentation requires Dart 3.9 or later.             |
| ADB                    | Degraded    | Android platform-tools 35.0.2 is installed. No authorized Android device was available for a screenshot or latency measurement.                                   |

## SDK update and fresh probe

The Flutter SDK was updated after the initial measurement to Flutter 3.47.1 / Dart 3.13.1. This meets the Dart 3.9+ prerequisite for the official Flutter MCP server. The fresh `GET /m1/report` result is:

| Surface     | Result    | Evidence                                                                                                                                                                                                                                                                                           |
| ----------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flutter CLI | Available | `flutter devices --machine` completed in 763 ms and listed the local desktop/browser targets.                                                                                                                                                                                                      |
| Flutter MCP | Degraded  | `dart mcp-server --help` accepted the stdio server command and remained waiting for a JSON-RPC handshake (no stderr). Candidate operations are screenshot, Hot Reload, widget tree, runtime errors, tap, text input, and scroll; their exact tool names and responses require a running debug app. |
| ADB         | Degraded  | No authorized Android device is connected.                                                                                                                                                                                                                                                         |

## Real Android measurement

An authorized `motorola razr 60s` was connected over USB on 2026-08-28. The current `GET /m1/report` measurement records:

| Surface     | Result    | Evidence                                                                                                                                                                                                                                                                                 |
| ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flutter CLI | Available | Flutter 3.47.1 / Dart 3.13.1. `flutter devices --machine` completed in 620 ms and included the Android target.                                                                                                                                                                           |
| ADB         | Available | `adb exec-out screencap -p` returned a valid 1080x2640 PNG in 382 ms. The probe validates metadata only; it does not store or return the image bytes.                                                                                                                                    |
| Flutter MCP | Available | With the Mobile app launched using `--dart-define=ENABLE_FLUTTER_DRIVER=true`, MCP discovered and connected to the Flutter app through DTD, then `flutter_driver_command` returned a PNG screenshot response. The image response was inspected for format and size only, then discarded. |

## Real Flutter MCP interaction

With the Driver extension enabled, the Dart MCP server returned 14 tools: `dtd`, `flutter_driver_command`, `get_runtime_errors`, `hot_reload`, `hot_restart`, `widget_inspector`, `vm_service`, `analyze_files`, `lsp`, `pub`, `pub_dev_search`, `read_package_uris`, `rip_grep_packages`, and `roots`.

The `dtd` tool discovered the Mobile workspace daemon and connected to `devpilot_mobile` running on the authorized `motorola razr 60s`. A `flutter_driver_command` screenshot returned `image/png` content (152,632 base64 characters). The probe did not write that image to disk or return it through the DevPilot Agent endpoint.

## Timeout, retry, and mismatch evidence

| Case                      | Observed result                                                                                                                                                 | M1 classification                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Driver wait timeout       | A `waitFor` request for an intentionally absent text with a 100 ms timeout returned `isError: true` in 308 ms: `Timed out waiting for Flutter Driver response.` | Retryable only for an idempotent inspection action after bounded backoff. A following screenshot request succeeded in 922 ms.          |
| Incorrect app URI         | A screenshot request using a deliberately invalid app URI returned `isError: true` in 1 ms and instructed the client to use `dtd listConnectedApps`.            | Not retryable against the same URI. Refresh DTD discovery, select an available app URI, then retry. The valid URI succeeded in 826 ms. |
| Production authentication | M1 has no pairing identity or production authentication surface by design.                                                                                      | Deferred to M2; do not treat the local debug transport as authentication evidence.                                                     |

## Decision boundary

M1 validates the development-mode boundaries, not the M2 product protocol:

- The loopback TLS probe does not create a pairing identity, persist a certificate, open a LAN port, or bypass certificate validation for a Mobile client.
- The updated Flutter SDK exposes the MCP stdio server, and a Driver-enabled Flutter debug app confirmed the JSON-RPC tool surface, DTD discovery, and screenshot interaction. Flutter CLI remains the confirmed path for `deviceList`, `runApp`, and managed-stdin Hot Reload; ADB remains the independent fallback for screenshots.
- The device-capability table contains real ADB and Flutter MCP screenshot evidence, along with timeout, retry, and application-URI mismatch behavior. Production authentication remains a separate M2 concern.
- Production Node packaging, installer/upgrade/uninstall behavior, and firewall behavior remain open technical decisions. The M1 sidecar is a development-mode implementation that makes those requirements measurable.

## Reproduce

```powershell
pnpm --filter @devpilot/contracts build
pnpm --filter @devpilot/agent build
pnpm --filter @devpilot/agent start

Invoke-RestMethod http://127.0.0.1:47831/m1/report | ConvertTo-Json -Depth 8

Set-Location apps/desktop/src-tauri
cargo test --locked
```
