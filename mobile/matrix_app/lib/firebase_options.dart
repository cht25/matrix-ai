// GENERATED-PLACEHOLDER — replace with the real file produced by:
//   dart pub global activate flutterfire_cli
//   flutterfire configure --project=<matrix-firebase-project>
//
// The values below are the PUBLIC Firebase web config (same as the web app's
// NEXT_PUBLIC_FIREBASE_* values) and are safe to ship; the API key restricts
// nothing by itself — all privileged access is enforced server-side.
library;

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    // Fill these from your Firebase project console (Web app config).
    return const FirebaseOptions(
      apiKey: 'YOUR_FIREBASE_WEB_API_KEY',
      appId: 'YOUR_FIREBASE_APP_ID',
      messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
      projectId: 'YOUR_PROJECT_ID',
      authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
    );
  }
}
