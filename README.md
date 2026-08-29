# DevPilot

DevPilot turns an Android device running a development Flutter app into a safe remote control for an AI-assisted edit, validation, and Hot Reload loop.

This repository is currently at **M3: Pairing slice**. Product behavior is defined by `docs/DevPilot_開発仕様書_v1.0.docx`; M3 adds real QR pairing, a Mobile camera scanner, Desktop approval, certificate-fingerprint pinning, Android Keystore token storage, reconnect, and unpair. Project registration and edit/test execution remain later milestones.

## Workspace

```text
apps/
  mobile/       Flutter Android app
  desktop/      Tauri 2 + React desktop shell
  agent/        TypeScript/Node.js local agent
packages/
  contracts/    Shared protocol types (future Zod/OpenAPI source)
  config/       Shared tool configuration
  test-kit/     Deterministic fixtures and fakes
docs/
  architecture/ adr/ api/ security/ runbooks/
```

## Prerequisites

The validated versions are recorded in `tool-versions.json`, `.nvmrc`, and `rust-toolchain.toml`.

- Node.js 24.x and pnpm 11.19.0
- Flutter 3.47.1 / Dart 3.13.1
- Java 17 and Android SDK 35
- Rust MSVC 1.98.0
- Windows WebView2 runtime for Tauri

Run the non-mutating setup check:

```powershell
pnpm toolchain:check
```

## Install

```powershell
$env:CI='true'
pnpm install --frozen-lockfile

Set-Location apps/mobile
flutter pub get
```

`apps/mobile/android/local.properties` is machine-local and intentionally ignored. It must contain `flutter.sdk` and `sdk.dir`.

## Run

```powershell
# Agent health endpoint: http://127.0.0.1:47831/health
pnpm dev:agent

# React shell in a browser
pnpm dev:desktop:web

# Native Tauri shell
pnpm dev:desktop

# Android app
Set-Location apps/mobile
flutter run -d <deviceId>

# Android app with the Flutter MCP Driver extension enabled
flutter run -d <deviceId> --dart-define=ENABLE_FLUTTER_DRIVER=true
```

## Verify

```powershell
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @devpilot/desktop build:web

Set-Location apps/mobile
flutter analyze
flutter test

Set-Location ../desktop/src-tauri
cargo check --locked
```

## M3 pairing

Start the Agent, then open DevPilot Desktop and choose **Show pairing QR**. DevPilot Mobile scans that one-time QR, verifies the Agent certificate fingerprint, and waits for the Desktop approval action. The Agent keeps its Desktop control API on `127.0.0.1:47831` and opens its TLS-only Mobile pairing API on private LAN interfaces at port `47832` by default.

The pairing QR is valid for 120 seconds and one successful confirmation. Five invalid nonce attempts expire it. The Mobile access and refresh tokens are issued only after Desktop approval, then stored in Android Keystore. Use **この端末の接続情報を削除** on Mobile to revoke the Agent-side tokens and delete local credentials.

## M2 Agent API

The Agent binds only to `127.0.0.1`. Product routes require a Desktop bearer token of at least 32 characters:

```powershell
$env:DEVPILOT_DESKTOP_TOKEN='replace-with-a-random-token-at-least-32-characters'
pnpm dev:agent

$headers = @{ Authorization = "Bearer $env:DEVPILOT_DESKTOP_TOKEN" }
Invoke-RestMethod http://127.0.0.1:47831/api/v1/config -Headers $headers
Invoke-RestMethod http://127.0.0.1:47831/api/v1/activities -Headers $headers
```

Persistent state is stored in `.devpilot-data/devpilot.sqlite3` by default. See [`docs/m2/agent-core-2026-08-28.md`](docs/m2/agent-core-2026-08-28.md) and [`docs/api/README.md`](docs/api/README.md).

## M1 capability evidence

Start the compiled Agent and request its local evidence report:

```powershell
pnpm --filter @devpilot/contracts build
pnpm --filter @devpilot/agent build
pnpm --filter @devpilot/agent start

Invoke-RestMethod http://127.0.0.1:47831/m1/report | ConvertTo-Json -Depth 8
```

The Desktop M1 screen displays the same result. A physical authorized Android device has completed the ADB and Flutter MCP screenshot measurements. Launch the app with `ENABLE_FLUTTER_DRIVER=true` when reproducing the MCP interaction evidence. See [`docs/m1/windows-spike-2026-08-27.md`](docs/m1/windows-spike-2026-08-27.md).

## Milestone boundary

M2 provides the safe local foundation and a visually complete, interactive Mobile prototype. Pairing credentials, QR scanning, project registration, provider execution, Hot Reload, Point & Fix, and test recording are deliberately not presented as live capabilities until their milestone implementations are complete.
