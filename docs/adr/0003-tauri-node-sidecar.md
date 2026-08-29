# ADR 0003: Tauri and Node sidecar packaging

- Status: Partially validated; production packaging decision pending
- Date: 2026-08-26

## Proposed decision

Keep Rust as a minimal Tauri shell. Package the TypeScript Agent as a separately supervised sidecar with a pinned Node runtime or single executable. Preserve a future headless Agent entry point.

## M1 evidence required

- Start, graceful stop, forced termination, crash detection, and one automatic restart
- Cleanup of Agent child processes, including managed `flutter run`
- Installed-path discovery and argument quoting on Windows
- Installer, upgrade, uninstall, and diagnostic behavior

## 2026-08-27 Windows spike

The Tauri supervisor starts the compiled Node Agent, detects a forced exit, automatically restarts it once, and stops it on request. This is covered by a Rust test that uses a real child process.

Development mode currently requires Node.js on PATH and `apps/agent/dist/index.js`. A pinned bundled runtime or a single executable, installed-path discovery, installer behavior, and diagnostics remain open before this ADR can be accepted.

See [`docs/m1/windows-spike-2026-08-27.md`](../m1/windows-spike-2026-08-27.md).
