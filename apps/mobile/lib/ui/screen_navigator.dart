import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

const _designWidth = 941.0;
const _designHeight = 1672.0;

enum DevPilotScreen {
  welcome,
  pcPairing,
  projectSelect,
  dashboard,
  livePreview,
  pointAndFix,
  aiProcessing,
  beforeAfter,
  debugConsole,
  testRecorder,
  testResults,
  history,
}

class _Hotspot {
  const _Hotspot({
    required this.id,
    required this.label,
    required this.rect,
    this.target,
    this.back = false,
  });

  final String id;
  final String label;
  final Rect rect;
  final DevPilotScreen? target;
  final bool back;
}

class _ScreenSpec {
  const _ScreenSpec({
    required this.asset,
    required this.verticalGaps,
    required this.hotspots,
  });

  final String asset;
  final List<double> verticalGaps;
  final List<_Hotspot> hotspots;
}

const _screenSpecs = <DevPilotScreen, _ScreenSpec>{
  DevPilotScreen.welcome: _ScreenSpec(
    asset: 'assets/screens/01_welcome.png',
    verticalGaps: [780, 1030, 1380, 1460],
    hotspots: [
      _Hotspot(
        id: 'start',
        label: '始める',
        rect: Rect.fromLTWH(57, 1470, 827, 150),
        target: DevPilotScreen.pcPairing,
      ),
    ],
  ),
  DevPilotScreen.pcPairing: _ScreenSpec(
    asset: 'assets/screens/02_pc_pairing.png',
    verticalGaps: [110, 300, 1160, 1460],
    hotspots: [
      _Hotspot(
        id: 'back',
        label: '戻る',
        rect: Rect.fromLTWH(20, 20, 110, 110),
        back: true,
      ),
      _Hotspot(
        id: 'scan',
        label: 'QRコードを読み取る',
        rect: Rect.fromLTWH(38, 370, 865, 780),
        target: DevPilotScreen.projectSelect,
      ),
      _Hotspot(
        id: 'retry',
        label: 'もう一度試す',
        rect: Rect.fromLTWH(38, 1490, 865, 120),
        target: DevPilotScreen.projectSelect,
      ),
    ],
  ),
  DevPilotScreen.projectSelect: _ScreenSpec(
    asset: 'assets/screens/03_project_select.png',
    verticalGaps: [170, 690, 760, 1025, 1280, 1535],
    hotspots: [
      _Hotspot(
        id: 'select-project',
        label: 'DevShopを選択',
        rect: Rect.fromLTWH(34, 780, 874, 245),
        target: DevPilotScreen.dashboard,
      ),
      _Hotspot(
        id: 'open-project',
        label: 'このプロジェクトを開く',
        rect: Rect.fromLTWH(34, 1535, 874, 115),
        target: DevPilotScreen.dashboard,
      ),
    ],
  ),
  DevPilotScreen.dashboard: _ScreenSpec(
    asset: 'assets/screens/04_dashboard.png',
    verticalGaps: [125, 660, 780, 895, 1015, 1125, 1495],
    hotspots: [
      _Hotspot(
        id: 'history',
        label: '履歴を開く',
        rect: Rect.fromLTWH(35, 20, 340, 100),
        target: DevPilotScreen.history,
      ),
      _Hotspot(
        id: 'test-recorder',
        label: 'Test Recorderを開く',
        rect: Rect.fromLTWH(20, 900, 900, 110),
        target: DevPilotScreen.testRecorder,
      ),
      _Hotspot(
        id: 'debug-console',
        label: 'Debug Consoleを開く',
        rect: Rect.fromLTWH(20, 1010, 900, 120),
        target: DevPilotScreen.debugConsole,
      ),
      _Hotspot(
        id: 'live-preview',
        label: 'Live Previewを開く',
        rect: Rect.fromLTWH(18, 1140, 440, 340),
        target: DevPilotScreen.livePreview,
      ),
      _Hotspot(
        id: 'point-and-fix',
        label: 'Point and Fixを開く',
        rect: Rect.fromLTWH(475, 1140, 445, 340),
        target: DevPilotScreen.pointAndFix,
      ),
    ],
  ),
  DevPilotScreen.livePreview: _ScreenSpec(
    asset: 'assets/screens/05_live_preview.png',
    verticalGaps: [110, 1230],
    hotspots: [
      _Hotspot(
        id: 'back',
        label: 'Dashboardへ戻る',
        rect: Rect.fromLTWH(20, 20, 90, 90),
        back: true,
      ),
      _Hotspot(
        id: 'preview-fix',
        label: 'プレビューからPoint and Fixを開く',
        rect: Rect.fromLTWH(140, 135, 665, 1095),
        target: DevPilotScreen.pointAndFix,
      ),
      _Hotspot(
        id: 'point-and-fix',
        label: 'Point and Fix',
        rect: Rect.fromLTWH(440, 1540, 465, 110),
        target: DevPilotScreen.pointAndFix,
      ),
    ],
  ),
  DevPilotScreen.pointAndFix: _ScreenSpec(
    asset: 'assets/screens/06_point_and_fix.png',
    verticalGaps: [150, 1130],
    hotspots: [
      _Hotspot(
        id: 'close',
        label: 'Live Previewへ戻る',
        rect: Rect.fromLTWH(25, 20, 100, 100),
        back: true,
      ),
      _Hotspot(
        id: 'undo',
        label: '選択を取り消す',
        rect: Rect.fromLTWH(805, 110, 110, 110),
        target: DevPilotScreen.livePreview,
      ),
      _Hotspot(
        id: 'start-fix',
        label: '修正を開始',
        rect: Rect.fromLTWH(40, 1535, 860, 120),
        target: DevPilotScreen.aiProcessing,
      ),
    ],
  ),
  DevPilotScreen.aiProcessing: _ScreenSpec(
    asset: 'assets/screens/07_ai_processing.png',
    verticalGaps: [900, 1240, 1450],
    hotspots: [
      _Hotspot(
        id: 'show-result',
        label: '修正結果を表示',
        rect: Rect.fromLTWH(80, 950, 780, 470),
        target: DevPilotScreen.beforeAfter,
      ),
      _Hotspot(
        id: 'cancel',
        label: '修正をキャンセル',
        rect: Rect.fromLTWH(80, 1470, 780, 115),
        back: true,
      ),
    ],
  ),
  DevPilotScreen.beforeAfter: _ScreenSpec(
    asset: 'assets/screens/08_before_after.png',
    verticalGaps: [120, 1210, 1400, 1520],
    hotspots: [
      _Hotspot(
        id: 'back',
        label: 'Dashboardへ戻る',
        rect: Rect.fromLTWH(20, 20, 100, 100),
        target: DevPilotScreen.dashboard,
      ),
      _Hotspot(
        id: 'files',
        label: '変更した3ファイルを見る',
        rect: Rect.fromLTWH(22, 1410, 895, 100),
        target: DevPilotScreen.debugConsole,
      ),
      _Hotspot(
        id: 'revert',
        label: '元に戻す',
        rect: Rect.fromLTWH(25, 1530, 435, 120),
        target: DevPilotScreen.pointAndFix,
      ),
      _Hotspot(
        id: 'accept',
        label: '修正を採用する',
        rect: Rect.fromLTWH(480, 1530, 435, 120),
        target: DevPilotScreen.dashboard,
      ),
    ],
  ),
  DevPilotScreen.debugConsole: _ScreenSpec(
    asset: 'assets/screens/09_debug_console.png',
    verticalGaps: [90, 760, 1385, 1490],
    hotspots: [
      _Hotspot(
        id: 'back',
        label: 'Dashboardへ戻る',
        rect: Rect.fromLTWH(20, 20, 90, 90),
        target: DevPilotScreen.dashboard,
      ),
      _Hotspot(
        id: 'widget-tree',
        label: 'Test Recorderを開く',
        rect: Rect.fromLTWH(320, 1410, 300, 90),
        target: DevPilotScreen.testRecorder,
      ),
      _Hotspot(
        id: 'analyze',
        label: 'AIで分析',
        rect: Rect.fromLTWH(20, 1530, 520, 115),
        target: DevPilotScreen.aiProcessing,
      ),
      _Hotspot(
        id: 'save',
        label: 'スクリーンショットを保存して履歴へ',
        rect: Rect.fromLTWH(555, 1530, 360, 115),
        target: DevPilotScreen.history,
      ),
    ],
  ),
  DevPilotScreen.testRecorder: _ScreenSpec(
    asset: 'assets/screens/10_test_recorder.png',
    verticalGaps: [120, 760, 900, 1030, 1150, 1270, 1500],
    hotspots: [
      _Hotspot(
        id: 'back',
        label: 'Dashboardへ戻る',
        rect: Rect.fromLTWH(25, 20, 95, 95),
        target: DevPilotScreen.dashboard,
      ),
      _Hotspot(
        id: 'stop',
        label: '記録を停止',
        rect: Rect.fromLTWH(25, 1520, 435, 125),
        target: DevPilotScreen.dashboard,
      ),
      _Hotspot(
        id: 'generate',
        label: 'テストを生成',
        rect: Rect.fromLTWH(480, 1520, 435, 125),
        target: DevPilotScreen.testResults,
      ),
    ],
  ),
  DevPilotScreen.testResults: _ScreenSpec(
    asset: 'assets/screens/11_test_results.png',
    verticalGaps: [100, 540, 780, 1320, 1510],
    hotspots: [
      _Hotspot(
        id: 'back',
        label: 'Test Recorderへ戻る',
        rect: Rect.fromLTWH(20, 20, 95, 95),
        back: true,
      ),
      _Hotspot(
        id: 'share',
        label: '結果を履歴へ共有',
        rect: Rect.fromLTWH(825, 20, 95, 95),
        target: DevPilotScreen.history,
      ),
      _Hotspot(
        id: 'rerun',
        label: 'テストを再実行',
        rect: Rect.fromLTWH(35, 1515, 870, 125),
        target: DevPilotScreen.testRecorder,
      ),
    ],
  ),
  DevPilotScreen.history: _ScreenSpec(
    asset: 'assets/screens/12_history.png',
    verticalGaps: [120, 235, 525, 735, 945, 1155, 1210, 1400, 1580],
    hotspots: [
      _Hotspot(
        id: 'fix-history',
        label: '修正履歴を開く',
        rect: Rect.fromLTWH(70, 320, 840, 200),
        target: DevPilotScreen.beforeAfter,
      ),
      _Hotspot(
        id: 'test-history',
        label: 'テスト履歴を開く',
        rect: Rect.fromLTWH(70, 535, 840, 200),
        target: DevPilotScreen.testResults,
      ),
      _Hotspot(
        id: 'session-history',
        label: 'セッション履歴を開く',
        rect: Rect.fromLTWH(70, 750, 840, 410),
        target: DevPilotScreen.dashboard,
      ),
    ],
  ),
};

