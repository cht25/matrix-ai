# QORVYNA AI — Android app (`mobile/matrix_app`)

Flutter app for Android. It talks to the QORVYNA backend
(`https://qorvyna.thamjj13.top` by default).

## What it does

- **Chat** (`lib/chat_screen.dart`) through the same `/api/ai` gateway as the web app.
- **Devices** (`lib/devices_screen.dart`, `lib/pairing_screen.dart`): register
  this phone as a **Child** of a Parent device.
  1. On the Parent (web: Devices → "Add a device"), a QR code and a typed code are shown for 5 minutes.
  2. On the phone: Devices → **Register as Child** → scan the QR (torch and
     camera switch available) or type the code.
  3. The Parent approves or declines. Only after approval does the phone
     receive its own revocable credential, kept in Android Keystore-backed
     secure storage. The Parent can disconnect, change permissions or remove
     the phone at any time.
- **Update check** (`lib/update_service.dart` → `GET /api/app/version`).

The app does not read installed apps, usage, browser history or anything in
the background, and it reports none.

## Build

Requires Flutter 3.24+ and JDK 17. The Gradle wrapper is not committed;
`flutter create .` adds the missing wrapper files to the existing project.

```bash
cd mobile/matrix_app
flutter create --platforms=android --project-name matrix_app --org top.thamjj13 .
rm -f test/widget_test.dart   # template test, if one was generated
flutter pub get
flutter analyze && flutter test
flutter build apk --release \
  --dart-define=FIREBASE_API_KEY=... \
  --dart-define=FIREBASE_APP_ID=... \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID=... \
  --dart-define=FIREBASE_PROJECT_ID=...
```

The four `FIREBASE_*` values are the public client configuration of the
Firebase project (the web app's `NEXT_PUBLIC_FIREBASE_*`). A build without
them opens to a clear "can't start" screen rather than a broken sign-in.

Optional build settings, all read in `lib/config.dart`:

| `--dart-define` | Default | Purpose |
|---|---|---|
| `QORVYNA_API_BASE` | `https://qorvyna.thamjj13.top` | The backend the app talks to |
| `QORVYNA_APP_VERSION` | the version in `config.dart` | Version reported to the update check |
| `QORVYNA_APP_BUILD` | the build number in `config.dart` | Build number reported to the update check |

The earlier names `MATRIX_API_BASE`, `MATRIX_APP_VERSION` and
`MATRIX_APP_BUILD` are still read, so existing build scripts keep working.

## Names that still say "matrix"

The product is QORVYNA; these identifiers were kept on purpose when it was
renamed, because changing them would break installed apps:

- the application IDs `top.thamjj13.matrix` and `top.thamjj13.matrixwear` —
  a new ID would be a different app to Android, so installed copies would
  stop updating;
- the APK file name `matrix-android.apk` — installed apps download their
  update from that address;
- the folders `matrix_app` / `matrix_wear` and the Dart classes `MatrixApi`,
  `MatrixConfig`, `MatrixApp` — internal names no user sees.

What users see — the app label, launcher icon, splash colour and every screen
— says QORVYNA. See `docs/REBRAND_MIGRATION.md`.

## Wear OS app (`mobile/matrix_wear`)

A companion for Wear OS, built the same way from `mobile/matrix_wear`. Its
launcher icons and the `LaunchTheme` / `NormalTheme` styles its manifest
refers to are in `android/app/src/main/res/`.

Output: `build/app/outputs/flutter-apk/app-release.apk`.

### Signing

Create `android/key.properties` (git-ignored) next to a keystore:

```
storeFile=release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

Without it, the release build is signed with the debug key: installable for
testing, not suitable for distribution, and it cannot update a release-signed
install.

## CI

`docs/ci/android.yml` is a ready workflow that analyzes, tests and builds the
APK. It is **not active yet**: the automation that maintains this repository is
not permitted to create files under `.github/workflows/`. To enable it, copy
the file to `.github/workflows/android.yml` (GitHub web UI is enough) and add
the secrets listed at its top. On a `mobile-v*` tag with the signing secrets
set, it attaches `matrix-android.apk` and its SHA-256 to the GitHub release,
which is where `/api/app/version` points by default.
