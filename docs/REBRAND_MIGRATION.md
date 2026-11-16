# MATRIX → QORVYNA: migration notes

The product was renamed from **MATRIX** to **QORVYNA**. This page says what
changed, what was kept on purpose, and what (if anything) you have to do.

Short version: **an existing deployment, account or installed app needs no
action.** Nothing that stores data, identifies an installed app or is written
into something already published was renamed.

## For people using the product

- Same accounts, chats, projects, devices, certificates and settings. Nothing
  was migrated, because nothing moved.
- The assistant is now called **QORVYNA AI**. Asked about the old name, it
  answers that QORVYNA is the new name of the platform formerly called MATRIX.
- Your theme, language and other preferences are kept: the browser keys that
  hold them were not renamed.
- An installed phone or desktop app keeps working and updates in place. Its
  label changes to QORVYNA with the next update.
- Certificates already issued stay valid. Certificate IDs keep the
  `MTRX-CERT-…` format, so every existing ID still verifies.
- Sites already published keep working (see "Published sites" below).

## For whoever operates a deployment

Nothing has to change. Optional clean-up, whenever convenient:

| Setting | New name | Old name (still read) |
|---|---|---|
| Trust the proxy's forwarded host for same-origin checks | `QORVYNA_TRUST_PROXY_HEADERS` | `MATRIX_TRUST_PROXY_HEADERS` |
| Android APK download address | `QORVYNA_ANDROID_APK_URL` | `MATRIX_ANDROID_APK_URL` |
| Android APK checksum | `QORVYNA_ANDROID_APK_SHA256` | `MATRIX_ANDROID_APK_SHA256` |
| Per-model scheduling budget | `QORVYNA_MODEL_TPM_<KEY>` | `MATRIX_MODEL_TPM_<KEY>` |
| Automation worker target | `QORVYNA_WORKER_TARGET_URL` | `MATRIX_WORKER_TARGET_URL` |
| Android build: API base, version, build number (`--dart-define`) | `QORVYNA_API_BASE`, `QORVYNA_APP_VERSION`, `QORVYNA_APP_BUILD` | `MATRIX_API_BASE`, `MATRIX_APP_VERSION`, `MATRIX_APP_BUILD` |

If both names are set, the `QORVYNA_` one wins. The lookup is
`src/lib/brand-env.ts`; it is covered by `tests/rebrand-compat.test.ts`.

All other variables (`GROQ_API_KEY`, `FIREBASE_*`, `CLOUDINARY_*`, `GITHUB_*`,
…) never carried the product name and are unchanged.

## What was kept, and why

Renaming any of these would break data, installs or infrastructure, so they
still contain "matrix". They are identifiers, not branding; none is shown to a
user as the product name.

| Kept | Reason |
|---|---|
| Host `matrix.thamjj13.top`, repository `cht25/matrix-ai`, Render service `matrix-ai`, Firebase project IDs | Live infrastructure. Changing a host or project is a separate, planned operation (DNS, OAuth callbacks, app links). |
| Android application IDs `top.thamjj13.matrix` / `top.thamjj13.matrixwear`, Tauri identifier `ai.matrix.desktop` | A new ID is a different app to the operating system: installed copies would stop updating and lose their data. |
| APK file names `matrix-android*.apk` | Installed apps download the update from this exact address. |
| Folders `mobile/matrix_app`, `mobile/matrix_wear`; Dart classes `MatrixApi`, `MatrixConfig`, `MatrixApp` | Internal names. Renaming them changes nothing a user sees and cannot be compiled and verified in every environment. |
| Browser storage and cookies: `matrix-theme`, `matrix-lang`, `matrix-rain`, `matrix:model-pool`, `matrix.chat.*`, `matrix.device.*`, `matrix_device_credential`, `matrix_signed_in`, `matrix_github_oauth*` | Renaming would silently reset every user's preferences and sign paired devices out. |
| Wire formats: `matrix-pairing:v1`, `matrix-family-pair`, `matrix-esp32:v1`, `.well-known/matrix-domain`, `__matrix_verify`, `x-matrix-verification-token`, provider IDs `matrix-static` / `matrix-inline`, Tauri commands `matrix_notify`, `matrix_collect_device_activity` | Already printed in QR codes, flashed onto devices, placed in DNS or compiled into installed apps. |
| Certificate IDs `MTRX-CERT-…` | Issued certificates must keep verifying. |
| `ROLE_PERMISSION_MATRIX` | The word "matrix" in its ordinary sense. |

## What was renamed, with a bridge where old data exists

| Old | New | Compatibility |
|---|---|---|
| `<<<MATRIX_FILE …>>>` blocks written by the Agent | `<<<QORVYNA_FILE …>>>` | Both are parsed (`FILE_TAG` in `src/lib/ai/agent.ts`), so stored replies and in-flight runs still open. Prompts ask only for the new form. |
| `window.MATRIX_ENV` in published sites | `window.QORVYNA_ENV` | Every published bundle also defines `window.MATRIX_ENV` as an alias, so a site generated before the rename keeps reading its configuration. |
| Response headers `X-MATRIX-Request-ID`, `X-MATRIX-Provider`, `X-MATRIX-Model` | `X-QORVYNA-Request-ID`, `X-QORVYNA-Provider`, `X-QORVYNA-Model` | Diagnostics only. A browser tab still running the previous version shows an error without its reference ID until it reloads; nothing else depends on them. |
| ESP32 sketch constant `MATRIX_ENDPOINT` | `QORVYNA_ENDPOINT` | Only in newly generated sketches. A flashed device carries its own copy. |
| Download names `matrix-*.json` / `.zip` | `qorvyna-*` | File names of new downloads only. |
| npm package name `matrix-ai` | `qorvyna` | Private package; not published. |

## Things that are different on purpose

- **Visual identity.** New logo, colours and icons everywhere (see
  [BRAND.md](./BRAND.md)). The animated "rain" background is gone; the
  appearance setting that controlled it now controls a static background glow
  and keeps its stored value.
- **The assistant's identity.** It introduces itself as QORVYNA AI and answers
  truthfully which model it runs on (see
  [AI_IDENTITY_AND_EXECUTION.md](./AI_IDENTITY_AND_EXECUTION.md)).
- **Requests for real work.** A request such as "Update my project" or "Deploy
  it" is carried out by the Agent or parked for one tap of approval. It is not
  answered with prose (same document).

## Not part of this change

- Moving to a `qorvyna` domain, repository name or application ID. Each needs
  its own rollout: DNS and TLS, OAuth callback and Firebase authorised-domain
  updates, Android app links, and a redirect from the old host.
- Store listings. The product is distributed as a web app and a directly
  downloaded APK.

## Rolling back

The rename is one merge. Reverting it restores the previous name and artwork.
No data migration ran, so there is nothing to undo in Firestore, in browsers or
on devices. The compatibility bridges mean a rollback after new content exists
is also safe in one direction only: content written with `QORVYNA_FILE` would
not be parsed by the older code, so prefer rolling forward once Agent runs have
happened on the new version.
