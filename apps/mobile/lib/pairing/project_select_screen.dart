import 'package:devpilot_mobile/pairing/pairing_repository.dart';
import 'package:flutter/material.dart';

class ProjectSelectScreen extends StatefulWidget {
  const ProjectSelectScreen({super.key, required this.onOpen});
  final VoidCallback onOpen;
  @override
  State<ProjectSelectScreen> createState() => _ProjectSelectScreenState();
}

class _ProjectSelectScreenState extends State<ProjectSelectScreen> {
  final _repository = PairingRepository();
  List<RegisteredProject> _projects = const [];
  String? _selected;
  String? _message;
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _message = null; });
    try {
      final projects = await _repository.projects();
      if (mounted) setState(() { _projects = projects; _selected = projects.isEmpty ? null : projects.first.id; });
    } on PairingException catch (error) { if (mounted) setState(() => _message = error.message); }
    finally { if (mounted) setState(() => _loading = false); }
  }

  Future<void> _open() async {
    if (_selected == null) return;
    setState(() { _loading = true; _message = null; });
    try { await _repository.startSession(_selected!); if (mounted) widget.onOpen(); }
    on PairingException catch (error) { if (mounted) setState(() => _message = error.message); }
    finally { if (mounted) setState(() => _loading = false); }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xFF080A0F),
    body: SafeArea(child: Padding(padding: const EdgeInsets.all(20), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 22),
      const Text('プロジェクトを選択', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w800)),
      const SizedBox(height: 8),
      const Text('PCに登録したFlutterプロジェクトを選びます。', style: TextStyle(color: Color(0xFFB7C5DD))),
      const SizedBox(height: 24),
      Expanded(child: _body()),
      if (_message != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(_message!, style: const TextStyle(color: Color(0xFFFF8E9B)))),
      Row(children: [TextButton(onPressed: _loading ? null : _load, child: const Text('更新')), const Spacer(), FilledButton.icon(onPressed: _loading || _selected == null ? null : _open, icon: const Icon(Icons.play_arrow_rounded), label: const Text('このプロジェクトを開く'))]),
    ]))),
  );

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_projects.isEmpty) return const Center(child: Text('登録プロジェクトがありません。\nDesktopでプロジェクトのルートを登録してください。', textAlign: TextAlign.center));
    return ListView.separated(itemCount: _projects.length, separatorBuilder: (_, __) => const SizedBox(height: 12), itemBuilder: (_, index) {
      final project = _projects[index]; final selected = project.id == _selected;
      return InkWell(onTap: () => setState(() => _selected = project.id), borderRadius: BorderRadius.circular(16), child: Container(padding: const EdgeInsets.all(18), decoration: BoxDecoration(color: const Color(0xFF121923), borderRadius: BorderRadius.circular(16), border: Border.all(color: selected ? const Color(0xFF287BFF) : const Color(0xFF27364C), width: selected ? 2 : 1)), child: Row(children: [Icon(Icons.folder_rounded, color: selected ? const Color(0xFF6AA2FF) : const Color(0xFFB7C5DD)), const SizedBox(width: 14), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(project.name, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)), const SizedBox(height: 3), Text(project.rootPath, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Color(0xFF93A5C1), fontSize: 12))])), if (selected) const Icon(Icons.check_circle, color: Color(0xFF51E6A4))])));
    });
  }
}
