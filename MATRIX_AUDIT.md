# MATRIX repository audit

**Audit date:** 2026-11-07 (UTC)
**Repository:** `cht25/matrix-ai`
**Branch:** `arena/7e13bf1b-matrix-ai`
**Base commit:** `a2896418cd2f3f9d0ce963ca53dea105fbabbbd4`

## Executive summary

MATRIX is an existing Next.js/Firebase product, not a blank starter. It contains the primary responsive website, Firebase authentication and Firestore persistence, a server-side AI gateway, project/build/deployment workflows, family and device pairing, admin/RBAC, legacy Flutter clients, and extensive regression tests. Preserve Firebase Auth identities and Firestore as canonical storage; no production data was accessed or changed during this audit.

This repository has substantial prior implementation and hardening. The requested ecosystem is **not** fully production complete: no Tauri shell, ESP32 firmware, MQTT transport, native Android companion for authorized usage telemetry/MediaProjection, or screen-sharing transport exists. Some integrations require provider credentials and real-account/hardware verification. The code/tests establish particular contracts but do not prove live service availability.

## Repository and runtime inventory

- **Frontend:** Next.js 15 App Router, React 19, Tailwind CSS 4; route groups for the authenticated app and authentication; responsive application shell, desktop navigation, and mobile navigation.
- **Authentication:** Firebase client Auth; server session-cookie verification and Firebase bearer verification; email/password and OAuth UI/routes; separate admin layout/RBAC surfaces. Live OAuth/email delivery has not been exercised in this sandbox.
- **Persistence:** Firestore via Firebase Admin SDK for server writes and Firebase client SDK for permitted reads; Firestore rules default to deny for writes. `seed/0007_seed.sql` is historical SQL content, not a Firestore migration and must not be applied to production.
- **AI:** `/api/ai` is the server gateway and SSE streaming endpoint. Existing transports cover Groq, OpenRouter, configurable OpenAI-compatible services, Gemini via Google's OpenAI-compatible endpoint, Anthropic's Messages API, and Ollama via an OpenAI-compatible endpoint; model catalog/health checks, fallback logic, request logging, and PII handling are present. Model IDs are account-specific; this does not establish Gemini availability or a fixed quota.
- **Agent/build:** `/api/build`, project file tree/editor, Firestore-backed project files and revisions, durable build/task records, static build validation, staged publication, verified public URL, and rollback paths exist. Arbitrary generated backend execution is intentionally not available; there is no isolated general-purpose code runner.
- **Preview/deployment:** authenticated sandboxed project preview and `/s/<slug>` publication; Firestore/static provider and Vercel/GitHub integrations exist. Production deployment and provider credentials were not exercised. URL resolution is configuration-driven and now normalizes to a trusted configured origin rather than deriving from request Host headers.
- **Canvas:** current Canvas route is based on persistent project/workspace files; it is not a complete freeform visual/diagram canvas with document-version UX.
- **Family/devices:** family/invitation/QR flows, email adapter, MATRIX Connect pairing challenges, scoped revocable device credentials and device APIs exist. No ESP32/MQTT device command path exists.
- **Automation:** Firestore schedule records, timezone-aware due-time calculation, leases, run logs and a separate worker endpoint/script exist. The worker must be deployed separately and configured; its presence does not mean scheduled jobs are running in production.
- **Native/mobile:** two legacy Flutter projects exist under `mobile/`; no Tauri project or authorized Android family companion is present. Flutter builds were not run because no Flutter SDK/device is available in this environment.
- **Deployment configuration:** Firebase/App Hosting and Render manifests plus environment templates exist. Configuration parity and deployment credentials require operator review; this audit did not deploy anything.

## Existing tests and local verification

Executed in this checkout after dependency installation:

- `npm ci --no-audit --no-fund` — passed (955 packages installed; npm emitted dependency deprecation notices).
- `npm run typecheck` — passed with the URL-resolution repair.
- `npm test -- --reporter=dot` — **72 test files, 651 tests passed** with the URL-origin and worker-target regressions.
- `npm run build` — optimized Next.js production build completed; all routes compiled.

Tests include route/provider contracts, Firestore doubles, project persistence and deployment verification, security boundaries, device pairing, scheduling, and responsive-navigation checks. Most are unit/contract tests, not production integration tests. No real account, production database, third-party AI, email provider, deployment account, or hardware workflow was invoked.

## Important confirmed limitations / root causes

1. **Public-origin and worker-target configuration must be explicit and safe.** The former resolver accepted almost any HTTP(S) `NEXT_PUBLIC_APP_URL` as an origin and retained path/query context accidentally. It now validates scheme and unsafe host classes, falls back to `https://matrix.thamjj13.top`, and uses only the parsed origin. The automation worker also requires an explicit HTTPS application target and refuses production localhost/private-IP targets. Neither trusts request Host headers.
2. **Provider coverage remains incomplete relative to the requested product.** Gemini, Anthropic, and Ollama adapters are present, but their live account credentials/models are unverified here; no claim is made that any particular Gemini model or quota is available to MATRIX accounts.
3. **Agent build execution is intentionally constrained.** Static site generation/build and durable project workflows are implemented; arbitrary server/backend/database generation cannot be safely run without an isolated worker and explicit deployment adapters.
4. **Device and family support is software/account-level only.** Device pairing is not ESP32 provisioning. Browser APIs cannot provide hidden/background mobile monitoring, installed-app inventory, or unrestricted history.
5. **Native ecosystem gaps remain.** Tauri native integrations, Android MediaProjection/foreground service companion, Web Push delivery worker, MQTT broker/device firmware, and secure OTA signing are not present.
6. **Credentials and environment access are unavailable here.** Production auth/email/provider/deploy workflows and live database behavior could not be demonstrated.

## Preservation and safety

- No production database read or write was performed.
- No historical SQL seed was treated as a migration.
- Existing routes, Firebase identity, Firestore collections and user data are preserved.
- No untrusted generated code is executed in the Next.js application process.
- No production deployment was attempted.

See `SYSTEM_ARCHITECTURE.md`, `FEATURE_IMPLEMENTATION_STATUS.md`, `SECURITY_AUDIT.md`, and `DEPLOYMENT_GUIDE.md` for detailed follow-up and configuration.
