import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sample_flutter_app/main.dart';

void main() {
  testWidgets('Apply updates the greeting from the name field', (tester) async {
    await tester.pumpWidget(const SampleApp());

    await tester.enterText(find.byKey(const ValueKey('nameField')), 'Flutter');
    await tester.tap(find.byKey(const ValueKey('applyButton')));
    await tester.pump();

    expect(
      tester.widget<Text>(find.byKey(const ValueKey('greetingText'))).data,
      'Hello, Flutter',
    );
  });
}
