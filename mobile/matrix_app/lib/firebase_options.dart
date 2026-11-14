/// Firebase options for the Android app.
///
/// The values are the project's PUBLIC client configuration (the same ones the
/// web app ships as NEXT_PUBLIC_FIREBASE_*). They are supplied at build time
/// with --dart-define (see lib/config.dart and .github/workflows/android.yml),
/// so no project configuration is committed and no google-services.json is
/// needed. All privileged access is enforced server-side.
library;

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'config.dart';

class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    return const FirebaseOptions(
      apiKey: MatrixConfig.firebaseApiKey,
      appId: MatrixConfig.firebaseAppId,
      messagingSenderId: MatrixConfig.firebaseMessagingSenderId,
      projectId: MatrixConfig.firebaseProjectId,
    );
  }
}
