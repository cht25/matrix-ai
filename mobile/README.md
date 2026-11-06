# MATRIX mobile apps (Android now — Wear OS/Windows next)

Official companion clients live here. They talk to the **same** MATRIX backend
(Firebase Auth + the Next.js API) as the web app — one identity, one
permission system, one device registry.

## Authentication model (native clients)

The web app uses an httpOnly session cookie. Native apps cannot hold those, so
`src/lib/firebase/session.ts` additionally accepts a **Firebase ID token** in
the `Authorization: Bearer <idToken>` header, verified server-side with the
Admin SDK exactly like the cookie path (`verifyIdToken`, checkRevoked=true).
No new trust model: every API route still re-verifies the token server-side.

## Android app (`mobile/matrix_app`)

Flutter (single codebase; Wear OS companion can share this module later).

Features (all real, no mocks):

- Email/password sign-in & registration (Firebase Auth).
- **Chat** against `/api/ai/compare` (single-lane, non-streaming — reliable on mobile networks).
- **QR device pairing** (`mobile_scanner`): scans the `matrix-pairing:v1.…` QR from
  MATRIX web → Devices, then `POST /api/devices/pairing/complete`. Camera permission
  is requested by the OS only when the pairing screen is used.
- **Device center**: lists linked devices (`GET /api/devices`), unlink (`DELETE`).

### Build & run

```bash
# 1. Prereqs: Flutter SDK (stable), Android Studio / cmdline-tools, JDK 17.
# 2. Firebase config for the app:
dart pub global activate flutterfire_cli
cd mobile/matrix_app
flutterfire configure --project=<your-matrix-firebase-project>   # writes lib/firebase_options.dart
# 3. Add google-services.json:
#    Firebase console → Project settings → Your apps → Android → download
#    google-services.json → android/app/google-services.json
# 4. Run:
flutter pub get
flutter run --dart-define=MATRIX_API_BASE=https://matrix.thamjj13.top
# Release APK:
flutter build apk --release --dart-define=MATRIX_API_BASE=https://matrix.thamjj13.top
```

`lib/firebase_options.dart` in the repo is a documented placeholder — replace it
with the `flutterfire`-generated file (public web config values only).

## Security notes

- ID tokens are stored in `FlutterSecureStorage` (Keystore/Keychain backed), never logged.
- Pairing QR payloads contain no credentials; the server enforces signature,
  5-minute expiry and single use.
- No background recording, no hidden permissions: the manifest requests only
  INTERNET and CAMERA (camera used solely on the pairing screen).

## Tests

- Backend Bearer-token support: `tests/session-bearer.test.ts` (web repo).
- App client envelope handling: `mobile/matrix_app/test/api_test.dart` (`flutter test`).

## Wear OS companion (`mobile/matrix_wear`)

Shares the phone app's code via a path dependency (`matrix_app`). Watch-first UI:
sign-in, **quick chat with short answers** (fast lane, truncated for the small
screen), and read-only **device status**. No unsupported phone capabilities are
requested; manifest declares `android.hardware.type.watch` and standalone=false
(phone companion connection).

```bash
cd mobile/matrix_wear
flutterfire configure --project=<your-matrix-firebase-project> --android-app-id=top.thamjj13.matrixwear
# place google-services.json in android/app/
flutter pub get
flutter build apk --release   # install on the watch (adb / Wear OS pairing)
```

## CI-built APK → GitHub Releases

You cannot build the APK inside this coding sandbox (no Flutter/Android SDK and
no access to the SDK download hosts), but the repo now ships a release pipeline:
`docs/ci/build-android-release.yml` (move to `.github/workflows/` when your token has the `workflows` permission).

Add these **repository secrets** (Settings → Secrets → Actions), then push a
tag (`git tag v1.0.0 && git push origin v1.0.0`) or run the workflow manually:

| Secret | Content |
|---|---|
| `MATRIX_API_BASE` | e.g. `https://matrix.thamjj13.top` |
| `FIREBASE_OPTIONS_DART` | base64 of `lib/firebase_options.dart` from `flutterfire configure` (public web config only) |
| `GOOGLE_SERVICES_JSON` | base64 of `android/app/google-services.json` |
| `KEYSTORE_BASE64` | base64 of your release keystore `.jks` |
| `KEYSTORE_PASSWORD` / `KEY_PASSWORD` / `KEY_ALIAS` | keystore credentials |

The runner builds `app-release.apk` + `app-release.aab`, runs `flutter analyze`,
and attaches both to a GitHub Release on the tag. No secrets ever land in the
repo or the APK.
