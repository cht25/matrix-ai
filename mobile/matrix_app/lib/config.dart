// Compile-time configuration for the QORVYNA Android phone app.
//
// Canonical production URL: https://qorvyna.thamjj13.top (chat: https://qorvyna.thamjj13.top/chat).
// Override for staging/local builds via `--dart-define`:
//   flutter build apk --release \
//     --dart-define=QORVYNA_API_BASE=https://qorvyna.thamjj13.top \
//     --dart-define=FIREBASE_API_KEY=... \
//     --dart-define=FIREBASE_APP_ID=... \
//     --dart-define=FIREBASE_MESSAGING_SENDER_ID=... \
//     --dart-define=FIREBASE_PROJECT_ID=...
//
// The product was renamed from MATRIX to QORVYNA. Each setting is read as
// QORVYNA_<NAME> and falls back to the earlier MATRIX_<NAME>, so existing build
// scripts and CI keep working unchanged. (The class keeps its original name:
// it is an internal identifier, and renaming it would touch every screen.)

class MatrixConfig {
  static const String _legacyApiBase = String.fromEnvironment(
    'MATRIX_API_BASE',
    defaultValue: 'https://qorvyna.thamjj13.top',
  );
  static const String apiBase = String.fromEnvironment(
    'QORVYNA_API_BASE',
    defaultValue: _legacyApiBase,
  );

  static const String _legacyAppVersion = String.fromEnvironment(
    'MATRIX_APP_VERSION',
    defaultValue: '1.2.0',
  );
  static const String appVersion = String.fromEnvironment(
    'QORVYNA_APP_VERSION',
    defaultValue: _legacyAppVersion,
  );

  static const int _legacyAppBuildNumber = int.fromEnvironment(
    'MATRIX_APP_BUILD',
    defaultValue: 3,
  );
  static const int appBuildNumber = int.fromEnvironment(
    'QORVYNA_APP_BUILD',
    defaultValue: _legacyAppBuildNumber,
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
