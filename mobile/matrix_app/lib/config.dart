// Compile-time configuration for the MATRIX Android phone app.
//
// Canonical production URL: https://matrix.thamjj13.top (chat: https://matrix.thamjj13.top/chat).
// Override for staging/local builds via `--dart-define`:
//   flutter build apk --release \
//     --dart-define=MATRIX_API_BASE=https://matrix.thamjj13.top \
//     --dart-define=FIREBASE_API_KEY=... \
//     --dart-define=FIREBASE_APP_ID=... \
//     --dart-define=FIREBASE_MESSAGING_SENDER_ID=... \
//     --dart-define=FIREBASE_PROJECT_ID=...

class MatrixConfig {
  static const String apiBase = String.fromEnvironment(
    'MATRIX_API_BASE',
    defaultValue: 'https://matrix.thamjj13.top',
  );

  static const String appVersion = String.fromEnvironment(
    'MATRIX_APP_VERSION',
    defaultValue: '1.2.0',
  );

  static const int appBuildNumber = int.fromEnvironment(
    'MATRIX_APP_BUILD',
    defaultValue: 3,
  );

  static const String firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const String firebaseAppId = String.fromEnvironment('FIREBASE_APP_ID');
  static const String firebaseMessagingSenderId = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
  static const String firebaseProjectId = String.fromEnvironment('FIREBASE_PROJECT_ID');

  static bool get isFirebaseConfigured =>
      firebaseApiKey.isNotEmpty &&
      firebaseAppId.isNotEmpty &&
      firebaseMessagingSenderId.isNotEmpty &&
      firebaseProjectId.isNotEmpty;

  static Uri get baseUri {
    final trimmed = apiBase.endsWith('/') ? apiBase.substring(0, apiBase.length - 1) : apiBase;
    return Uri.parse(trimmed);
  }

  static Uri get chatUri => baseUri.resolve('/chat');
}
