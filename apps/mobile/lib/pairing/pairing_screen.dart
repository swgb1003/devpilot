import 'dart:async';

import 'package:devpilot_mobile/pairing/pairing_repository.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class PairingScreen extends StatefulWidget {
  const PairingScreen({
    super.key,
    required this.onBack,
    required this.onPaired,
    this.skipReconnect = false,
    this.repository,
  });

  final VoidCallback onBack;
  final VoidCallback onPaired;
  final bool skipReconnect;
  final PairingRepository? repository;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen>
    with WidgetsBindingObserver {
  late final PairingRepository _repository;
  late final MobileScannerController _scannerController;
  Timer? _approvalTimer;
  bool _isScanning = false;
  bool _isSubmitting = false;
  bool _awaitingApproval = false;
  String _message =
      'PCのDevPilot Desktopで「Show pairing QR」を押して、QRコードを読み取ってください。';
  Color _messageColor = const Color(0xFFB7C5DD);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _repository = widget.repository ?? PairingRepository();
    _scannerController = MobileScannerController(autoStart: false);
    if (!widget.skipReconnect) unawaited(_restoreConnection());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _approvalTimer?.cancel();
    _scannerController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_isScanning) return;
    if (state == AppLifecycleState.resumed) {
      unawaited(_scannerController.start());
    } else if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused) {
      unawaited(_scannerController.stop());
    }
  }

  Future<void> _restoreConnection() async {
    final connected = await _repository.reconnect();
    if (!mounted || !connected) return;
    widget.onPaired();
  }

  Future<void> _beginScanning() async {
    setState(() {
      _message = 'カメラのQRコードを枠内に合わせてください。';
      _messageColor = const Color(0xFFB7C5DD);
      _isScanning = true;
    });
    try {
      await _scannerController.start();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isScanning = false;
        _message = 'カメラを開始できません。Androidの設定でカメラ権限を許可してください。';
        _messageColor = const Color(0xFFFF8E9B);
      });
    }
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_isSubmitting || capture.barcodes.isEmpty) return;
    final rawValue = capture.barcodes.first.rawValue;
    if (rawValue == null || rawValue.isEmpty) return;
    _isSubmitting = true;
    await _scannerController.stop();
    try {
      final payload = PairingQrPayload.parse(rawValue);
      if (!mounted) return;
      setState(() {
        _isScanning = false;
        _message = 'PCの証明書を確認しています…';
      });
      await _repository.startPairing(payload);
      if (!mounted) return;
      setState(() {
        _awaitingApproval = true;
        _message = 'PCに端末の承認リクエストを送りました。Desktopでこの端末を承認してください。';
        _messageColor = const Color(0xFF51E6A4);
      });
      _approvalTimer?.cancel();
      _approvalTimer = Timer.periodic(const Duration(seconds: 2), (_) {
        unawaited(_pollApproval());
      });
      await _pollApproval();
    } on PairingException catch (error) {
      if (!mounted) return;
      setState(() {
        _isScanning = false;
        _message = error.message;
        _messageColor = const Color(0xFFFF8E9B);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isScanning = false;
        _message = 'QRコードの読み取りに失敗しました。もう一度試してください。';
        _messageColor = const Color(0xFFFF8E9B);
      });
    } finally {
      _isSubmitting = false;
    }
  }

  Future<void> _pollApproval() async {
    if (!_awaitingApproval || _isSubmitting) return;
    _isSubmitting = true;
    try {
      final result = await _repository.pollPendingPairing();
      if (!mounted) return;
      if (result.isPaired) {
        _approvalTimer?.cancel();
        setState(() {
          _awaitingApproval = false;
          _message = '安全な接続を確認しました。プロジェクトを選択します。';
          _messageColor = const Color(0xFF51E6A4);
        });
        await Future<void>.delayed(const Duration(milliseconds: 500));
        if (mounted) widget.onPaired();
      }
    } on PairingException catch (error) {
      if (!mounted) return;
      _approvalTimer?.cancel();
      setState(() {
        _awaitingApproval = false;
        _message = error.message;
        _messageColor = const Color(0xFFFF8E9B);
      });
    } finally {
      _isSubmitting = false;
    }
  }

  Future<void> _unpair() async {
    await _repository.unpair();
    if (!mounted) return;
    setState(() {
      _awaitingApproval = false;
      _message = 'PCとの接続情報を端末から削除しました。';
      _messageColor = const Color(0xFFB7C5DD);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const ValueKey('screen-pcPairing'),
      backgroundColor: const Color(0xFF080A0F),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
          child: Column(
            children: [
              Row(
                children: [
                  IconButton(
                    onPressed:
                        _isScanning
                            ? () => setState(() => _isScanning = false)
                            : widget.onBack,
                    icon: const Icon(Icons.arrow_back_ios_new_rounded),
                    tooltip: '戻る',
                  ),
                  const Expanded(
                    child: Text(
                      'PCと接続',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(width: 48),
                ],
              ),
              const SizedBox(height: 22),
              Text(
                _awaitingApproval ? 'PCで承認してください' : 'QRコードを枠内に合わせてください',
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 14),
              Expanded(
                child: Container(
                  width: double.infinity,
                  decoration: BoxDecoration(
                    border: Border.all(
                      color: const Color(0xFF1A65D8),
                      width: 1.4,
                    ),
                    borderRadius: BorderRadius.circular(24),
                    color: const Color(0xFF101721),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x5A005BFF),
                        blurRadius: 32,
                        spreadRadius: 1,
                      ),
                    ],
                  ),
                  clipBehavior: Clip.antiAlias,
                  child:
                      _isScanning
                          ? Stack(
                            fit: StackFit.expand,
                            children: [
                              MobileScanner(
                                controller: _scannerController,
                                onDetect: _onDetect,
                              ),
                              const _ScanCorners(),
                            ],
                          )
                          : const _PairingIllustration(),
                ),
              ),
              const SizedBox(height: 18),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  color: const Color(0xFF11151D),
                  border: Border.all(color: const Color(0xFF28354A)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.verified_user_outlined, color: _messageColor),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        _message,
                        style: TextStyle(color: _messageColor, height: 1.45),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                height: 54,
                child: FilledButton.icon(
                  onPressed: _awaitingApproval ? null : _beginScanning,
                  icon: const Icon(Icons.qr_code_scanner_rounded),
                  label: Text(_isScanning ? 'QRコードを読み取り中…' : 'QRコードを読み取る'),
                ),
              ),
              TextButton(onPressed: _unpair, child: const Text('この端末の接続情報を削除')),
            ],
          ),
        ),
      ),
    );
  }
}

