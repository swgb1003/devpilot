import 'package:flutter/services.dart';

class OverlayStatus {
  const OverlayStatus({required this.permissionGranted, required this.visible});

  final bool permissionGranted;
  final bool visible;

  factory OverlayStatus.fromMap(Map<Object?, Object?> value) => OverlayStatus(
    permissionGranted: value['permissionGranted'] == true,
    visible: value['visible'] == true,
  );
}

class OverlaySelection {
  const OverlaySelection({
    required this.x,
    required this.y,
    required this.instruction,
    required this.selectedAt,
  });

  final double x;
  final double y;
  final String instruction;
  final DateTime selectedAt;

  factory OverlaySelection.fromMap(Map<Object?, Object?> value) =>
      OverlaySelection(
        x: (value['x'] as num).toDouble(),
        y: (value['y'] as num).toDouble(),
        instruction: value['instruction'] as String,
        selectedAt: DateTime.fromMillisecondsSinceEpoch(value['selectedAt'] as int),
      );
}

class FloatingControl {
  static const _channel = MethodChannel('devpilot/overlay');

  static void setSelectionHandler(
    Future<void> Function(OverlaySelection selection) handler,
  ) {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'selection' && call.arguments is Map<Object?, Object?>) {
        await handler(OverlaySelection.fromMap(call.arguments as Map<Object?, Object?>));
      }
    });
  }

  static Future<OverlayStatus> status() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>('status');
    return OverlayStatus.fromMap(result ?? const {});
  }

  /// Opens Android Settings when the user has not yet granted overlay access.
  static Future<bool> requestPermission() async =>
      await _channel.invokeMethod<bool>('requestPermission') ?? false;

  static Future<bool> show() async =>
      await _channel.invokeMethod<bool>('show') ?? false;

  static Future<void> hide() => _channel.invokeMethod<void>('hide');

  static Future<OverlaySelection?> consumeSelection() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>(
      'consumeSelection',
    );
    return result == null ? null : OverlaySelection.fromMap(result);
  }
}