class DevPilotScreenNavigator extends StatefulWidget {
  const DevPilotScreenNavigator({super.key});

  @override
  State<DevPilotScreenNavigator> createState() =>
      _DevPilotScreenNavigatorState();
}

class _ResponsiveDesignScreen extends StatelessWidget {
  const _ResponsiveDesignScreen({
    required this.screen,
    required this.spec,
    required this.onBack,
    required this.onOpen,
  });

  final DevPilotScreen screen;
  final _ScreenSpec spec;
  final VoidCallback onBack;
  final ValueChanged<DevPilotScreen> onOpen;

  Widget _ambientBackground() {
    return Positioned.fill(
      child: ImageFiltered(
        imageFilter: ImageFilter.blur(sigmaX: 30, sigmaY: 30),
        child: Transform.scale(
          scale: 1.12,
          child: Image.asset(
            spec.asset,
            fit: BoxFit.cover,
            filterQuality: FilterQuality.medium,
            gaplessPlayback: true,
          ),
        ),
      ),
    );
  }

  Widget _hotspot(_Hotspot hotspot, Rect rect) {
    return Positioned.fromRect(
      rect: rect,
      child: Semantics(
        button: true,
        label: hotspot.label,
        child: GestureDetector(
          key: ValueKey('hotspot-${screen.name}-${hotspot.id}'),
          behavior: HitTestBehavior.opaque,
          onTap: () {
            if (hotspot.back) {
              onBack();
            } else if (hotspot.target case final target?) {
              onOpen(target);
            }
          },
          child: const ColoredBox(color: Colors.transparent),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final height = constraints.maxHeight;
        final scale = width / _designWidth;
        final naturalHeight = _designHeight * scale;
        final extraHeight = height - naturalHeight;

        if (extraHeight <= 0 || spec.verticalGaps.isEmpty) {
          return Stack(
            key: ValueKey('screen-${screen.name}'),
            fit: StackFit.expand,
            children: [
              _ambientBackground(),
              const Positioned.fill(
                child: ColoredBox(color: Color(0x98000000)),
              ),
              Center(
                child: FittedBox(
                  fit: BoxFit.contain,
                  child: SizedBox(
                    width: _designWidth,
                    height: _designHeight,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        Image.asset(
                          spec.asset,
                          fit: BoxFit.fill,
                          filterQuality: FilterQuality.high,
                          gaplessPlayback: true,
                        ),
                        for (final hotspot in spec.hotspots)
                          _hotspot(hotspot, hotspot.rect),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          );
        }

        final gapHeight = extraHeight / spec.verticalGaps.length;
        final boundaries = <double>[0, ...spec.verticalGaps, _designHeight];
        double mapY(double sourceY) {
          final precedingGaps =
              spec.verticalGaps.where((gap) => gap <= sourceY).length;
          return sourceY * scale + precedingGaps * gapHeight;
        }

        return Stack(
          key: ValueKey('screen-${screen.name}'),
          fit: StackFit.expand,
          children: [
            _ambientBackground(),
            const Positioned.fill(child: ColoredBox(color: Color(0xA8000000))),
            for (var index = 0; index < boundaries.length - 1; index++)
              Positioned(
                left: 0,
                top: boundaries[index] * scale + index * gapHeight,
                width: width,
                height: (boundaries[index + 1] - boundaries[index]) * scale,
                child: ClipRect(
                  child: Stack(
                    clipBehavior: Clip.hardEdge,
                    children: [
                      Positioned(
                        left: 0,
                        top: -boundaries[index] * scale,
                        width: width,
                        height: naturalHeight,
                        child: Image.asset(
                          spec.asset,
                          fit: BoxFit.fill,
                          filterQuality: FilterQuality.high,
                          gaplessPlayback: true,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            for (final hotspot in spec.hotspots)
              _hotspot(
                hotspot,
                Rect.fromLTRB(
                  hotspot.rect.left * scale,
                  mapY(hotspot.rect.top),
                  hotspot.rect.right * scale,
                  mapY(hotspot.rect.bottom),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _DevPilotScreenNavigatorState extends State<DevPilotScreenNavigator> {
  DevPilotScreen _current = DevPilotScreen.welcome;
  final List<DevPilotScreen> _history = [];

  void _open(DevPilotScreen target) {
    if (target == _current) return;
    setState(() {
      _history.add(_current);
      _current = target;
    });
  }

  void _goBack() {
    setState(() {
      if (_history.isNotEmpty) {
        _current = _history.removeLast();
      } else if (_current != DevPilotScreen.welcome) {
        _current = DevPilotScreen.welcome;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final spec = _screenSpecs[_current]!;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _goBack();
      },
      child: Scaffold(
        body: SafeArea(
          child: _ResponsiveDesignScreen(
            screen: _current,
            spec: spec,
            onBack: _goBack,
            onOpen: _open,
          ),
        ),
      ),
    );
  }
}
