# MATRIX deployment and operations guide

This repository contains the primary Next.js website and Firebase integration. Deploy to a staging project first. Do not run migrations, seed scripts, Firebase rules deployment, or production publishing without reviewing the target project and taking a recoverable backup.

## 1. Prerequisites

- Node.js version compatible with the lockfile/Next.js 15 and npm.
- Firebase project with Firebase Authentication and Firestore enabled.
- A server runtime that supports Next.js route handlers and the configured request timeouts.
- A public HTTPS canonical origin and correct auth-domain configuration.
- Optional services: AI provider account, Cloudinary, Resend, GitHub OAuth, Vercel.

## 2. Local setup

```bash
npm ci
cp .env.example .env.local
# Fill only the required values; never commit .env.local.
npm run typecheck
npm test
npm run dev
```

For isolated local integration testing, use Firebase emulators:

```bash
npm run emulators
```

Use a dedicated test Firebase project/emulator data, not production data. `npm run seed` is an explicit data operation; inspect its dry run before use. `seed/*.sql` is not an active Firestore migration.

## 3. Required and optional environment inventory

All secret values must be configured in the host's encrypted secret manager, never checked into Git or returned to the browser.

### Public Firebase web configuration

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` (Firebase `*.firebaseapp.com` / `*.web.app` auth handler; code derives the project default if a custom app host is unsuitable)
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_APP_URL` — exact canonical HTTPS origin in production. `siteOrigin()` normalizes to URL origin and rejects local/private hosts and production HTTP. It never derives canonical URLs from request Host headers.

### Firebase Admin server identity (one of)

- `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`, or
- platform Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` / supported host identity).

Keep service-account permissions least-privileged. Do not expose the private key as a `NEXT_PUBLIC_*` variable. On Render-style hosts, preserve escaped newlines in the private key value.

### AI model secret (GPT OSS 120B only)

MATRIX uses exactly one language model: **GPT OSS 120B**, Groq model ID `openai/gpt-oss-120b`. The ID is defined in `src/lib/ai/model.ts` and cannot be changed by environment variable. There is no alternative provider and no fallback.

- `GROQ_API_KEY` — required. Also used for Whisper speech-to-text (`GROQ_AUDIO_MODEL`, default `whisper-large-v3-turbo`).
- Optional dedicated endpoint for the same model: `GPT_OSS_API_KEY` + `GPT_OSS_BASE_URL` (both required together; replaces the Groq route rather than backing it up).
- `OPENAI_API_KEY` — optional, speech only: second speech-to-text service (`OPENAI_AUDIO_MODEL`) and read-aloud (`OPENAI_TTS_MODEL`). Never used for text generation.
- `TOGETHER_API_KEY`, `TOGETHER_IMAGE_MODEL` for the optional image generation service.
- `PROVIDER_SECRET_KEY` — a dedicated randomly generated key (e.g. `openssl rand -base64 32`) for encrypting the administrator-saved image-generation key.

Variables from earlier releases (`GLM_*`, `ZAI_API_KEY`, `GEMINI_*`, `OPENROUTER_*`, `ANTHROPIC_*`, `OLLAMA_*`, `GROQ_CHAT_MODEL`, `GROQ_CODING_MODEL`, `GROQ_VISION_MODEL`) are no longer read and can be deleted from the host. GPT OSS 120B is text-only, so image analysis (chat image attachments, the screenshot scanner) is unavailable.

### Optional application integrations

- Cloudinary: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
- Resend family email: `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (verified sending domain required). Invitation records are not proof of actual delivery; configure and test delivery webhooks/status in staging.
- GitHub OAuth: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN_ENCRYPTION_KEY` (at least 32 random characters), `GITHUB_OAUTH_CALLBACK_URL` (exact deployed callback).
- Vercel: `VERCEL_TOKEN`, optional `VERCEL_TEAM_ID`, `VERCEL_APPS_DOMAIN` (for the deployment adapter's approved parent domain).
- Security: `IDENTITY_PEPPER` and `ADMIN_BOOTSTRAP_KEY` (strong random values; bootstrap key is temporary and should be rotated/removed after secure first-admin setup); optional `PAIRING_HMAC_SECRET` (dedicated random key for signed pairing challenges).
- Proxy/egress configuration: `MATRIX_TRUST_PROXY_HEADERS` only when a trusted proxy overwrites forwarded headers; `AI_ALLOW_LOCAL_HTTP` should not be enabled on a public production deployment.
- Automation worker: `AUTOMATION_WORKER_SECRET` (at least 32 random characters), `MATRIX_WORKER_TARGET_URL` (reachable HTTPS application URL), optional `AUTOMATION_POLL_MS` (minimum 10 seconds).

`NEXT_PUBLIC_FIREBASE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST`, and `AI_ALLOW_LOCAL_HTTP` are local/test controls. Do not accidentally carry emulator or insecure-provider configuration into production.

## 4. Build and deploy

```bash
npm ci
npm run typecheck
npm test
npm run build
```

- The primary web application is Next.js. `npm run deploy` in this repository deploys **Firebase Firestore rules/indexes and Storage configuration**, not the Next.js website; inspect `package.json` and the selected host pipeline.
- Review `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `apphosting.yaml`, and `render.yaml` against the target project before deployment.
- Take/verify a Firestore export or equivalent backup, deploy to staging, validate auth and rules, then deploy through the chosen controlled release process.
- No production deploy is performed by this guide or by the source audit.

