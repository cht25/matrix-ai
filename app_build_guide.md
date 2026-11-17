# QORVYNA AI — Complete App Build & Release Guide

> Release: **v1.2.0** (build **3**) · Identifier: **`ai.matrix.desktop`**
> Canonical web origin: **https://qorvyna.thamjj13.top**

## Architecture: one frontend, three surfaces

QORVYNA has **one** frontend: the Next.js app in `src/`. It is shipped three ways:

| Surface | What ships | How |
|---|---|---|
| Web + PWA | `src/` rendered by Next.js | `next build` / `next start` |
| Windows desktop | `public/native/` — the same `src/` components, bundled | Tauri 2, `src-tauri/` |
| Android | the same `public/native/` bundle inside a Tauri 2 WebView | Tauri 2, `src-tauri/` |

`src/native/` is the **shell adapter** for the bundled build: it provides the
router, image and bridge shims the website's own components expect, and mounts
those same components (AppShell, chat, settings, devices, admin). It is not a
second app and must never be forked into one.

The native shell loads `public/native/index.html` from the app bundle. It does
**not** load `https://qorvyna.thamjj13.top` in a WebView — that URL appears in
`tauri.conf.json` only as an allowlisted API/network policy.

`mobile/` (Flutter) is the **retired** previous approach. It is kept only for
history; nothing below builds from it.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20.x or 22.x LTS | `node -v` |
| npm | 10.x+ | `npm -v` |
| Rust (desktop + Android) | `rustc >= 1.77.2` | `rustc --version` |
| Java (Android only) | OpenJDK 17 | `java -version` |
| Android SDK (Android only) | Platform 34+, Build-Tools 34+ | `sdkmanager --list_installed` |
| Tauri CLI | `^2` (already a devDependency) | `npx tauri --version` |

Tauri CLI is declared in `package.json` (`@tauri-apps/cli`), so `npm ci` is
enough — do not install it globally.

Linux also needs the WebKitGTK stack:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Windows needs Microsoft Edge WebView2 Runtime and Visual Studio C++ Build Tools.
macOS needs `xcode-select --install`.

Verify the toolchain in one step:

```bash
npm ci
npx tauri info        # reports missing Rust/WebKit/Android pieces explicitly
```

---

## 2. Environment variables

Copy `.env.example` to `.env.local` for local work, and set the same names on
the server. These are the **exact** names read by the code — nothing else is
consulted.

### Public (safe in the browser)

```
NEXT_PUBLIC_APP_URL=https://qorvyna.thamjj13.top
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
```

`NEXT_PUBLIC_QORVYNA_NATIVE=1` is set automatically by the native bundle build
script; do not set it by hand.

### Server-only secrets (never prefixed `NEXT_PUBLIC_`)

```
# Firebase Admin
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
GOOGLE_APPLICATION_CREDENTIALS=          # alternative to the three above

# Models
GROQ_API_KEY=                            # GPT OSS 120B (openai/gpt-oss-120b)
GROQ_API_KEYS=                           # optional comma-separated key pool
GPT_OSS_API_KEY=                         # optional dedicated OpenAI-compatible endpoint
GPT_OSS_BASE_URL=
GPT_OSS_MODEL=
CLOUDFLARE_ACCOUNT_ID=                   # Cloudflare Workers AI
CLOUDFLARE_API_TOKEN=                    # @cf/zai-org/glm-4.7-flash (artifacts)
TOGETHER_API_KEY=                        # optional image generation
OPENAI_API_KEY=                          # optional STT/TTS backup

# Email (Resend, dual-sender with automatic fallback)
RESEND_API_KEY=
RESEND_FROM_PRIMARY=no-reply@qorvyna.top
RESEND_FROM_FALLBACKS=no-reply@matrix.thamjj13.top,no-reply@qorvyna.thamjj13.top

# Pairing / security peppers
PAIRING_HMAC_SECRET=
IDENTITY_PEPPER=
ADMIN_BOOTSTRAP_KEY=                     # first admin setup only

# Optional media storage
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

The native shell's API origin defaults to `https://qorvyna.thamjj13.top` and can
be overridden at **bundle** time (not runtime) with `QORVYNA_API_ORIGIN`:

