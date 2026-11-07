# MATRIX system architecture

**Current architecture audited:** 2026-11-07. This describes code present in the repository, not a claim that every external integration is live.

## System overview

```text
Browser / PWA-capable client
  ├─ Next.js App Router: public pages, auth pages, authenticated modules, admin layout
  ├─ Firebase client Auth ── POST /api/auth/session ── httpOnly session cookie
  ├─ /api/rpc ── input validation + session/RBAC/ownership ── Firestore (canonical records)
  ├─ /api/ai ── safety/context/provider routing ── Groq / OpenRouter / OpenAI-compatible
  ├─ /api/build ── durable tasks + build runs ── projects/files/revisions in Firestore
  ├─ /api/projects/*/preview ── authenticated, sandboxed preview
  ├─ /s/<slug> ── published static project files
  ├─ /api/devices/* ── account device registry and scoped device credentials
  └─ /api/jobs/automations ── authenticated scheduler worker endpoint

Firebase Auth ── Admin SDK session/token verification
Firestore ── canonical application storage (server-side privileged writes)
Cloudinary ── signed private media storage (optional)
Provider APIs ── secrets remain server-side
Vercel/GitHub/Resend ── optional third-party integrations, credentials required
Legacy Flutter mobile / Wear clients ── bearer-authenticated API calls
```

## Runtime and repository boundaries

- `src/app/(app)` contains logged-in application areas including chat, canvas, family, devices, projects, models, admin and automations.
- `src/app/api` hosts server route handlers. Middleware handles page-routing UX only; APIs must independently verify identity and authorization.
- `src/lib/firebase` contains client/Admin setup, session, and device credential verification.
- `src/lib/server` contains server-only business operations for Firestore, ownership checks, invitations, pairing, tools, projects, and deployments.
- `src/lib/ai` contains provider transports, routing, safety, model catalog and tool registry.
- `src/lib/deploy` and `src/lib/projects` implement build/deploy/url/path/preview helpers.
- `mobile/` contains legacy Flutter Android clients; native compilation is not verified here.

## Identity, storage, and authorization

Firebase UID is the canonical identity. Firebase Auth is not replaced. Browser mutations pass the shared Origin/Fetch-Metadata guard where applicable; native bearer clients are allowed through that boundary but still require a valid token and route-level authorization. Privileged writes run through Firebase Admin SDK and must be checked for user ownership, family membership, or admin RBAC. Firestore browser rules remain the secondary boundary and should continue to default-deny writes.

Firestore is the persistence system. Existing collections include (non-exhaustive): `users`, `profiles`, `conversations`, `messages`, `projects`, project file/version subcollections, `build_runs`, `agent_tasks`, `published_sites`, `deployments`, `families`, `family_invitations`, `devices`, `pairing_challenges`, `automations`, `automation_runs`, `tool_approvals`, `ai_usage_logs`, and `audit_logs`. There are no SQL migrations to run against this Firestore deployment; `seed/*.sql` is not a migration mechanism.

## AI and execution model

`/api/ai` is the chat gateway and returns provider output/errors rather than fabricated success. Existing transports: Groq, OpenRouter, administrator-configured OpenAI-compatible endpoints, Gemini through Google's OpenAI-compatible endpoint, Anthropic's native Messages API, and Ollama through an OpenAI-compatible endpoint. The gateway supports streaming and fallback; runtime provider secrets are stored server-side and encrypted where configured. Exact models are admin/environment-configured and live catalog/health checks are available; no fixed Gemini model/quota guarantee is implemented.

Chat, coding assistance, and agent/build execution are distinct. Chat/coding responses are rendered safely; build intent must go through the build route. Agent build tasks persist execution state/checkpoints in Firestore and project files are revisioned. Static site artifacts can be previewed/published. Generated backend code is not executed in the web process; a resource-limited isolated runner is a prerequisite for that feature.

## Preview and public URL resolution

- In-app preview is an authenticated project route and serves persisted files in a restricted context.
- Published projects use `/s/<slug>` and Firestore-backed published assets.
- `siteOrigin()` uses only validated `NEXT_PUBLIC_APP_URL` configuration, reduces it to a parsed origin, rejects local/private and production-insecure hosts, and falls back to `https://matrix.thamjj13.top`.
- Request Host and forwarded host headers are not used as canonical-origin inputs.
- Production links must be proven against a reachable configured host; setting the origin alone does not prove DNS, hosting or deployment readiness.

## Durable automation

Automation definitions and due timestamps are stored in Firestore. The scheduler worker polls the protected `/api/jobs/automations` endpoint, and execution claims are transactionally leased to avoid duplicate runs. Deploy the worker separately with `AUTOMATION_WORKER_SECRET` and a reachable `MATRIX_WORKER_TARGET_URL`; a Next.js browser tab is not the scheduler. Event triggers beyond the implemented schedule/manual action paths must not be advertised as active without a dispatcher.

## Device/family and native boundaries

MATRIX Connect account devices are not smart-home actuators. Pairing creates short-lived QR challenges and scoped credentials with server-side revocation checks. There is no ESP32 firmware, MQTT TLS broker adapter, actuator command acknowledgement, OTA signing system or physical pairing-button implementation. Likewise, no Tauri native desktop project, Android MediaProjection companion or browser screen-sharing transport is present. These require separate consented native/embedded components and cannot be substituted by decorative web controls.

## Operational requirements

- Keep Firebase Auth/Firestore as canonical systems; preserve existing records.
- Configure production origin, trusted auth domains, server credentials and AI provider keys in deployment secrets.
- Run Firestore rules/index changes only after staging/emulator validation.
- Deploy/monitor scheduler separately; apply timeout, concurrency, retry and least-privilege controls.
- Never execute generated arbitrary source in the application process.
- Require explicit approval for production deployment and verify deployment artifact + public HTTP response before reporting success.

More granular setup is in `DEPLOYMENT_GUIDE.md`; implementation evidence is in `docs/VERIFICATION.md` and test files.