## 5. Authentication and domain configuration

1. Add the production and staging domains to Firebase Authentication authorized domains.
2. Configure Google (and any other OAuth providers) in Firebase Console and use the Firebase-hosted auth handler.
3. Configure password reset/verification email templates and sender behavior.
4. Configure custom claims/admin role assignment only through the authorized server tools. Never infer admin from a route, email domain, or client claim alone.
5. Configure `NEXT_PUBLIC_APP_URL` to the canonical TLS origin and validate generated family/deployment/SEO links.
6. Use dedicated test accounts for ordinary, family, device and administrator roles.

## 6. Firestore changes, backup and recovery

- Firestore is the production database; there is no SQL schema/migration runner in this repository.
- Do not run `seed/0007_seed.sql` against Firestore.
- Review security rules/index diffs and test with Firebase emulators before deploying.
- Preserve existing collections/documents; additive changes should be backward compatible. Back up before any data rewrite.
- Configure scheduled Firestore exports, retention/access control, alerting and a documented restore drill. A passing test suite does not prove backup recovery.

## 7. Automation worker

Scheduled automations require the independent worker; a website process/browser tab is not a scheduler.

```bash
AUTOMATION_WORKER_SECRET='(secret manager value)' \
MATRIX_WORKER_TARGET_URL='https://matrix.example.com' \
node scripts/automation-worker.mjs
```

Run it under a process supervisor with restart policy, bounded CPU/memory, log redaction and health monitoring. The endpoint validates the bearer secret, claims due records transactionally, and records execution history. Configure the target URL; do not rely on the local development default in production. Test duplicate worker/concurrent claims, paused tasks, failure/retry behavior and timezone/DST handling in staging.

## 8. Deployment / URL acceptance checks

Before calling a deployment successful, confirm:

1. The user's project owns non-empty persisted files and an entry document.
2. Build validation completes and artifacts are generated.
3. The deployment provider reports readiness.
4. The final configured URL responds over HTTPS with a valid document and expected project content/assets.
5. No public URL contains localhost, a loopback/private host, container address or development port.
6. Failure leaves the prior deployment intact and UI reports the actual failure.
7. Rollback is available and validated.

The project preview is not production deployment. External domains require real DNS/hosting ownership validation. No live production reachability is asserted by this repository guide.

## 9. Environment status and limits

The public Firebase client variables are intentionally public identifiers. Every Firebase Admin, AI, Cloudinary, Resend, GitHub, Vercel, encryption, pepper, pairing and worker secret is server-side only. There is no Tauri/native integration, MQTT broker or ESP32 firmware in the current checkout, so no native/hardware environment variables are currently defined. Do not claim native, family telemetry, screen-sharing, device or hardware features are ready without implementing and verifying the required components.
