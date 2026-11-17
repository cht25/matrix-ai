# QORVYNA AI — Complete App Build & Release Guide

> Current synchronized release version: **v1.2.0** (build **3**)
> Canonical web origin: **https://qorvyna.thamjj13.top** (`/chat`)

This guide covers prerequisites, environment configuration, local builds, signing, and OTA release publishing across all QORVYNA surfaces:
1. Web & Progressive Web App (Next.js 15 + Service Worker + IndexedDB offline cache)
2. Desktop Companion App (Tauri v2 / Rust)
3. Android Phone App (`mobile/matrix_app` / Flutter)
4. Wear OS Companion App (`mobile/matrix_wear` / Flutter)

---

## 1. Web & PWA Build (`/` & `/chat`)

### Prerequisites
- **Node.js**: `20.x` or `22.x` LTS (`node -v`)
- **npm**: `10.x+`
- Server environment variables (never exposed to browser):
  - `GROQ_API_KEY` (GPT OSS 120B, Whisper STT)
  - `CLOUDFLARE_ACCOUNT_ID` & `CLOUDFLARE_API_TOKEN` (Cloudflare Workers AI `@cf/zai-org/glm-4.7-flash` + Whisper STT fallback)
  - `OPENAI_API_KEY` (optional STT/chat backup)
  - `NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
  - `CLOUDINARY_*` (optional private voice message storage & image assets; composer voice dictation `store=0` works without Cloudinary)
  - `NEXT_PUBLIC_APP_URL=https://qorvyna.thamjj13.top`

### Server Email Configuration (Resend Dual-Sender Architecture)
QORVYNA sends transactional, security, device, family, and verified-parent alert emails server-side via Resend:
- `RESEND_API_KEY`: server-only Resend secret (never exposed to browser or admin UI)
- `RESEND_FROM_PRIMARY=no-reply@qorvyna.top`
- `RESEND_FROM_FALLBACKS=no-reply@matrix.thamjj13.top,no-reply@qorvyna.thamjj13.top`
- **DNS Verification**: Every sender domain (`qorvyna.top`, `matrix.thamjj13.top`, `qorvyna.thamjj13.top`) must pass SPF/DKIM verification in the Resend dashboard. Fallback triggers ONLY when a sender domain returns an unverified/disallowed sender error — never on invalid API keys, invalid recipients, rate limits, or 5xx outages.
- **Admin Diagnostics (`/admin/email`)**: Admins with `system.settings` can inspect domain verification health, probe Resend `/domains`, send a diagnostic test email, and review masked delivery logs.

### Jarvis Voice, Notification Sync, Mirroring & Parent Safety
- **Web Jarvis (`/chat`)**: Opt-in foreground `"Hey QORVYNA"` wake-word (English & Bangla), `Ctrl+Shift+Space` shortcut, configurable voice/rate, and explicit confirmation cards for device actions (`open_app`, `media_control`, `notifications.clear_history`).
- **Desktop Companion (`src-tauri/`)**: Registers system-wide `Ctrl+Shift+Space` global shortcut, allowlisted Windows app launcher (`launch_app`), Windows media key controller (`media_control`), and hardware telemetry (`desktop_hardware_status`).
- **Android (`mobile/matrix_app/`)**: Declares `ACTION_ASSIST` / `VOICE_COMMAND` Digital Assistant entry points, `QorvynaNotificationListenerService` (opt-in Notification Access in Android Settings), and foreground `QorvynaScreenMirrorService` (`MediaProjection` with explicit user consent).
- **Notifications & Parent Safety (`/notifications`)**: Cross-device synced feed, privacy modes (`full`, `title_only`, `app_only`, `paused`), OTP redaction, excluded apps, and email-verified parent links (`parent_links`, `parent_policies`, `protected_action_requests`).
- **Screen Mirroring (`/mirror`)**: Consent-gated WebRTC screen sharing (`view_only` default, max 15m TTL, instant revocation).

### Install & Verify Locally
```bash
npm ci
npm run typecheck
npm test
npm run build
npm run start -- -H 0.0.0.0 -p 3000
```

### Offline Mode & Service Worker Verification
- Service worker: `public/sw.js` (cached version `qorvyna-cache-v1.2.0-b3`)
- Offline fallback page: `src/app/offline/page.tsx` (`/offline`)
- Connectivity ping probe: `GET /api/ping` (`Cache-Control: no-store`)
- Offline storage (`src/lib/client/offline-store.ts`): IndexedDB `qorvyna_offline_v1` (`conversations`, `drafts`, `outbox`)
- In-app update check (`src/components/pwa-manager.tsx`): queries `/api/app/version?platform=web` and detects waiting SW updates cleanly.

---

