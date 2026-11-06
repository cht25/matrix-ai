/// MATRIX Wear OS companion entry point.
///
/// Priorities per the product brief: voice-friendly quick AI replies, short
/// responses, device status, and approved reminders — no unsupported phone
/// capabilities are forced onto the watch.
library;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:matrix_app/firebase_options.dart';
import 'package:matrix_app/api.dart';
import 'screens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  runApp(const MatrixWearApp());
}

class MatrixWearApp extends StatelessWidget {
  const MatrixWearApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MATRIX Wear',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3B82F6), brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: StreamBuilder<User?>(
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
