import 'dart:io';
import 'dart:ui' show Offset, Size;

import 'package:devpilot_mobile/main.dart';
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

  testWidgets('walks through the primary design flow', (tester) async {
    await tester.pumpWidget(const DevPilotApp());

    expect(find.byKey(const ValueKey('screen-welcome')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('hotspot-welcome-start')));
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-pcPairing')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('hotspot-pcPairing-scan')));
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-projectSelect')), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('hotspot-projectSelect-open-project')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-dashboard')), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('hotspot-dashboard-live-preview')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-livePreview')), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('hotspot-livePreview-point-and-fix')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-pointAndFix')), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('hotspot-pointAndFix-start-fix')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-aiProcessing')), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('hotspot-aiProcessing-show-result')),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('screen-beforeAfter')), findsOneWidget);
  });

  testWidgets('dashboard shortcuts expose debug, test, and history screens', (
    tester,
  ) async {
    await tester.pumpWidget(const DevPilotApp());
    await tester.tap(find.byKey(const ValueKey('hotspot-welcome-start')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('hotspot-pcPairing-scan')));
    await tester.pump();
    await tester.tap(
      find.byKey(const ValueKey('hotspot-projectSelect-open-project')),
    );
    await tester.pump();

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
}
