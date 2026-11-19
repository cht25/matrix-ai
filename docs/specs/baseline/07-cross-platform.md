# Baseline 07 — Cross-platform desktop and Android support

**Status:** Partial — a Tauri 2 desktop shell, Android configuration, and
Flutter clients exist in source. No Windows or Android release build was
performed for this baseline, and no real-device verification is claimed.

**Evidence:** `src-tauri/{tauri.conf.json,Cargo.toml,capabilities/default.json,src/}`,
`scripts/native/{build-native-frontend.mjs,patch-android-manifest.mjs}`,
`build-windows.ps1`, `build-android-apk.ps1`, `build-android-aab.ps1`,
`src/app/native-app/`, `src/native/`, `mobile/README.md`,
`mobile/matrix_app/`, `mobile/matrix_wear/`, `docs/ci/android.yml`,
`tests/{native-shell.test.ts,native-render.test.ts,native-build-wiring.test.ts}`.

## Implemented behavior

- **Web:** the responsive Next.js app is primary. `src/lib/client/` contains
  shared browser helpers (offline store, connectivity, media query, keyboard
  inset, API client).
- **Windows desktop:** `src-tauri` is a Tauri 2 application with Rust commands
  for native notifications, global shortcut, tray, deep links, device/telemetry
  views, and assistant window. `tauri.conf.json` bundles a static frontend from
  `public/native` built by `scripts/native/build-native-frontend.mjs`, uses a
  restrictive CSP, and declares a `qorvyna://` desktop deep-link scheme.
  `capabilities/default.json` grants an explicit, minimal permission set.
- **Android (Tauri):** `bundle.android.minSdkVersion` is 24, with an Android
  project under `src-tauri/android`, manifest patching, and `npm run android:init`
  / `android:build` scripts. These are configuration and build paths, not proof
  of a signed release.
- **Android (Flutter):** `mobile/matrix_app` talks to the same `/api/ai`
  gateway, supports device registration/pairing with Keystore-backed credential
  storage, update checks, and screens for chat/devices/notifications.
  `mobile/matrix_wear` is a Wear OS companion. Both retain their existing
  application IDs for installed-app compatibility.
- Deep links, native update checks, and native build wiring have contract tests
  in `tests/`.

## Boundaries and non-goals

- Native permissions are declared explicitly; web-only features must not widen
  the Tauri capability set.
- The Flutter clients do not read installed apps, usage, or browser history and
  do not report background telemetry.
- No ESP32 firmware, MQTT TLS broker adapter, OTA signing, MediaProjection
  producer, or WebRTC capture/signaling transport is present in source.
- `docs/ci/android.yml` is a ready workflow but is not active; it must be copied
  into `.github/workflows/` by an operator.

## Partial / planned / deprecated

- **Partial:** no verified Windows installer or signed Android APK/AAB from this
  checkout. Flutter compilation and device tests require a local Flutter/JDK
  toolchain.
- **Planned:** Tauri native notification/tray/screen-capture depth, transparent
  family supervision summaries, and consented screen sharing are roadmap work.
- **Deprecated / legacy:** `matrix_app`, `matrix_wear`, and `matrix-android.apk`
  names are intentionally unchanged to keep installed apps updating.
