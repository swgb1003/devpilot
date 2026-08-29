# Local setup runbook

1. Install the versions recorded in `tool-versions.json` and `rust-toolchain.toml`.
2. Run `pnpm toolchain:check`.
3. Run `pnpm install --frozen-lockfile` from the repository root.
4. Create `apps/mobile/android/local.properties` with escaped Windows paths for `sdk.dir` and `flutter.sdk`.
5. Run Node checks and the Desktop web shell.
6. Run `flutter pub get`, `flutter analyze`, and `flutter test` from `apps/mobile`.
7. Run `cargo check --locked` from `apps/desktop/src-tauri`.

M1 records the local capability table through `GET http://127.0.0.1:47831/m1/report`. Start the Agent with `pnpm --filter @devpilot/agent start`, then open the Desktop M1 screen or call the endpoint directly.

M1 has measured ADB and Flutter MCP screenshots on a physical authorized Android device. To reproduce the Flutter MCP interaction evidence, launch the debug app with the Driver extension only for that session:

```powershell
Set-Location apps/mobile
flutter run -d <deviceId> --dart-define=ENABLE_FLUTTER_DRIVER=true
```

The `ENABLE_FLUTTER_DRIVER` flag is off by default, so production builds do not enable the extension.