class _PairingIllustration extends StatelessWidget {
  const _PairingIllustration();

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        const DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              colors: [Color(0xFF0D356D), Color(0xFF080A0F)],
              radius: 1.1,
            ),
          ),
        ),
        Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: const [
                Icon(
                  Icons.qr_code_2_rounded,
                  size: 132,
                  color: Color(0xFF77A9FF),
                ),
                SizedBox(height: 18),
                Icon(Icons.lan_rounded, size: 50, color: Color(0xFF51E6A4)),
                SizedBox(height: 12),
                Text(
                  'DevPilot Desktop',
                  style: TextStyle(fontSize: 21, fontWeight: FontWeight.w800),
                ),
                SizedBox(height: 6),
                Text(
                  '同じWi-Fi上のPCを安全に確認します',
                  style: TextStyle(color: Color(0xFFB7C5DD)),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _ScanCorners extends StatelessWidget {
  const _ScanCorners();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Center(
        child: Container(
          width: 236,
          height: 236,
          decoration: BoxDecoration(
            border: Border.all(color: const Color(0xFF7CB1FF), width: 3),
            borderRadius: BorderRadius.circular(24),
            boxShadow: const [
              BoxShadow(color: Color(0x700052FF), blurRadius: 22),
            ],
          ),
        ),
      ),
    );
  }
}
