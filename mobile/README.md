# MATRIX AI — Android Phone App (`mobile/matrix_app`)

Native Flutter Android phone app for **MATRIX AI**, preconfigured for the canonical production backend **`https://matrix.thamjj13.top`** (`https://matrix.thamjj13.top/chat`).

## Features

- **GPT OSS 120B Chat & Image Generation** (`lib/chat_screen.dart`):
  - Modes for **Fast / Auto**, **Code**, **Deep Study**, and **Image**.
  - Compact Arena-style collapsible `Worked · N steps` pill above assistant messages.
  - One-tap launch into the full web workspace at `https://matrix.thamjj13.top/chat`.
- **Over-the-Air (OTA) Phone Update System** (`lib/update_service.dart` + `GET /api/app/version`):
  - Automatically checks `/api/app/version?platform=android&current_version=1.1.0&build=2` on startup, app resume, and manual **Check for phone updates**.
  - Supports **optional Material 3 update sheets** (changelog + SHA-256 + direct APK installer download) and **mandatory Force Update gates** controlled live from **Admin → AI configuration → Phone & Updates**.
- **QR Device Pairing, Agent Tasks, Automations & Family Controls** (`lib/devices_screen.dart`, `lib/agent_screen.dart`, `lib/automations_screen.dart`, `lib/family_screen.dart`).

## Building the Release APK Locally

Requires Flutter 3.24+ and JDK 17:

```bash
cd mobile/matrix_app
flutter pub get
flutter test
flutter build apk --release \
  --build-name=1.1.0 \
  --build-number=2 \
  --dart-define=MATRIX_API_BASE=https://matrix.thamjj13.top \
  --dart-define=MATRIX_APP_VERSION=1.1.0 \
  --dart-define=MATRIX_APP_BUILD=2 \
  --dart-define=FIREBASE_API_KEY=... \
  --dart-define=FIREBASE_APP_ID=... \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID=... \
  --dart-define=FIREBASE_PROJECT_ID=...
```

Output APK: `mobile/matrix_app/build/app/outputs/flutter-apk/app-release.apk`.

## Automated CI Release Pipeline

See `docs/ci/build-android-release.yml` — builds `matrix-android.apk`, `matrix-android.apk.sha256`, and `app-release.aab`, and attaches them to GitHub Releases on `mobile-v*` tags so `/api/app/version` serves instant OTA updates to phones.
