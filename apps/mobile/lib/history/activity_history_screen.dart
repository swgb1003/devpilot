import 'package:devpilot_mobile/pairing/pairing_repository.dart';
import 'package:flutter/material.dart';

class ActivityHistoryScreen extends StatefulWidget {
  const ActivityHistoryScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  State<ActivityHistoryScreen> createState() => _ActivityHistoryScreenState();
}

class _ActivityHistoryScreenState extends State<ActivityHistoryScreen> {
  final _repository = PairingRepository();
  List<AgentActivity> _activities = const [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final activities = await _repository.activities();
      if (mounted) setState(() => _activities = activities);
    } on PairingException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Color _colorFor(String severity) => switch (severity) {
    'success' => const Color(0xFF54E5A0),
    'warning' => const Color(0xFFFFD08A),
    'error' => const Color(0xFFFF8E9B),
    _ => const Color(0xFF8CB6FF),
  };

  String _timeLabel(DateTime value) {
    String two(int number) => number.toString().padLeft(2, '0');
    return '${two(value.month)}/${two(value.day)} ${two(value.hour)}:${two(value.minute)}';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    key: const ValueKey('screen-history'),
    backgroundColor: const Color(0xFF080A0F),
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 10, 18, 16),
        child: Column(
          children: [
            Row(
              children: [
                IconButton(
                  onPressed: widget.onBack,
                  icon: const Icon(Icons.arrow_back_ios_new_rounded),
                  color: Colors.white,
                  tooltip: '戻る',
                ),
                const Expanded(
                  child: Text(
                    '修正・実行履歴',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700),
                  ),
                ),
                IconButton(
                  key: const ValueKey('activity-history-refresh'),
                  onPressed: _loading ? null : _load,
                  icon: _loading
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.refresh_rounded),
                  color: const Color(0xFF8CB6FF),
                  tooltip: '更新',
                ),
              ],
            ),
            const SizedBox(height: 8),
            const Align(
              alignment: Alignment.centerLeft,
              child: Text('PCのAgentに保存された最近30件の操作です。', style: TextStyle(color: Color(0xFF9AAAC5), fontSize: 12)),
            ),
            const SizedBox(height: 14),
            Expanded(child: _body()),
          ],
        ),
      ),
    ),
  );

  Widget _body() {
    if (_loading && _activities.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, color: Color(0xFFFF8E9B), size: 38),
            const SizedBox(height: 10),
            Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFFFA5AE))),
            const SizedBox(height: 12),
            OutlinedButton.icon(onPressed: _load, icon: const Icon(Icons.refresh_rounded), label: const Text('再確認')),
          ],
        ),
      );
    }
    if (_activities.isEmpty) {
      return const Center(child: Text('まだ操作履歴はありません。', style: TextStyle(color: Color(0xFFB7C5DD))));
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        itemCount: _activities.length,
        separatorBuilder: (_, _) => const SizedBox(height: 9),
        itemBuilder: (_, index) {
          final activity = _activities[index];
          final color = _colorFor(activity.severity);
          return Container(
            padding: const EdgeInsets.all(13),
            decoration: BoxDecoration(
              color: const Color(0xFF101722),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: color.withValues(alpha: 0.55)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.circle, color: color, size: 12),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(activity.message, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text('${_timeLabel(activity.occurredAt)} ・ ${activity.kind}', style: const TextStyle(color: Color(0xFF91A4C4), fontSize: 11)),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
