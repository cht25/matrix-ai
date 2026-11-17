# QORVYNA AI — Windows Manual Build Guide

> Release **1.2.0** (build **3**) · identifier **`ai.matrix.desktop`** · Tauri **2**
> This guide builds the **existing** application from Windows PowerShell, without
> the online Agent build. Nothing here creates a second app: the Windows and
> Android shells load the **same shared frontend** (`src/`) that the website
> renders, bundled into `public/native/` and shipped **inside** the app.

Everything below was read from this repository — `package.json`,
`package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`src-tauri/capabilities/default.json`, `next.config.ts` and
`scripts/native/*.mjs`. No npm script, path or environment variable is invented.

| Question | Answer (from the repository) |
|---|---|
| Package manager | **npm** — `package-lock.json` is the lockfile; use `npm ci`, never `npm install` |
| Node.js | 20.x or 22.x LTS (Next.js 15.3.3, React 19.1) |
| Tauri CLI | `^2` from `devDependencies` (`@tauri-apps/cli`) — never install it globally |
| Rust | `rustc >= 1.77.2` (MSVC toolchain on Windows) |
| Frontend shipped natively | `public/native/` — `tauri.conf.json → build.frontendDist: "../public/native"` |
| Before-build hook | `tauri.conf.json → build.beforeBuildCommand: "node scripts/native/build-native-frontend.mjs"` |
| Dev URL (dev only) | `http://localhost:3000/native-app` |
| Android min SDK | `24` (`tauri.conf.json → bundle.android.minSdkVersion`) |

---

## Table of contents

1. [Prerequisites and installation](#1-prerequisites-and-installation)
2. [Environment variables](#2-environment-variables)
3. [Install dependencies](#3-install-dependencies)
4. [Frontend production build](#4-frontend-production-build)
5. [Tauri Windows development run](#5-tauri-windows-development-run)
6. [Tauri Windows release build](#6-tauri-windows-release-build)
7. [Android APK build](#7-android-apk-build)
8. [Android AAB build and signing](#8-android-aab-build-and-signing)
9. [Output artifact locations](#9-output-artifact-locations)
10. [Clean rebuild](#10-clean-rebuild)
11. [Common errors and fixes](#11-common-errors-and-fixes)
12. [What was verified, and what was not](#12-what-was-verified-and-what-was-not)

The three scripts in this repository automate sections 3–9 and stop on the first
failure with a non-zero exit code:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
powershell -ExecutionPolicy Bypass -File .\build-android-apk.ps1
powershell -ExecutionPolicy Bypass -File .\build-android-aab.ps1
```

Run them from the repository root. Each one prints every command it executes and
that command's exit code, and it only reports success after it has found the
artifact on disk.

---

## 1. Prerequisites and installation

Open **PowerShell 7** (`pwsh`) or **Windows PowerShell 5.1** as your normal user
(elevation is only needed for the system-wide installers). Run everything from
the repository root.

### 1.1 Node.js and npm

| Tool | Required | Check |
|---|---|---|
| Node.js | 20.x or 22.x LTS | `node -v` |
| npm | 10.x or newer | `npm -v` |

```powershell
winget install OpenJS.NodeJS.LTS
# new terminal, then:
node -v      # v20.x or v22.x
npm -v       # 10.x+
```

If `node -v` prints an older major version, remove the old Node install first —
Next.js 15 will not build on Node 18.

### 1.2 Rust toolchain (MSVC)

Tauri compiles a Rust shell, so Rust and the Microsoft C++ linker are both
required. The MSVC toolchain is mandatory on Windows (the GNU toolchain is not
supported by Tauri's bundler).

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools
```

In the Visual Studio Installer, select the **Desktop development with C++**
workload (this provides `link.exe` and the Windows SDK). Then:

```powershell
rustup default stable-msvc
rustup update stable
rustc --version     # must be >= 1.77.2 (src-tauri/Cargo.toml)
cargo --version
rustc -vV           # host: x86_64-pc-windows-msvc
```

`rustc -vV` must report a `windows-msvc` host. If it reports `windows-gnu`, run
`rustup default stable-msvc`.

### 1.3 WebView2 runtime

The app renders through Microsoft Edge WebView2. Windows 11 ships it; on
Windows 10 install it explicitly:

```powershell
winget install Microsoft.EdgeWebView2Runtime
```

The build script checks the registry for the Evergreen runtime and fails if it
is missing.

### 1.4 Android Studio, JDK, SDK and NDK (Android builds only)

| Tool | Required | Check |
|---|---|---|
| JDK | **17** (Temurin or the JDK bundled with Android Studio) | `java -version` |
| Android SDK Platform | **34** or newer | `sdkmanager --list_installed` |
| Android SDK Build-Tools | **34** or newer | `sdkmanager --list_installed` |
| Android NDK | one installed version (e.g. `27.0.12077973`) | `dir "$env:ANDROID_HOME\ndk"` |
| Rust Android targets | aarch64, armv7, i686, x86_64 | `rustup target list --installed` |

```powershell
winget install EclipseAdoptium.Temurin.17.JDK
winget install Google.AndroidStudio
```

Then, in Android Studio → **SDK Manager** → *SDK Platforms* select **Android 14
(API 34)**, in *SDK Tools* select **Android SDK Build-Tools**, **Android SDK
Platform-Tools**, **Android SDK Command-line Tools** and **NDK (Side by side)**.

Set the environment variables (adjust the paths to your installation):

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Eclipse Adoptium\jdk-17.0.x-hotspot", "User")
# optional but recommended — lets Tauri find a non-default NDK explicitly
[Environment]::SetEnvironmentVariable("NDK_HOME", "$env:LOCALAPPDATA\Android\Sdk\ndk\27.0.12077973", "User")
```

Accept the SDK licences once (the Gradle build fails without this):

```powershell
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
```

Add the Rust targets Tauri cross-compiles for:

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### 1.5 Verify the whole toolchain

```powershell
node -v
npm -v
rustc --version
cargo --version
rustup target list --installed
npx --no-install tauri --version
```

`npx --no-install tauri --version` resolves the CLI from `node_modules`, i.e.
from `devDependencies`. Run `npm ci` first (section 3). Do **not** install
`@tauri-apps/cli` globally: the CLI version must match the `tauri` crate in
`src-tauri/Cargo.toml`.

---

## 2. Environment variables

The desktop and Android shells are **static bundles**: they contain no server
code and no secrets. All authentication, AI, database and Agent work happens on
the existing backend over HTTPS.

### 2.1 Variables read at bundle time

Only the API origin changes what is compiled into `public/native/`:

```powershell
$env:QORVYNA_API_ORIGIN = "https://qorvyna.thamjj13.top"   # default when unset
# NEXT_PUBLIC_APP_URL is used as the fallback when QORVYNA_API_ORIGIN is empty
```

`scripts/native/build-native-frontend.mjs` reads exactly these two names and
writes the origin into the bundle. Set them **before** running the bundle step;
changing them afterwards requires a rebuild.

### 2.2 Variables for the web app (`npm run build`, `npm run dev`)

Copy `.env.example` to `.env.local` and fill it in. The Firebase **web** config
is public by design:

```powershell
Copy-Item .env.example .env.local
```

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_APP_URL=https://qorvyna.thamjj13.top
```

Server-only secrets (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`,
`GROQ_API_KEY`, …) belong to the **server** environment, never to this
repository's client bundle and never to the native build.

### 2.3 What must never be in the native app

- no service-account JSON, no `GROQ_API_KEY`, no Cloudinary secret;
- no `FIREBASE_PRIVATE_KEY`;
- no admin/worker secret (`AUTOMATION_WORKER_SECRET`).

The native bundle only contains `NEXT_PUBLIC_*` values and the API origin, and
the WebView CSP in `src-tauri/tauri.conf.json` restricts it to the QORVYNA
origin, Firebase and the identified media hosts.

---

## 3. Install dependencies

Always use the lockfile — the repo ships `package-lock.json`:

```powershell
npm ci
```

`npm ci` deletes `node_modules` and installs exactly what the lockfile pins. Use
`npm install` only when you are deliberately changing dependencies.

Optional sanity checks before building:

```powershell
npm run typecheck     # tsc --noEmit
npm test              # vitest run — the full suite
```

---

## 4. Frontend production build

Two different "frontend" artifacts exist; pick the one for your target.

### 4.1 The website (`next build`)

```powershell
npm run build
npm run start -- -H 0.0.0.0 -p 3000
```

Output: `.next/` (server + client). This is the web/PWA surface and is what the
backend serves.

### 4.2 The native bundle that ships inside Windows/Android (`public/native/`)

This is the step that makes the installed app render the **real** QORVYNA
frontend from its own bundled files instead of loading a URL:

```powershell
node scripts/native/build-native-frontend.mjs
```

Produced files:

| File | What it is |
|---|---|
| `public/native/index.html` | the shell Tauri loads (`app.windows[0].url = "index.html"`) |
| `public/native/app.js` | esbuild bundle of `src/native/client/entry.tsx` (mounts the same components as the website) |
| `public/native/app.css` | Tailwind output compiled from `src/app/globals.css` |
| `public/native/sw.js` | service worker copy |
| `public/native/fonts/` | KaTeX fonts |

Verify without rewriting anything (fails if a source file is newer than the
bundle):

```powershell
node scripts/native/build-native-frontend.mjs --check
```

`tauri.conf.json` runs this script automatically as `beforeBuildCommand`, so
`npx tauri build` and `npx tauri android build` refresh the bundle themselves.
Running it first (as the PowerShell scripts do) makes a stale-bundle failure
obvious and names the step in the log.

---

## 5. Tauri Windows development run

Two processes: the Next.js dev server and the Tauri window.

```powershell
# Terminal 1 — the web app (devUrl target)
npm run dev

# Terminal 2 — the desktop shell
npm run tauri:dev
```

- `tauri.conf.json → build.devUrl` is `http://localhost:3000/native-app`; the
  dev window therefore needs the Next.js dev server on port **3000**.
- `npm run tauri:dev` is `tauri dev` (`scripts.tauri:dev`).
- Production builds never read `devUrl`; they load `public/native/index.html`
  from the app bundle.

---

## 6. Tauri Windows release build

```powershell
npm run windows:build
```

`scripts.windows:build` = `node scripts/native/build-native-frontend.mjs &&
tauri build`. Equivalent explicit form:

```powershell
node scripts/native/build-native-frontend.mjs
npx --no-install tauri build
```

Restrict formats when you do not need every bundler:

```powershell
npx --no-install tauri build --bundles nsis
npx --no-install tauri build --bundles msi
```

Or use the script, which also validates the toolchain and verifies the output:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1 -Targets nsis
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1 -SkipInstall
```

`bundle.targets` in `tauri.conf.json` is `"all"`, but only Windows bundlers can
run on Windows: `nsis` (setup `.exe`) and `msi`.

### 6.1 The floating assistant (`Ctrl+Shift+Space`)

The installed app has a real system assistant. On Windows it is a second Tauri
window (`label = "assistant"`) created from the **same** bundled frontend
(`index.html?window=assistant` → `src/native/assistant-popup.tsx`), so it shares
the theme, the signed-in session and `/api/ai` with the main window. It is
frameless, always on top, hidden from the taskbar, 400 × 540 and created lazily
on the first hotkey press, then reused.

How to check it after installing:

1. Press `Ctrl+Shift+Space` while another app is focused — the popup appears
   and immediately starts listening.
2. Speak; the transcript is sent **once** (`input_source: "voice"`), the reply
   is shown and read aloud.
3. Press `Ctrl+Shift+Space` again (or `Esc` / the ✕) to hide it; the second
   press opens a new turn without rebuilding the window.
4. "Open app" / "Full app" brings the main window forward
   (`qorvyna_assistant_open_main`).

If the window cannot be created (headless session, broken GPU context) the
hotkey falls back to the in-app Jarvis bar instead of doing nothing. The tray
menu entry "Speak to QORVYNA" also still exists.

The wake phrase ("Hey QORVYNA") is **Android-only** on purpose: a desktop build
does not ship an always-listening model, so the assistant state reports
`wakeWordSupported: false` there rather than pretending.

---

## 7. Android APK build

The Android project does not exist until `tauri android init` generates it.

### 7.1 One-time initialisation

```powershell
npm run android:init
```

`scripts.android:init` = `tauri android init && node
scripts/native/patch-android-manifest.mjs`.

The second command is **not optional**: it copies the Kotlin sources from
`src-tauri/android/app/src/main/kotlin/` into the generated app module and
merges every declaration they need into
`src-tauri/gen/android/app/src/main/AndroidManifest.xml`. That folder is
generated, so the patch is a script (idempotent — running it twice changes
nothing). It adds:

- `QorvynaNotificationListenerService` (notification forwarding);
- `QorvynaAssistantService` with `android:foregroundServiceType="microphone"`
  (floating bubble + on-device wake phrase);
- `AssistActivity` with the `android.intent.action.ASSIST` intent filter, which
  is what makes QORVYNA selectable as the digital assistant;
- `SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE` and `POST_NOTIFICATIONS`.

**Declaring a permission grants nothing.** Every one of these still has to be
allowed by the user on the device, and the app reports the real state through
`qorvyna_assistant_state` either way.

### 7.2 Build

```powershell
# release APK (default)
npm run android:build -- --apk

# debug APK for a test device
npm run android:build -- --debug --apk
```

`scripts.android:build` = `node scripts/native/build-native-frontend.mjs &&
tauri android build`, and the flags are forwarded to `tauri android build`.

Script form (validates JDK 17, SDK 34+, NDK, Rust targets, then verifies the
APK and its signature):

```powershell
powershell -ExecutionPolicy Bypass -File .\build-android-apk.ps1
powershell -ExecutionPolicy Bypass -File .\build-android-apk.ps1 -Debug
powershell -ExecutionPolicy Bypass -File .\build-android-apk.ps1 -Target aarch64
```

### 7.3 Enabling the Android assistant on the device

Open **Settings → Assistant** inside QORVYNA (voice settings → "System
assistant"). The panel reads the state from the Kotlin service; nothing is
assumed:

1. **Floating bubble** — "Allow over other apps" opens the system page
   (`Settings.ACTION_MANAGE_OVERLAY_PERMISSION`), then "Show bubble" starts the
   foreground service. The bubble is draggable; a tap starts a voice turn.
2. **Wake phrase "Hey QORVYNA"** — press "Record phrase" and say it clearly;
   the same screen reports `n/2` samples. The engine is on the device
   (`QorvynaWakeWord.kt`: MFCC + banded DTW against the enrolled templates),
   there is no network call and no vendor model to download. Audio is kept in
   app-private `SharedPreferences`, and "Forget phrase" deletes it.
   The status only turns `ready` after two samples.
3. **Digital assistant role** — "Choose QORVYNA" opens
   `Settings.ACTION_VOICE_INPUT_SETTINGS`; picking QORVYNA there makes the
   system gesture (long-press home / power button) launch `AssistActivity`.
4. On the next launch, `qorvyna_assistant_state` reports
   `overlaySupported`, `wakeWordSupported` and `defaultAssistant` from the
   platform — a grant that has not happened stays `false`.

Foreground service limits: Android 14+ requires the microphone service type
(declared), a visible notification (posted) and the microphone permission
(requested when recording starts). Some OEM builds additionally require
"Autostart" or battery-optimisation exemptions before the service survives a
swipe-away; QORVYNA reports that as a missing state instead of hiding it.

---

## 8. Android AAB build and signing

```powershell
npm run android:build -- --aab
```

Script form:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-android-aab.ps1
```

An `.aab` is the **upload** format for Google Play; it cannot be installed on a
device directly. Use the APK script for installation and device testing.

### Release signing

Nothing in this repository signs a release build for you, and no environment
variable is read by the app for signing. The keystore must be wired into the
**generated** Gradle project, which `tauri android init` writes and which is not
tracked in git:

1. Create the keystore once (never commit it, never paste passwords into the
   repository):

```powershell
keytool -genkeypair -v -keystore $env:USERPROFILE\qorvyna-upload.jks `
  -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 -alias qorvyna
```

2. Create `src-tauri/gen/android/keystore.properties` (generated folder, keep it
   out of version control) containing:

```properties
storeFile=C:/Users/<you>/qorvyna-upload.jks
storePassword=<store password>
keyAlias=qorvyna
keyPassword=<key password>
```

3. Reference that file from `src-tauri/gen/android/app/build.gradle.kts` in a
   `signingConfigs.release` block and apply it to the `release` build type. This
   file is generated by `tauri android init`; the exact block is Gradle's own
   documented syntax and is **not** shipped by this repository, so it is not
   reproduced as if it were verified here.

4. Build and verify the signature:

```powershell
npm run android:build -- --aab
& "$env:ANDROID_HOME\build-tools\34.0.0\apksigner.bat" verify --print-certs `
  .\src-tauri\gen\android\app\build\outputs\apk\release\app-release.apk
```

`build-android-apk.ps1` runs `apksigner verify` for you and **fails** when the
APK is unsigned; `build-android-aab.ps1` runs `jarsigner -verify` and fails the
same way. Google Play rejects both an unsigned APK and an unsigned AAB.

---

## 9. Output artifact locations

All paths are relative to the repository root and are produced by the tools, not
by this guide.

| Target | Command | Artifact |
|---|---|---|
| Windows executable | `npm run windows:build` | `src-tauri\target\release\matrix-ai-desktop.exe` (Cargo package name from `src-tauri/Cargo.toml`) |
| Windows setup (.exe) | `npm run windows:build` | `src-tauri\target\release\bundle\nsis\QORVYNA AI_1.2.0_x64-setup.exe` |
| Windows installer (.msi) | `npm run windows:build` | `src-tauri\target\release\bundle\msi\QORVYNA AI_1.2.0_x64_en-US.msi` |
| Windows debug binary | `npm run tauri:dev` / `npx tauri build --debug` | `src-tauri\target\debug\` |
| Android APK | `npm run android:build -- --apk` | `src-tauri\gen\android\app\build\outputs\apk\<abi>\release\` |
| Android AAB | `npm run android:build -- --aab` | `src-tauri\gen\android\app\build\outputs\bundle\release\` |
| Native frontend bundle | `node scripts/native/build-native-frontend.mjs` | `public\native\` |
| Website build | `npm run build` | `.next\` |

The PowerShell scripts do not trust these paths blindly: they search the output
directories and fail if nothing was produced.

---

## 10. Clean rebuild

```powershell
# Windows
Remove-Item -Recurse -Force .\src-tauri\target, .\public\native -ErrorAction SilentlyContinue
npm ci
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1

# Android
Remove-Item -Recurse -Force .\src-tauri\gen\android\app\build, .\public\native -ErrorAction SilentlyContinue
npm ci
powershell -ExecutionPolicy Bypass -File .\build-android-apk.ps1
```

A full `tauri android init` is only needed again if you delete
`src-tauri\gen\android` entirely:

```powershell
Remove-Item -Recurse -Force .\src-tauri\gen\android
npm run android:init
```

Also useful:

```powershell
cargo clean --manifest-path .\src-tauri\Cargo.toml   # Rust only
npm cache verify                                     # npm cache health
node scripts/native/build-native-frontend.mjs --check # is the bundle stale?
```

---

## 11. Common errors and fixes

| Error | Cause | Fix |
|---|---|---|
| `error: linker 'link.exe' not found` | MSVC build tools missing | Install VS Build Tools with **Desktop development with C++**, reopen the terminal |
| `error: failed to run custom build command for tauri-build` | Rust host is `windows-gnu` | `rustup default stable-msvc` |
| `failed to bundle project: NSIS/WiX not found` | Tauri downloads NSIS/WiX on first run and the machine is offline or behind a proxy | Allow outbound HTTPS, or `npx tauri build --bundles msi` / `--bundles nsis` one at a time |
| `WebView2` missing at runtime (blank window) | Evergreen runtime absent | `winget install Microsoft.EdgeWebView2Runtime` |
| `[native] esbuild is not installed` | `node_modules` absent or partial | `npm ci` |
| `The native frontend bundle is stale` (`--check`) | sources changed after the last bundle | `node scripts/native/build-native-frontend.mjs` |
| Blank window with CSP errors in dev | `connect-src` in `tauri.conf.json` does not list your API origin | Use the documented origin, or extend the CSP deliberately |
| `JAVA_HOME is not set` / `Unsupported class file major version` | wrong JDK | JDK **17**, `JAVA_HOME` pointing at it, new terminal |
| `SDK location not found` / `ANDROID_HOME` warnings | SDK path unset | Set `ANDROID_HOME`; accept licences with `sdkmanager --licenses` |
| `NDK not configured` | no NDK installed | `sdkmanager "ndk;27.0.12077973"` or set `NDK_HOME` |
| `error: failed to find target aarch64-linux-android` | Rust Android target missing | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| Gradle `Unsupported class file major version 6x` | JDK newer than 17 used by Gradle | Point `JAVA_HOME` at JDK 17 for the build |
| `apksigner: command not found` | Build-Tools not on `PATH` | Call it by full path under `%ANDROID_HOME%\build-tools\<version>\` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` when installing an APK | the installed app was signed with another key | Uninstall the previous build first |
| `npm ci` fails after editing `package.json` | lockfile out of sync | Commit the lockfile change, or run `npm install` deliberately and commit the result |
| `EACCES`/`EPERM` during build | a previous build still holds files, or OneDrive sync is locking the repo | Close the app/terminal, move the repo outside OneDrive, retry |
| `npm warn exec The following package was not found and will be installed: @tailwindcss/cli` | the bundler compiles the stylesheet with `@tailwindcss/cli` through `npx`, and it is not a dependency in `package.json` | Ignore on a normal machine (it is fetched once and cached). On an offline/proxied machine, run the bundle step once with network access |
| `!` PowerShell marks a passed string red | **Pass arguments positionally**, so do not worry: see note below | — |

Note on passing `--debug --apk` through npm: the extra `--` is required
(`npm run android:build -- --apk`) so npm does not swallow the flags.

---

## 12. What was verified, and what was not

Honesty matters more than a green checkmark.

**Verified in this repository / CI-equivalent environment (Linux sandbox):**

- `npm ci` completes against `package-lock.json`.
- `npm run typecheck` passes.
- `npm test` (vitest) passes, including the build pipeline, voice and native
  wiring suites.
- `tests/windows-build-guide.test.ts` asserts that every npm script, file path
  and artifact name in this guide exists in the repository, and that the three
  PowerShell scripts keep their failure behaviour (`$ErrorActionPreference =
  'Stop'`, non-zero exit, no skipped steps).
- `node scripts/native/build-native-frontend.mjs --check` is the same staleness
  check the build hook runs.

**NOT verified by execution (no Windows, no MSVC, no Android SDK in this
environment):**

- `npm run tauri:dev` / `npm run windows:build` / `npx tauri build` — the Windows
  installers were **not** produced here. Treat the exact installer file names in
  §9 as the names Tauri derives from `productName` + `version` + target triple;
  confirm them on the machine that builds.
- `npm run android:init`, `npm run android:build -- --apk`,
  `npm run android:build -- --aab` — no JDK/Android SDK/NDK here, so no APK or
  AAB was produced.
- Release signing for both platforms: the keystore wiring in §8 lives in the
  generated Gradle project and is documented, not executed.
- The PowerShell scripts parse-checked and were reviewed line by line, but they
  have not been run on Windows.
- The assistant itself: no Windows host and no Android device were available.
  What *was* executed here: the shared frontend build (`npm run build`), the
  native bundle, `npm run typecheck`, the full vitest suite, and
  `patch-android-manifest.mjs` against a synthetic `gen/android` tree (verified
  idempotent). The Rust sources were **not** compiled (no Rust toolchain in this
  sandbox) and the Kotlin sources were **not** compiled (no JDK/Android SDK), so
  the popup window, the bubble, the ASSIST role and the wake phrase still need
  one run on real hardware — follow §6.1 and §7.3 for that check.
- The wake-phrase accuracy is enrolment-dependent by construction (template
  matching, not a trained keyword model): it recognises the enrolled speaker.
  `tests/assistant-system.test.ts` pins the algorithm's properties, not its
  real-world accuracy.

Run the three scripts on your Windows machine; each prints every command and its
exit code, and refuses to report success unless the artifact is on disk.
