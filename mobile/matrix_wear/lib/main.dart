/// QORVYNA Wear OS companion entry point.
///
/// Priorities per the product brief: voice-friendly quick AI replies, short
/// responses, device status, synced notifications, and approved reminders —
/// configured with --dart-define=FIREBASE_* (no google-services.json needed).
library;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:matrix_app/config.dart';
import 'package:matrix_app/firebase_options.dart';
import 'package:matrix_app/api.dart';
import 'screens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  String? startupError;
  if (!MatrixConfig.isFirebaseConfigured) {
    startupError = 'Missing FIREBASE_* --dart-define build flags.';
  } else {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    } catch (_) {
      startupError = 'Could not initialize Firebase sign-in on watch.';
    }
  }
  runApp(MatrixWearApp(startupError: startupError));
}

class MatrixWearApp extends StatelessWidget {
  const MatrixWearApp({super.key, this.startupError});
  final String? startupError;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'QORVYNA Wear',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2563FF), brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: startupError != null
          ? Scaffold(
              body: Center(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Text(startupError!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12)),
                ),
              ),
            )
          : StreamBuilder<User?>(
              stream: FirebaseAuth.instance.authStateChanges(),
              builder: (context, snap) {
                if (snap.connectionState == ConnectionState.waiting) {
                  return const Scaffold(body: Center(child: CircularProgressIndicator()));
                }
                if (snap.data == null) return const WearLoginScreen();
                return WearHomeScreen(api: MatrixApi());
              },
            ),
    );
  }
}
