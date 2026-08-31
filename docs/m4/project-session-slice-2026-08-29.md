# M4 Project / Session slice

M4 adds the first real development-session boundary after M3 pairing.

- Desktop can register a Flutter project root only when `pubspec.yaml` exists.
- The Agent persists projects and sessions in SQLite and records registration/start/stop Activity events.
- Preflight checks the project, Flutter availability, Android device discovery, and Git state before a session can start.
- Exactly one Agent-managed `flutter run -d <device>` session is supported at a time. A new start stops a prior active session.
- Mobile reads only paired-device APIs: project list, Android device list, current session, and session start/stop. The Project Select screen now uses those APIs.

The preflight intentionally blocks `flutter run` when Flutter or an authorized Android device is unavailable. M5 owns screenshot capture and adapter routing; M4 does not claim screenshot support.
