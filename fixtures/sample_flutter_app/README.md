# sample_flutter_app

Deterministic Flutter target for DevPilot's Point & Fix change flow. It is not
shipped and not part of the pnpm/Flutter workspaces.

Contents kept intentionally small and stable:

- `ValueKey('applyButton')` / `ValueKey('nameField')` / `ValueKey('greetingText')`
  — stable targets for annotation and (later) TestPilot.
- A `Row` (`ValueKey('overflowRow')`) that overflows a narrow phone, so the
  screenshot / Point & Fix path has a real layout defect to point at.
- `String _greeting = 'Hello';` — the single line the CI smoke's fake Codex
  provider rewrites to `'Hi'`, then applies and reverts.

Used by `apps/agent/test/smoke-change-flow.test.ts`:

- default: deterministic, no toolchain — generate → apply → revert.
- `DEVPILOT_SMOKE_WITH_FLUTTER=1` (after `flutter pub get` here): also runs the
  real `dart format` + `flutter analyze` validation gate.

Keep `lib/main.dart` `dart format`-clean and `flutter analyze`-clean; CI enforces
both.