## 2. Desktop App Build (`src-tauri/`)

### Prerequisites
- **Node.js** `20+` & installed dependencies (`npm ci`)
- **Rust toolchain**: `rustc >= 1.77.2`, `cargo` (`rustup update stable`)
- **Tauri CLI v2**: `npm i -D @tauri-apps/cli@^2` or `cargo install tauri-cli --version ^2`
- **OS platform libraries**:
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
  - **Windows**: Microsoft Edge WebView2 Runtime + Visual Studio C++ Build Tools
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)

### Version Alignment
Check that these match before building:
- `package.json` → `"version": "1.2.0"`
- `src-tauri/tauri.conf.json` → `"version": "1.2.0"`, `"frontendDist": "https://qorvyna.thamjj13.top/chat"`
- `src-tauri/Cargo.toml` → `version = "1.2.0"`
- `src/lib/version.ts` → `APP_VERSION = "1.2.0"`, `APP_BUILD_NUMBER = 3`

### Local Development & Production Bundle Commands
```bash
# Development window (starts Next.js on http://localhost:3000/chat)
npx tauri dev

# Release bundle (Windows .msi/.exe, macOS .dmg/.app, Linux .AppImage/.deb)
npx tauri build
```

Artifacts are generated under `src-tauri/target/release/bundle/`.
The desktop runtime connects directly to `https://qorvyna.thamjj13.top/chat` and inherits live updates, Service Worker improvements, and `PwaManager` desktop version notifications (`GET /api/app/version?platform=desktop`).

---

## 3. Android Phone App Build (`mobile/matrix_app/`)

### Prerequisites
- **Flutter SDK**: `3.24.3+` (Dart SDK `>=3.4.0 <4.0.0`)
- **Java**: OpenJDK `17` (Temurin)
- **Android SDK**: Android API 34+ & Build-Tools installed (`flutter doctor -v` passes)
- **Gradle Wrapper**: Not committed in Git. Generate once before building:

```bash
cd mobile/matrix_app
flutter create --platforms=android --project-name matrix_app --org top.thamjj13 .
rm -f test/widget_test.dart
flutter pub get
```

### Static Analysis & Unit Tests
```bash
cd mobile/matrix_app
flutter analyze --no-fatal-infos
flutter test
```

### No `google-services.json` Needed
Neither `mobile/matrix_app` nor `mobile/matrix_wear` requires `google-services.json`. Both apps initialize Firebase from your project's public web keys (`NEXT_PUBLIC_FIREBASE_*`) supplied via `--dart-define=FIREBASE_*` at build time (`lib/firebase_options.dart`).

### Windows PC PowerShell Build Quickstart (Backend = `https://qorvyna.thamjj13.top`)
```powershell
# 1. Android Phone APK (mobile/matrix_app)
cd mobile\matrix_app
flutter create --platforms=android --project-name matrix_app --org top.thamjj13 .
Remove-Item -ErrorAction SilentlyContinue test\widget_test.dart
flutter pub get
flutter analyze --no-fatal-infos
flutter test
flutter build apk --release `
  --build-name=1.2.0 --build-number=3 `
  --dart-define=QORVYNA_API_BASE=https://qorvyna.thamjj13.top `
  --dart-define=QORVYNA_APP_VERSION=1.2.0 `
  --dart-define=QORVYNA_APP_BUILD=3 `
  --dart-define=FIREBASE_API_KEY="$env:NEXT_PUBLIC_FIREBASE_API_KEY" `
  --dart-define=FIREBASE_APP_ID="$env:NEXT_PUBLIC_FIREBASE_APP_ID" `
  --dart-define=FIREBASE_MESSAGING_SENDER_ID="$env:NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID" `
  --dart-define=FIREBASE_PROJECT_ID="$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID"

# 2. Wear OS APK (mobile/matrix_wear)
cd ..\matrix_wear
flutter create --platforms=android --project-name matrix_wear --org top.thamjj13 .
flutter pub get
flutter analyze --no-fatal-infos
flutter build apk --release `
  --build-name=1.2.0 --build-number=3 `
  --dart-define=QORVYNA_API_BASE=https://qorvyna.thamjj13.top `
  --dart-define=FIREBASE_API_KEY="$env:NEXT_PUBLIC_FIREBASE_API_KEY" `
  --dart-define=FIREBASE_APP_ID="$env:NEXT_PUBLIC_FIREBASE_APP_ID" `
  --dart-define=FIREBASE_MESSAGING_SENDER_ID="$env:NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID" `
  --dart-define=FIREBASE_PROJECT_ID="$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID"

# 3. Windows Desktop Installer (.exe / .msi) from repo root
cd ..\..
npm ci
npx tauri build
```

