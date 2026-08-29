import 'dart:io';
import 'dart:ui' show Offset, Size;

import 'package:devpilot_mobile/main.dart';
import 'package:devpilot_mobile/pairing/pairing_repository.dart';
import 'package:devpilot_mobile/ui/screen_navigator.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'fills a tall phone with an undistorted foreground and ambient background',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(432, 960));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(const DevPilotApp());

      final screen = find.byKey(const ValueKey('screen-welcome'));
      expect(tester.getTopLeft(screen), Offset.zero);
      expect(tester.getBottomRight(screen), const Offset(432, 960));
    },
  );

  test('bundled screens are byte-identical to all 12 supplied designs', () {
    const filenames = [
      '01_welcome.png',
      '02_pc_pairing.png',
      '03_project_select.png',
      '04_dashboard.png',
      '05_live_preview.png',
      '06_point_and_fix.png',
      '07_ai_processing.png',
      '08_before_after.png',
      '09_debug_console.png',
      '10_test_recorder.png',
      '11_test_results.png',
      '12_history.png',
    ];

    for (final filename in filenames) {
      final supplied = File('../../DevPilot_UI_12screens/$filename');
      final bundled = File('assets/screens/$filename');
      expect(
        supplied.existsSync(),
        isTrue,
        reason: 'Missing supplied $filename',
      );
      expect(bundled.existsSync(), isTrue, reason: 'Missing bundled $filename');
      expect(
        listEquals(supplied.readAsBytesSync(), bundled.readAsBytesSync()),
        isTrue,
        reason: '$filename was changed while bundling',
      );
    }
  });

  testWidgets('opens the real M3 pairing screen from Welcome', (tester) async {
    await tester.pumpWidget(const DevPilotApp());

    expect(find.byKey(const ValueKey('screen-welcome')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('hotspot-welcome-start')));
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-pcPairing')), findsOneWidget);
    expect(find.text('QRコードを読み取る'), findsOneWidget);
  });

  testWidgets('dashboard shortcuts expose debug, test, and history screens', (
    tester,
  ) async {
    await tester.pumpWidget(
      const DevPilotApp(initialScreen: DevPilotScreen.dashboard),
    );

    await tester.tap(
      find.byKey(const ValueKey('hotspot-dashboard-debug-console')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-debugConsole')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('hotspot-debugConsole-back')));
    await tester.pump();

    await tester.tap(
      find.byKey(const ValueKey('hotspot-dashboard-test-recorder')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-testRecorder')), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('hotspot-testRecorder-generate')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-testResults')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('hotspot-testResults-share')));
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-history')), findsOneWidget);
  });

  test('accepts only a current DevPilot QR on a private LAN address', () {
    final payload = PairingQrPayload.parse('''
      {"scheme":"devpilot","version":1,"pairingId":"pair-1",
       "hostCandidates":["192.168.1.20","8.8.8.8"],"port":47832,
       "nonce":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
       "expiresAt":"2099-01-01T00:00:00.000Z",
       "serverPublicKeyFingerprint":"sha256/ABCDEF"}
    ''');

    expect(payload.hostCandidates, ['192.168.1.20']);
    expect(payload.port, 47832);
    expect(
      () => PairingQrPayload.parse('{"scheme":"http"}'),
      throwsA(isA<PairingException>()),
    );
  });
}
