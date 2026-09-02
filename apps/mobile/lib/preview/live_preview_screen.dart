import 'dart:typed_data';

import 'package:devpilot_mobile/overlay/floating_control.dart';
import 'package:devpilot_mobile/pairing/pairing_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class LivePreviewScreen extends StatefulWidget {
  const LivePreviewScreen({
    super.key,
    required this.onBack,
  });

  final VoidCallback onBack;

  @override
  State<LivePreviewScreen> createState() => _LivePreviewScreenState();
}

class _LivePreviewScreenState extends State<LivePreviewScreen>
    with WidgetsBindingObserver {
  final PairingRepository _repository = PairingRepository();
  Uint8List? _image;
  PreviewArtifact? _artifact;
  String? _error;
  bool _refreshing = false;
  bool _overlayVisible = false;
  OverlaySelection? _pendingSelection;
  FixRequest? _fixRequest;
  ChangeSet? _changeSet;
  bool _submittingFix = false;
  String? _fixError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    FloatingControl.setSelectionHandler(_createFixFromOverlay);
    _refresh();
    _restoreLatestChangeSet();
    _readOverlayStatus();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _readOverlayStatus();
  }

  Future<void> _readOverlayStatus() async {
    try {
      final status = await FloatingControl.status();
      final selection = await FloatingControl.consumeSelection();
      if (mounted) {
        setState(() {
          _overlayVisible = status.visible;
          if (selection != null) _pendingSelection = selection;
        });
      }
    } on PlatformException {
      // Android以外ではフローティング操作を利用しません。
    }
  }

  Future<void> _toggleFloatingControl() async {
    try {
      final status = await FloatingControl.status();
      if (status.visible) {
        await FloatingControl.hide();
        if (mounted) setState(() => _overlayVisible = false);
        return;
      }
      if (!status.permissionGranted) {
        await FloatingControl.requestPermission();
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('設定画面で「他のアプリの上に表示」を許可後、もう一度このボタンを押してください。'),
          ),
        );
        return;
      }
      final shown = await FloatingControl.show();
      if (!mounted) return;
      setState(() => _overlayVisible = shown);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('hamoloを開くと、画面上の「DP」ボタンから修正箇所を指定できます。'),
        ),
      );
    } on PlatformException {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('フローティング操作を開始できませんでした。')),
      );
    }
  }

  Future<void> _startPointAndFix() async {
    try {
      if ((await FloatingControl.status()).visible) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('hamolo を開き、画面上の DP ボタンから修正箇所を選択してください。')),
        );
        return;
      }
      await _toggleFloatingControl();
    } on PlatformException {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Point & Fix を開始できませんでした。')),
      );
    }
  }

  Future<void> _createFixFromOverlay(OverlaySelection selection) async {
    if (_submittingFix) return;
    if (mounted) {
      setState(() {
        _pendingSelection = selection;
        _submittingFix = true;
        _fixError = null;
      });
    }
    try {
      final session = await _repository.currentSession();
      if (session == null || session.state != 'running') {
        throw const PairingException('実行中のFlutter開発セッションがありません。');
      }
      // This callback is delivered while hamolo remains foreground. Therefore
      // the Agent captures the inspected app rather than DevPilot itself.
      final artifact = await _repository.captureSessionScreenshot(session.id);
      final image = await _repository.previewImage(artifact.id);
      final fixRequest = await _repository.createFixRequest(
        sessionId: session.id,
        screenshotId: artifact.id,
        instruction: selection.instruction,
        x: (selection.x / artifact.width).clamp(0, 1).toDouble(),
        y: (selection.y / artifact.height).clamp(0, 1).toDouble(),
      );
      if (!mounted) return;
      setState(() {
        _artifact = artifact;
        _image = image;
        _fixRequest = fixRequest;
      });
    } on PairingException catch (error) {
      if (mounted) setState(() => _fixError = error.message);
    } catch (_) {
      if (mounted) {
        setState(() => _fixError = '修正指示を作成できませんでした。もう一度対象箇所を選択してください。');
      }
    } finally {
      if (mounted) setState(() => _submittingFix = false);
    }
  }

  Future<void> _approveFix() async {
    final request = _fixRequest;
    if (request == null || _submittingFix) return;
    setState(() {
      _submittingFix = true;
      _fixError = null;
    });
    try {
      final approved = await _repository.approveFixRequest(request.id);
      if (mounted) setState(() => _fixRequest = approved);
    } on PairingException catch (error) {
      if (mounted) setState(() => _fixError = error.message);
    } finally {
      if (mounted) setState(() => _submittingFix = false);
    }
  }

  Future<void> _generateProposal() async {
    final request = _fixRequest;
    if (request == null || request.state != 'approved' || _submittingFix) return;
    setState(() {
      _submittingFix = true;
      _fixError = null;
    });
    try {
      final proposal = await _repository.generateChangeProposal(request.id);
      if (mounted) setState(() => _changeSet = proposal);
    } on PairingException catch (error) {
      if (!await _restoreLatestChangeSet() && mounted) {
        setState(() => _fixError = error.message);
      }
    } finally {
      if (mounted) setState(() => _submittingFix = false);
    }
  }

  Future<void> _applyProposal() async {
    final proposal = _changeSet;
    if (proposal == null || proposal.state != 'proposed' || _submittingFix) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('修正案を適用しますか？'),
        content: Text('${proposal.files.length} 個の既存 Dart ファイルだけを更新します。M8 で解析とホットリロードを行います。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('キャンセル')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('適用する')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _submittingFix = true;
      _fixError = null;
    });
    try {
      final applied = await _repository.applyChangeSet(proposal.id);
      if (mounted) setState(() => _changeSet = applied);
    } on PairingException catch (error) {
      if (!await _restoreLatestChangeSet() && mounted) {
        setState(() => _fixError = error.message);
      }
    } finally {
      if (mounted) setState(() => _submittingFix = false);
    }
  }

  Future<void> _validateProposal() async {
    final proposal = _changeSet;
    if (proposal == null || proposal.state != 'proposed' || _submittingFix) return;
    setState(() {
      _submittingFix = true;
      _fixError = null;
    });
    try {
      final checked = await _repository.validateChangeSet(proposal.id);
      if (mounted) setState(() => _changeSet = checked);
    } on PairingException catch (error) {
      if (!await _restoreLatestChangeSet() && mounted) {
        setState(() => _fixError = error.message);
      }
    } finally {
      if (mounted) setState(() => _submittingFix = false);
    }
  }

  Future<bool> _restoreLatestChangeSet() async {
    try {
      final restored = await _repository.restoreLatestChangeSet();
      if (restored == null || !mounted) return restored != null;
      setState(() {
        _changeSet = restored;
        _fixError = null;
      });
      return true;
    } on PairingException {
      return false;
    }
  }

  Future<void> _refresh() async {
    if (_refreshing) return;
    setState(() {
      _refreshing = true;
      _error = null;
    });
    try {
      final artifact = await _repository.capturePreview();
      final image = await _repository.previewImage(artifact.id);
      if (!mounted) return;
      setState(() {
        _artifact = artifact;
        _image = image;
      });
    } on PairingException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'プレビューを更新できませんでした。PCと端末の接続を確認してください。');
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  String _capturedLabel() {
    final capturedAt = _artifact?.capturedAt;
    if (capturedAt == null) return '実機の最新画面を取得します';
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(capturedAt.hour)}:${two(capturedAt.minute)}:${two(capturedAt.second)} に更新';
  }

  @override
  Widget build(BuildContext context) {
    const panel = Color(0xFF101722);
    const border = Color(0xFF1D65D8);
    const accent = Color(0xFF3183FF);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) widget.onBack();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFF05080E),
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 16),
            child: Column(
              children: [
                Row(
                  children: [
                    IconButton(
                      key: const ValueKey('live-preview-back'),
                      onPressed: widget.onBack,
                      icon: const Icon(Icons.arrow_back_ios_new_rounded),
                      color: Colors.white,
                      tooltip: '戻る',
                    ),
                    const Expanded(
                      child: Text(
                        'Live Preview',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    IconButton(
                      key: const ValueKey('live-preview-floating-control'),
                      onPressed: _toggleFloatingControl,
                      tooltip: _overlayVisible ? 'フローティング操作を終了' : 'フローティング操作を開始',
                      color: _overlayVisible
                          ? const Color(0xFF54E5A0)
                          : const Color(0xFF8CB6FF),
                      icon: Icon(
                        _overlayVisible
                            ? Icons.picture_in_picture_alt_rounded
                            : Icons.open_in_new_rounded,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  '実機で動作中のアプリ画面',
                  style: TextStyle(color: Colors.blueGrey.shade200, fontSize: 13),
                ),
                const SizedBox(height: 16),
                if (_pendingSelection case final selection?)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0x181D65D8),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0x661D65D8)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'フローティング操作で選択した修正指示',
                          style: TextStyle(color: Color(0xFFAAC5FF), fontSize: 11),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '(${selection.x.round()}, ${selection.y.round()})  ${selection.instruction}',
                          style: const TextStyle(color: Colors.white, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                if (_fixRequest case final request?)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.all(11),
                    decoration: BoxDecoration(
                      color: const Color(0xFF101722),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: request.state == 'approved'
                            ? const Color(0xFF54E5A0)
                            : const Color(0xFF3183FF),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          request.state == 'approved'
                              ? '修正指示を承認しました'
                              : '修正を開始する前の確認',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'この承認で許可されるのは、登録プロジェクト内にある既存Dartファイルの変更だけです。新規ファイル、依存関係、native設定、削除、Git操作は含まれません。',
                          style: TextStyle(color: Color(0xFFB9C7E1), fontSize: 11),
                        ),
                        if (request.state == 'awaiting_approval') ...[
                          const SizedBox(height: 8),
                          FilledButton.icon(
                            key: const ValueKey('fix-request-approve'),
                            onPressed: _submittingFix ? null : _approveFix,
                            icon: const Icon(Icons.verified_rounded),
                            label: Text(_submittingFix ? '送信中…' : '修正を開始'),
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF3183FF),
                              minimumSize: const Size.fromHeight(42),
                            ),
                          ),
                        ],
                        if (request.state == 'approved' && _changeSet == null) ...[
                          const SizedBox(height: 8),
                          FilledButton.icon(
                            key: const ValueKey('fix-request-generate-proposal'),
                            onPressed: _submittingFix ? null : _generateProposal,
                            icon: const Icon(Icons.auto_fix_high_rounded),
                            label: Text(_submittingFix ? '修正案を生成中…' : '修正案を生成'),
                            style: FilledButton.styleFrom(
                              backgroundColor: const Color(0xFF3183FF),
                              minimumSize: const Size.fromHeight(42),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                if (_changeSet case final changeSet?)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.all(11),
                    decoration: BoxDecoration(
                      color: const Color(0xFF101722),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: changeSet.state == 'applied' ? const Color(0xFF54E5A0) : const Color(0xFF8CB6FF)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(changeSet.state == 'applied' ? '修正案を適用しました' : 'Codex の修正案', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                        const SizedBox(height: 4),
                        Text(changeSet.summary, style: const TextStyle(color: Color(0xFFB9C7E1), fontSize: 12)),
                        const SizedBox(height: 5),
                        Text(changeSet.files.map((file) => '${file.path}  +${file.additions} −${file.deletions}').join('\n'), style: const TextStyle(color: Color(0xFFAAC5FF), fontSize: 11)),
                        if (changeSet.risks.isNotEmpty) ...[
                          const SizedBox(height: 5),
                          Text('注意: ${changeSet.risks.join(' / ')}', style: const TextStyle(color: Color(0xFFFFD08A), fontSize: 11)),
                        ],
                        if (changeSet.validationState == 'failed') ...[
                          const SizedBox(height: 5),
                          Text(
                            '検証に失敗: ${changeSet.validationDetail ?? 'flutter analyze の詳細を確認してください。'}',
                            maxLines: 4,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Color(0xFFFFA5AE), fontSize: 11),
                          ),
                        ],
                        if (changeSet.state == 'proposed' && changeSet.validationState != 'passed') ...[
                          const SizedBox(height: 8),
                          FilledButton.icon(
                            key: const ValueKey('change-set-validate'),
                            onPressed: _submittingFix ? null : _validateProposal,
                            icon: const Icon(Icons.rule_folder_rounded),
                            label: Text(_submittingFix ? '解析して検証中…' : '解析して検証'),
                            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF3183FF), minimumSize: const Size.fromHeight(42)),
                          ),
                        ],
                        if (changeSet.state == 'proposed' && changeSet.validationState == 'passed') ...[
                          const SizedBox(height: 8),
                          FilledButton.icon(
                            key: const ValueKey('change-set-apply'),
                            onPressed: _submittingFix ? null : _applyProposal,
                            icon: const Icon(Icons.check_circle_outline_rounded),
                            label: const Text('この修正案を適用'),
                            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF2D9B6F), minimumSize: const Size.fromHeight(42)),
                          ),
                        ],
                      ],
                    ),
                  ),
                if (_fixError case final fixError?)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: const Color(0x2DFF5D70),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      fixError,
                      style: const TextStyle(color: Color(0xFFFFA5AE), fontSize: 12),
                    ),
                  ),
                if (_submittingFix)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 10),
                    child: LinearProgressIndicator(minHeight: 3),
                  ),
                if (_overlayVisible)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                    decoration: BoxDecoration(
                      color: const Color(0x172DE69A),
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(color: const Color(0x6654E5A0)),
                    ),
                    child: const Text(
                      'フローティング操作が有効です。hamoloを開いて、画面端のDPを押してください。',
                      style: TextStyle(color: Color(0xFFABEBCF), fontSize: 11),
                    ),
                  ),
                Expanded(
                  child: Container(
                    width: double.infinity,
                    decoration: BoxDecoration(
                      color: const Color(0xFF07142B),
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(color: border, width: 1.4),
                      boxShadow: const [
                        BoxShadow(color: Color(0x55005CFF), blurRadius: 26),
                      ],
                    ),
                    padding: const EdgeInsets.all(10),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: ColoredBox(
                        color: Colors.black,
                        child: _previewBody(),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    const Icon(Icons.android_rounded, color: Color(0xFF54E5A0), size: 18),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        _capturedLabel(),
                        style: TextStyle(color: Colors.blueGrey.shade200, fontSize: 12),
                      ),
                    ),
                    if (_artifact != null)
                      Text(
                        '${_artifact!.width} × ${_artifact!.height}',
                        style: TextStyle(color: Colors.blueGrey.shade400, fontSize: 11),
                      ),
                  ],
                ),
                if (_error case final error?) ...[
                  const SizedBox(height: 10),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(11),
                    decoration: BoxDecoration(
                      color: const Color(0x2DFF5D70),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: const Color(0x66FF6578)),
                    ),
                    child: Text(error, style: const TextStyle(color: Color(0xFFFFA5AE), fontSize: 12)),
                  ),
                ],
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        key: const ValueKey('live-preview-refresh'),
                        onPressed: _refreshing ? null : _refresh,
                        icon: _refreshing
                            ? const SizedBox(
                                width: 17,
                                height: 17,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.refresh_rounded),
                        label: Text(_refreshing ? '取得中…' : '更新'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFFAAC5FF),
                          side: const BorderSide(color: border),
                          minimumSize: const Size.fromHeight(50),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton.icon(
                        key: const ValueKey('live-preview-point-and-fix'),
                        onPressed: _submittingFix ? null : _startPointAndFix,
                        icon: const Icon(Icons.ads_click_rounded),
                        label: const Text('Point & Fix を開始'),
                        style: FilledButton.styleFrom(
                          backgroundColor: accent,
                          minimumSize: const Size.fromHeight(50),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _previewBody() {
    if (_image case final image?) {
      return InteractiveViewer(
        minScale: 1,
        maxScale: 3,
        child: Center(
          child: Image.memory(
            image,
            key: const ValueKey('live-preview-image'),
            fit: BoxFit.contain,
            gaplessPlayback: true,
          ),
        ),
      );
    }
    if (_refreshing) {
      return const Center(child: CircularProgressIndicator());
    }
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.phone_android_rounded, color: Color(0xFF6CA0FF), size: 54),
          SizedBox(height: 12),
          Text('実機プレビューを取得できません', style: TextStyle(color: Colors.white)),
        ],
      ),
    );
  }
}