### Debug / Local APK Build
```bash
cd mobile/matrix_app
flutter build apk --debug \
  --dart-define=QORVYNA_API_BASE=https://qorvyna.thamjj13.top \
  --dart-define=QORVYNA_APP_VERSION=1.2.0 \
  --dart-define=QORVYNA_APP_BUILD=3 \
  --dart-define=FIREBASE_API_KEY="$NEXT_PUBLIC_FIREBASE_API_KEY" \
  --dart-define=FIREBASE_APP_ID="$NEXT_PUBLIC_FIREBASE_APP_ID" \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID="$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID" \
  --dart-define=FIREBASE_PROJECT_ID="$NEXT_PUBLIC_FIREBASE_PROJECT_ID"
```

### Signed Release APK & App Bundle (AAB)
1. Create or decrypt your upload keystore (`android/release.jks`, **never commit**):
   ```bash
   keytool -genkey -v -keystore android/release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias qorvyna
   ```
2. Create `mobile/matrix_app/android/key.properties` (**never commit**):
   ```properties
   storeFile=release.jks
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=qorvyna
   keyPassword=YOUR_KEY_PASSWORD
   ```
3. Build signed APK & SHA-256 checksum:
   ```bash
   cd mobile/matrix_app
   flutter build apk --release \
     --build-name=1.2.0 \
     --build-number=3 \
     --dart-define=QORVYNA_API_BASE=https://qorvyna.thamjj13.top \
     --dart-define=QORVYNA_APP_VERSION=1.2.0 \
     --dart-define=QORVYNA_APP_BUILD=3 \
     --dart-define=FIREBASE_API_KEY="$NEXT_PUBLIC_FIREBASE_API_KEY" \
     --dart-define=FIREBASE_APP_ID="$NEXT_PUBLIC_FIREBASE_APP_ID" \
     --dart-define=FIREBASE_MESSAGING_SENDER_ID="$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID" \
     --dart-define=FIREBASE_PROJECT_ID="$NEXT_PUBLIC_FIREBASE_PROJECT_ID"

   cp build/app/outputs/flutter-apk/app-release.apk build/app/outputs/flutter-apk/matrix-android.apk
   (cd build/app/outputs/flutter-apk && sha256sum matrix-android.apk > matrix-android.apk.sha256)
   ```
   For Play Store distribution:
   ```bash
   flutter build appbundle --release ... # same --build-name/--build-number/--dart-define flags
   ```

4. Clean up `android/release.jks` and `android/key.properties` after local builds if working on shared machines.
5. CI workflow template is ready in `docs/ci/android.yml` (copy to `.github/workflows/android.yml` and configure repository secrets listed at the top of that file).

---

## 4. Wear OS App Build (`mobile/matrix_wear/`)

No `google-services.json` is needed — Wear OS inherits the same `--dart-define=FIREBASE_*` options from `mobile/matrix_app/lib/firebase_options.dart`.

```bash
cd mobile/matrix_wear
flutter create --platforms=android --project-name matrix_wear --org top.thamjj13 .
flutter pub get
flutter analyze --no-fatal-infos
flutter build apk --release \
  --build-name=1.2.0 \
  --build-number=3 \
  --dart-define=QORVYNA_API_BASE=https://qorvyna.thamjj13.top \
  --dart-define=QORVYNA_APP_VERSION=1.2.0 \
  --dart-define=QORVYNA_APP_BUILD=3 \
  --dart-define=FIREBASE_API_KEY="$NEXT_PUBLIC_FIREBASE_API_KEY" \
  --dart-define=FIREBASE_APP_ID="$NEXT_PUBLIC_FIREBASE_APP_ID" \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID="$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID" \
  --dart-define=FIREBASE_PROJECT_ID="$NEXT_PUBLIC_FIREBASE_PROJECT_ID"
```

---

## 5. Publishing an OTA Update Across Web, Desktop & Mobile

1. Update version constants together:
   - `src/lib/version.ts` (`APP_VERSION`, `APP_BUILD_NUMBER`)
   - `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
   - `mobile/matrix_app/pubspec.yaml` (`version: X.Y.Z+BUILD`)
   - `public/sw.js` (`CACHE_VERSION`)
2. Tag `mobile-vX.Y.Z` to publish `matrix-android.apk` + `.sha256` to GitHub Releases.
3. Open **Admin → App Releases** (or call `saveAppReleaseConfig`) with the new version, build number, APK URL, SHA-256, and optional `force_update: true` / `min_supported_version`.
4. All clients (`PwaManager`, `PhoneUpdateBanner`, `UpdateService` on Android, and Tauri Desktop) query `GET /api/app/version` and present an instant in-app update prompt.
