import 'package:devpilot_mobile/ui/screen_navigator.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_driver/driver_extension.dart';

void main() {
  if (const bool.fromEnvironment('ENABLE_FLUTTER_DRIVER')) {
    enableFlutterDriverExtension();
  }

  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.black,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Colors.black,
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );
  runApp(const DevPilotApp());
}

class DevPilotApp extends StatelessWidget {
  const DevPilotApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DevPilot',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.black,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1778FF),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const DevPilotScreenNavigator(),
    );
  }
}