```bash
QORVYNA_API_ORIGIN=https://staging.example.com node scripts/native/build-native-frontend.mjs
```

### Email sender rules

- Only senders whose **domain is verified in Resend** (SPF + DKIM) may be used.
- Fallback to the next sender happens **only** for an unverified/disallowed
  sender-domain error. It never happens on 401 invalid key, invalid recipient,
  429 rate limit, or a 5xx outage — those are reported, not masked.
- Delivery metadata is logged to `email_delivery_logs`; sender health to
  `email_sender_health`. Both are visible at `/admin/email` (`system.settings`).
- Verify what the server actually accepts:

```bash
npx firebase emulators:start --only auth,firestore   # optional local stack
npm run dev
```

---

## 3. Web / PWA build

```bash
npm ci
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — full suite
npm run build            # next build
npm run start -- -H 0.0.0.0 -p 3000
```

Offline/PWA pieces that must stay in sync with the release:

| Piece | Location |
|---|---|
| Service worker + `CACHE_VERSION` | `public/sw.js` (`qorvyna-cache-v1.2.0-b3`) |
| Offline fallback route | `src/app/offline/page.tsx` (`/offline`) |
| Connectivity probe | `GET /api/ping` |
| IndexedDB store | `src/lib/client/offline-store.ts` (`qorvyna_offline_v1`) |
| Update check | `GET /api/app/version?platform=web` |

Deployment configs present in the repo: `apphosting.yaml` (Firebase App
Hosting), `render.yaml` (Render), `firebase.json` (Hosting + frameworks).
Database rules:

```bash
npm run deploy           # firestore rules, firestore indexes, storage
```

---

## 4. Native frontend bundle (`public/native/`)

This step is **required** before any desktop or Android build. It compiles the
real `src/` components into a static bundle the WebView can load from disk.

```bash
node scripts/native/build-native-frontend.mjs           # build
node scripts/native/build-native-frontend.mjs --check   # verify without writing
```

Output (all generated, safe to delete and rebuild):

```
public/native/app.js       ~2.7 MB   esbuild bundle of src/native/client/entry.tsx
public/native/app.css      ~24 kB    Tailwind CLI output compiled from src/app/globals.css
public/native/index.html   ~0.8 kB   shell that links the two files above
public/native/sw.js                  copied service worker
public/native/fonts/                 KaTeX fonts
```

Notes that matter if you change the build:

- The CSS is compiled by the **Tailwind CLI** (`npx @tailwindcss/cli`), not by
  esbuild. `src/native/client/entry.tsx` must not import `globals.css` —
  esbuild cannot resolve Tailwind v4 export conditions.
- `tauri.conf.json` sets `beforeBuildCommand` to this script, so
  `npx tauri build` refreshes the bundle automatically.

---

## 5. Windows desktop build

Prerequisites: Rust + WebView2 + MSVC build tools (see §1).

```bash
npm ci
npm run windows:build
```

`windows:build` = `node scripts/native/build-native-frontend.mjs && tauri build`.

Artifacts:

```
src-tauri/target/release/bundle/nsis/QORVYNA AI_1.2.0_x64-setup.exe
src-tauri/target/release/bundle/msi/QORVYNA AI_1.2.0_x64_en-US.msi
```

`bundle.targets` is `all`, so the same command also produces `.deb`/`.AppImage`
on Linux and `.dmg`/`.app` on macOS.

### Desktop development loop

```bash
# Terminal 1 — the web app the shell's devUrl points at
npm run dev

# Terminal 2 — the Tauri window
npm run tauri:dev
```

`devUrl` is `http://localhost:3000/native-app`, and `/native-app` is a public
route that performs its own client-side auth gate. Production builds never use
`devUrl`.

---

## 6. Android build (Tauri 2)

Prerequisites: Rust with Android targets, OpenJDK 17, Android SDK 34+, plus:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### One-time project init

