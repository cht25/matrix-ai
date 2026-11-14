/// MATRIX AI — Android app entry point.
///
/// Build with the Firebase client configuration and (optionally) the API base:
///   flutter build apk --release \
///     --dart-define=FIREBASE_API_KEY=... --dart-define=FIREBASE_APP_ID=... \
///     --dart-define=FIREBASE_MESSAGING_SENDER_ID=... --dart-define=FIREBASE_PROJECT_ID=...
library;

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'auth_gate.dart';
import 'config.dart';
import 'firebase_options.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  String? startupError;
  if (!MatrixConfig.isFirebaseConfigured) {
    startupError = 'This build has no sign-in configuration, so it cannot connect to MATRIX. '
        'Install the official release, or rebuild with the FIREBASE_* build settings.';
  } else {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    } catch (_) {
      startupError = 'MATRIX could not start sign-in on this device. Check your connection and reopen the app.';
    }
  }
  runApp(MatrixApp(startupError: startupError));
}

class MatrixApp extends StatelessWidget {
  const MatrixApp({super.key, this.startupError});
  final String? startupError;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MATRIX AI',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3B82F6), brightness: Brightness.dark), useMaterial3: true),
      home: startupError == null ? const AuthGate() : _StartupProblem(message: startupError!),
    );
  }
}

class _StartupProblem extends StatelessWidget {
  const _StartupProblem({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, size: 44, color: Color(0xFFF59E0B)),
                const SizedBox(height: 14),
                const Text('MATRIX can\'t start', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                Text(message, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70, height: 1.45)),
                const SizedBox(height: 10),
                const Text('Version ${MatrixConfig.appVersion} (${MatrixConfig.appBuildNumber})', style: TextStyle(color: Colors.white38, fontSize: 12)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
