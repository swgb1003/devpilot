# M2 Agent core implementation record

Date: 2026-08-28

## Outcome

M2 establishes the local Agent foundation required by later DevPilot milestones. It also turns all 12 supplied Mobile designs into a connected visual prototype so the intended product flow can be reviewed on the target Android device now.

## Implemented

- Strict loopback Agent configuration with validated port, retention, data directory, and Desktop token.
- Versioned SQLite schema for pairings, projects, sessions, jobs, approvals, activities, and test metadata.
- Persistent Activity append, list, retention purge, subscription, and newest-first query behavior.
- Common success and structured error envelopes with stable codes, retryability, recovery action, and trace ID.
- Authenticated `/api/v1/config`, `/api/v1/activities`, and `/api/v1/ws-tickets` routes.
- Dependency-free WebSocket upgrade and server event framing with expiring, single-use tickets.
- Desktop M2 status presentation while retaining M1 capability evidence.
- All supplied screens `01_welcome.png` through `12_history.png`, rendered at their original 941×1672 design coordinate system with semantic interactive hotspots and Android back navigation.

## Mobile visual flow

```text
Welcome → PC pairing → Project select → Dashboard
                                      ├─ Live Preview → Point & Fix → AI → Before/After
                                      ├─ Debug Console
                                      ├─ Test Recorder → Test Results
                                      └─ History
```

The reference PNG is rendered as responsive horizontal sections. Each section keeps the source aspect ratio, typography, colors, illustrations, and effects; the additional height of a tall Android screen is distributed only through the dark spacing between those sections. This places the first and last sections near the safe-area edges without stretching or cropping content. Semantic hit targets use the same piecewise transform and remain aligned with the designed controls.

## Verification contract

- Contracts: 1 test passed.
- Agent: 11 tests passed, including loopback configuration, SQLite migration/retention, authorization, Activity persistence, single-use WebSocket ticket/event delivery, and the HTTPS server surface.
- Desktop: React/TypeScript typecheck and Vite production build passed.
- Tauri: `cargo fmt --check` and 2 Rust sidecar lifecycle tests passed on Rust 1.98.0.
- Mobile: `flutter analyze` reports no issues; 4 Flutter tests passed. The test suite verifies tall phones have no vertical letterboxing, all 12 bundled PNG files are byte-identical to the supplied originals, and the primary, debug, test, and history branches are traversable.
- Physical `motorola razr 60s` (`ZY22LS2QG5`): debug APK built and installed; Welcome and PC Pairing rendered correctly at 1080×2640; tapping Start navigated to PC Pairing and Android back returned to Welcome.
- Runtime Agent: Core 0.2.0 started with persistent SQLite schema 1; authenticated config/Activity requests succeeded and exposed `/api/v1/events`.

## Explicitly deferred

- QR camera scanning and real Desktop approval.
- Mobile credential issuance, storage, revocation, and TLS certificate trust.
- Real project discovery/registration, session control, provider execution, code modification, Hot Reload, widget inspection, screenshot comparison, and generated test execution.

Those operations are represented only by the interactive UI shell and must not be interpreted as completed product behavior. M3 is the next implementation slice.