```bash
npm run android:init
```

`android:init` = `tauri android init` **then**
`node scripts/native/patch-android-manifest.mjs`.

The second command is not optional: it merges the
`QorvynaNotificationListenerService` declaration into the manifest Tauri
generates at `src-tauri/gen/android/app/src/main/AndroidManifest.xml`. That
directory is generated and gets regenerated, so the patch is kept in a script
(idempotent — running it twice leaves one declaration).

Declaring the service grants **no** access. Android enables a
`NotificationListenerService` only when the user turns it on in
Settings → Notifications → Device & app notifications → QORVYNA. Until then
`onListenerConnected` never fires and nothing is forwarded.

### Build

```bash
# Debug APK for a device
npm run android:build -- --debug --apk

# Release APK
npm run android:build -- --apk

# Play Store AAB
npm run android:build -- --aab
```

Artifacts land under
`src-tauri/gen/android/app/build/outputs/apk/…` (or `bundle/…` for AAB).

### Signing (release)

1. Create an upload keystore — **never commit it**:

```bash
keytool -genkey -v -keystore qorvyna-upload.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias qorvyna
```

2. Point the Android Gradle project at it via environment variables (do not
   write passwords into the repo):

```bash
export QORVYNA_KEY_STORE=/absolute/path/qorvyna-upload.jks
export QORVYNA_KEY_STORE_PASSWORD=...
export QORVYNA_KEY_ALIAS=qorvyna
export QORVYNA_KEY_PASSWORD=...
```

3. Build, then verify the signature and publish a checksum:

```bash
npm run android:build -- --apk
apksigner verify --print-certs src-tauri/gen/android/app/build/outputs/apk/release/app-release.apk
sha256sum src-tauri/gen/android/app/build/outputs/apk/release/app-release.apk \
  > qorvyna-android.apk.sha256
```

Android identifiers: application id `ai.matrix.desktop`, `minSdkVersion` 24.

---

## 7. Native capabilities (what JS may call)

`src-tauri/capabilities/default.json` is an allowlist. Only these plugin
permissions are exposed; anything else is denied by the runtime.

Native commands registered in `src-tauri/src/lib.rs` (invoke handler):

| Command | Purpose |
|---|---|
| `qorvyna_native_info` | platform + app metadata |
| `qorvyna_permission_status` / `_request` / `_settings` | first-run permission checklist |
| `qorvyna_assistant_state` | local wake-word availability |
| `qorvyna_wake_word_set` | enable/disable on-device wake word |
| `qorvyna_assistant_default_request` | ask to become the default assistant |
| `qorvyna_assistant_popup` | show/hide the Jarvis popup (`show`/`hide` only) |
| `qorvyna_device_fingerprint` | non-secret install id |
| `qorvyna_inspection_state` / `_stop` | inspection transparency |
| `matrix_notify`, `matrix_collect_device_activity` | desktop notifications, telemetry |
| `qorvyna_desktop_info`, `desktop_hardware_status` | hardware telemetry |
| `launch_app`, `media_control` | allowlisted app launch and media keys |

No generic "run arbitrary command" bridge exists, and the shell plugin is
configured for a fixed allowlist only.

### Permissions the app asks for (all optional)

`src/native/native-bridge.ts` → `PERMISSION_CATALOG`. Every entry is
`required: false`: chat works with all of them denied.

| Id | Needed for | Android only |
|---|---|---|
| `notifications` | local notifications | no |
| `notification_access` | notification forwarding (user enables in Settings) | yes |
| `microphone` | voice input **after** the wake word | no |
| `background_microphone` | on-device wake word while backgrounded | yes |
| `overlay` | Jarvis popup over other apps | yes |
| `assistant_role` | "Hey QORVYNA" as system assistant | yes |
| `battery_optimization` | keep the wake-word service alive | yes |
| `screen_capture` | screen mirroring (MediaProjection consent each time) | no |

QORVYNA never promises universal always-listening. Wake-word detection is
local; there is no continuous cloud microphone stream.

---

## 8. Inspection transparency

