import 'package:flutter/material.dart';

void main() => runApp(const SampleApp());

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DevPilot Sample',
      theme: ThemeData(colorSchemeSeed: Colors.blue, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final TextEditingController _controller = TextEditingController();
  String _greeting = 'Hello';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _apply() {
    setState(() {
      final name = _controller.text.trim();
      _greeting = name.isEmpty ? 'Hello' : 'Hello, $name';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('DevPilot Sample')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              _greeting,
              key: const ValueKey('greetingText'),
              style: const TextStyle(fontSize: 24),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('nameField'),
              controller: _controller,
              decoration: const InputDecoration(labelText: 'Your name'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              key: const ValueKey('applyButton'),
              onPressed: _apply,
              child: const Text('Apply'),
            ),
            const SizedBox(height: 24),
            // Intentionally overflows a narrow phone: a fixed-width Row of wide
            // boxes with no wrapping. DevPilot's screenshot / Point & Fix path
            // needs a real layout defect to point at.
            Row(
              key: const ValueKey('overflowRow'),
              children: <Widget>[
                for (int i = 0; i < 6; i++)
                  Container(
                    width: 120,
                    height: 48,
                    margin: const EdgeInsets.only(right: 8),
                    color: Colors.blue.shade100,
                    alignment: Alignment.center,
                    child: Text('Item $i'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