An admin inspection is implemented in `src/lib/server/inspection.ts` and is
visible by design:

1. An admin with `privacy.access` creates a request. Nothing is inspected yet.
2. Guardian-protected accounts (verified `parent_links`) require the guardian to
   approve first — an e-mail address is never treated as a guardian.
3. The target device shows a persistent bar naming the admin, the reason, the
   scopes and a countdown. The session starts **only** after that device
   confirms.
4. The owner, the approving guardian, or the requesting admin can stop it at any
   time; the next check stops everything.
5. `messages`, `passwords`, `tokens`, `pairing_secrets`, `keystrokes` and
   `other_apps` are rejected as scopes at creation.

To audit what happened:

```bash
# Firestore collections
inspection_requests     inspection_events     admin_audit_log
```

---

## 9. Cross-account device pairing

Two devices on **different** accounts pair without either account logging into
the other. Implemented in `src/lib/server/device-links.ts`.

- The invitation secret is 256 bits from `crypto.randomBytes`; only
  `sha256(secret)` is stored, so a database dump cannot replay it.
- The human code is 8 characters from an alphabet without `0/O/1/I/L`, valid for
  **10 minutes**, rate-limited to 5 per account per hour, and **single-use**
  (the claim is consumed inside a transaction).
- Either side can revoke; revocation writes an audit event for both accounts.
- Admins see a boolean "credential present" and pairing history — never a token
  or its hash.

Verify the rules:

```bash
npx vitest run tests/device-links.test.ts tests/admin-devices.test.ts
```

---

## 10. Version bump checklist

Update all of these together, or clients will disagree about what is installed:

```
package.json                  "version": "1.2.0"
src-tauri/tauri.conf.json     "version": "1.2.0"
src-tauri/Cargo.toml          version = "1.2.0"
src/lib/version.ts            APP_VERSION = "1.2.0", APP_BUILD_NUMBER = 3
public/sw.js                  CACHE_VERSION = "qorvyna-cache-v1.2.0-b3"
```

Then rebuild the native bundle (`node scripts/native/build-native-frontend.mjs`)
because the version is compiled into it.

## 11. Release publishing

1. Tag and push.
2. Upload the Windows installer, APK and AAB to the GitHub release, plus
   `.sha256` files.
3. Register the release in Admin → App Releases (`/admin/app-releases`) with
   version, build number, download URL, SHA-256, and optionally
   `force_update: true` / `min_supported_version`.
4. Every client polls `GET /api/app/version` (`platform=web|android|desktop`) and
   shows an in-app update prompt.

---

## 12. Verification commands (run these before shipping)

```bash
npm run typecheck                                   # TypeScript
npm test                                            # full vitest suite
node scripts/native/build-native-frontend.mjs --check   # bundle is current
npx tauri info                                      # toolchain + config sanity

# Focused suites for the risky areas
npx vitest run tests/device-links.test.ts           # cross-account pairing
npx vitest run tests/admin-devices.test.ts          # admin dashboard + RBAC
npx vitest run tests/inspection.test.ts             # inspection consent chain
npx vitest run tests/notification-forwarding.test.ts
npx vitest run tests/native-shell.test.ts tests/native-render.test.ts
npx vitest run tests/native-build-wiring.test.ts
```

### Known sandbox limitations (honest status)

The following could not be executed in the development sandbox used for this
work, and are therefore **unverified by execution** (the code is written and
reviewed, not compiled):

| Not run | Why | How to verify |
|---|---|---|
| `cargo build` / `tauri build` | no Rust toolchain in the sandbox | `npx tauri build` on a machine with Rust |
| `tauri android build`, APK/AAB | no JDK or Android SDK | `npm run android:build -- --apk` |
| Kotlin listener on a device | no emulator/physical device | install the APK, enable notification access |
| Real browser E2E | no usable Chromium | `npm run test:browser` (Playwright) |
| Resend live delivery | no API key | `/admin/email` → send test email |

Everything TypeScript/React is covered by the test suite and `tsc --noEmit`
runs clean.
