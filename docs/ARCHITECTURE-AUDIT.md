# MATRIX — Architecture Audit & Transformation Plan (Phase 0)

Date: 2026-11-06 · Branch: `arena/fae63b29-matrix-ai` · Baseline commit: `74409d5`

## 1. Baseline verification

- `npx vitest run` → **484/484 tests passed** (46 files) before changes.
- `npx tsc --noEmit` → clean.
- `npm ci` reproduces the lockfile (891 packages).

## 2. Existing architecture (source of truth — preserved)

| Layer | Reality |
|---|---|
| Web | Next.js 15 App Router + React 19 + Tailwind 4, `src/app`, `src/components` |
| Auth | Firebase Auth (email/Google/Facebook/TOTP MFA) → `/api/auth/session` mints httpOnly `__session` cookie (5 d); edge middleware does presence-only checks; all privileged reads verify server-side |
| DB | Firestore only. `firestore.rules`: browser writes denied everywhere; reads owner/admin-scoped |
| Mutations | `/api/rpc` typed action dispatcher (`src/app/api/rpc/route.ts` → `src/lib/server/rpc.ts` + domain modules), zod-validated, RBAC-checked, audit-logged |
| AI | `/api/ai` SSE gateway: rate limit → PII redaction → domain/safety classification → RAG → provider. Admin-configurable OpenAI-compatible endpoint; Groq + OpenRouter (`OPENROUTER_CODING_MODEL`, default `nvidia/nemotron-3-ultra-550b-a55b:free`) env fallbacks. `src/lib/ai/router.ts`, `pipeline.ts`, `agent.ts`, `executor.ts` |
| Agent | Server-side agent with artifacts, sandboxed static preview, build pipeline (`src/lib/server/build.ts`), encrypted GitHub OAuth (AES-256-GCM), review-before-push atomic commits |
| Deploy | `src/lib/server/deploy.ts` — build runs, deployments, published sites (`/s/[slug]`) |
| Images | Cloudinary server-signed uploads; `src/lib/ai/image/*` providers |
| i18n | en + bn dictionaries |
| Admin | RBAC with 5 canonical roles (`src/lib/roles.ts`), audit logs, security events, access grants |

## 3. Feature inventory (existing, working)

Chat (streaming, history, temporary chat, pinned, projects, attachments), AI modes, memory (`user_memories`), scanner, scam library + reports, courses/lessons/quizzes, certificates (+PDF/verify), dashboard, security page, admin suite (users/roles, AI config, content, reports, consents, verification, audit, sites, security), notifications, onboarding with guardian consent + age verification (11–17), account export/delete, GitHub connect/push, project workspace with file editor + preview + zip, build/deploy pipeline, theme gallery (6 fixed templates), voice speech controls.

## 4. Gaps identified vs. the transformation brief

| Brief item | Status before this session | Action taken now |
|---|---|---|
| Unified server-side tool registry (§11) | Did not exist | **Implemented** `src/lib/ai/tools/registry.ts` + registered real tools (`index.ts`) |
| Dynamic Design Engine (§4) | Fixed 6-template gallery only | **Implemented** validated token engine + Firestore persistence + version history |
| Family / parent-child / org roles (§8) | Guardian consent only (per-user, not relationships) | **Implemented** family domain + server enforcement + rules |
| QR device pairing (§9) | Did not exist (`user_sessions` rows only) | **Implemented** signed one-time QR challenges + device registry + routes |
| Vercel deployment engine (§7) | Firebase/Render publishing exists; no Vercel API integration | Blocked: no `VERCEL_TOKEN` in env; documented, not fabricated |
| GLM-5.3-Flash free agent model (§6) | OpenRouter coding model configurable via `OPENROUTER_CODING_MODEL` | Partially: router supports it via env; default remains Nemotron free; rate-limit honesty handled by `provider-error.ts` |
| Android / Windows / Wear OS apps (§5) | Not in this repo (ARMx has Flutter/Kotlin refs) | Out of scope for web repo this session; pairing backend ready for them |
| Home Assistant / MQTT (§12) | Not present | ARMx patterns identified; needs credentials — blocked, documented |

## 5. New modules added this session

- `src/lib/ai/tools/registry.ts` — ToolSpec (id, description, zod input schema, permissions, risk tier, environment, timeout, approval, audit), independent `authorize()` gate, guarded `call()` (authorize → validate → timeout-wrapped execute), model-facing JSON schemas. A model request never executes a tool.
- `src/lib/ai/tools/index.ts` — registered tools wired to REAL server modules: `projects.list`, `projects.get`, `github.connection_status`, `github.list_repos`, `deployments.latest_for_project`, `devices.list`, `family.list`. Unconfigured integrations return honest errors.
- `src/lib/design/tokens.ts` + `src/lib/design/engine.ts` — Dynamic Design Engine: deterministic NL → validated tokens (allowlisted fonts/densities/sidebar/radius, hex-only colors, WCAG AA contrast gate), preview/edit/build pipeline. No arbitrary CSS/JS possible.
- `src/lib/server/design.ts` — persistence: `design_configs/{uid}` + `versions` subcollection; preview never writes; save/apply/reset audited.
- `src/lib/family.ts` + `src/lib/server/family.ts` — account roles (individual/org_admin/support_operator) strictly separated from family roles (parent/child); child can never be org admin; create/invite (hashed one-time tokens, 7-day TTL)/accept/role-change/revoke/list; all server-enforced + audited.
- `src/lib/server/pairing.ts` + `/api/devices/pairing/create|complete`, `/api/devices` — MATRIX Connect QR pairing: HMAC-SHA256-signed, 5-minute, single-use challenges (replay-protected via transaction), scoped device registration, revocation, audit + security events. QR contains no credentials.
- `firestore.rules` / `firestore.indexes.json` — new collections locked down (server-write-only; owner reads).
- RPC actions: `design_*`, `family_*` in `/api/rpc`.
- Tests: `tests/tool-registry.test.ts`, `tests/design-engine.test.ts`, `tests/family.test.ts`, `tests/device-pairing.test.ts` (32 new tests → **516 total passing**).

## 6. Security considerations applied

- All new mutations server-side only; Firestore rules deny browser writes (default-deny retained).
- Pairing tokens: HMAC-signed, short TTL, one-time, timing-safe compare; raw invitation tokens stored hashed only.
- Design engine: allowlist-based tokens; contrast enforced; no user CSS/JS execution.
- Tool registry: backend re-authorizes independently of model claims; MEDIUM+ requires approval; failures are honest.
- Secrets stay server-side; `PAIRING_HMAC_SECRET` optional (derived from Firebase server creds otherwise).

## 7. Remaining blockers (honest)

1. **Vercel integration** — needs `VERCEL_TOKEN` + team config; workflow designed (list projects → create deployment → monitor → alias `*.apps.thamjj13.top` after domain verification), not implemented without credentials.
2. **GitHub App vs OAuth** — existing OAuth flow works; Agent PR workflow can build on `github.push` after review; no new tokens exposed to clients.
3. **Native apps (Android/Windows/Wear OS)** — live in separate repos; this session delivered the shared backend (pairing, devices, family) they consume.
4. **Home Assistant/MQTT** — needs broker credentials; architecture slot reserved in tool registry categories.
5. **GLM-5.3-Flash:free** — set `OPENROUTER_CODING_MODEL=z-ai/glm-5.3-flash:free`; rate limits surface as honest provider errors with fallback support already in `provider-error.ts`.

## 8. Tranche 2 (implemented after the audit)

- **Multi-model comparison** (§5): `POST /api/ai/compare` runs the same PII-redacted prompt across up to 3 routing lanes in parallel using the real provider routing (`createAIRoutesFromDb`), returning per-lane `{ provider, model, content | error }` with usage logging and a per-user rate limit. UI: `/compare` (`src/components/compare-client.tsx`) with lane picker, side-by-side markdown, per-lane regenerate and copy. Comparisons are ephemeral and attributed — never saved silently.
- **Family UI** (§8): `/family` (`src/components/family/family-client.tsx`) — create family, invite by email (one-time code shown once), accept via code, member list, promote/revoke (parent-only, server-enforced).
- **MATRIX Connect UI** (§9): `/devices` (`src/components/devices/devices-client.tsx`) — generate signed QR (5-min, single-use), pair-this-device by pasting the payload, device list with scopes, unlink.
- **Design Studio UI** (§4): `/design` (`src/components/design/design-studio-client.tsx`) — NL instruction → validated preview (contrast-gated) → approve & save → version history with apply/reset.
- Nav: Family, Devices, Design studio, Compare models added to desktop sidebar "More tools" and the mobile More sheet.
- Tests: `tests/ai-compare.test.ts` (4 tests) → **520 total passing**, `tsc` clean, `next build` succeeds with all new routes.

## 9. Tranche 3 — Agent Studio on the unified tool registry (Phase 3, partial)

- `src/lib/server/tool-gateway.ts` — the ONLY execution path for registered tools: per-call RBAC authorization (`hasPermission`), risk/approval enforcement, per-user rate limit (20/min), timeout-wrapped execution, `audit_logs` on every audited/failed call, `security_events` when approval is required. `recordAgentToolSelection()` audits every Agent-mode tool selection from the AI gateway.
- `POST/GET /api/agent/tools` (`src/app/api/agent/tools/route.ts`) — list tool descriptors (no handlers exposed) / execute one tool through the gateway; same-origin + session enforced.
- `/api/ai` agent branch now audit-logs the selected tool via the gateway.
- UI: Agent tools panel on `/workspace` (`src/components/agent-tools-panel.tsx`) — LOW-risk tools runnable, MEDIUM+ shown as approval-gated (never fake-executed).
- Tests: `tests/tool-gateway.test.ts` (6 tests: execution+audit, approval gate, security event, unknown tool, rate limit, safe descriptors) → **526 total passing**, `tsc` clean, `next build` OK (`/api/agent/tools` route present).

## 10. Tranche 4 — persistent Agent task checkpoints (Phase 3, continued)

- `src/lib/server/agent-tasks.ts`: `agent_tasks/{id}` (owner-scoped header: title, goal, model, status) + append-only `agent_tasks/{id}/checkpoints/{n}` trail with validated steps (`inspect → plan → permission_check → edit → build → test → diagnose → repair → deploy_approval → deploy → verify → report`) and honest states (`started/ok/failed/skipped/needs_approval`). Closed tasks reject new checkpoints; every transition is audit-logged. Ownership enforced server-side.
- RPC actions: `agent_task_create/list/get/checkpoint/status`. Firestore rules + index added (server-write-only, owner-read).
- Tests: `tests/agent-tasks.test.ts` (ordered trail, invalid step/state rejection, closed-task rejection, ownership isolation) → **529 total passing**, `tsc` clean, `next build` OK.

## 11. Tranche 5 — Vercel deployment engine (safe architecture; live calls blocked on credentials)

- `src/lib/server/vercel.ts`: real Vercel REST client (bearer token server-side only, `VERCEL_TEAM_ID` support): `listVercelProjects`, `getVercelProject`, `createVercelDeployment`, `getVercelDeployment`, `waitForDeployment` (bounded poll, READY/ERROR/CANCELED), `listVercelDomains`, `addProjectDomain` (enforces the approved parent `VERCEL_APPS_DOMAIN`, default `apps.thamjj13.top` — wildcard DNS alone is NOT sufficient, so the domain must be attached per project), `assignDeploymentAlias`. Rate limits surface as `VERCEL_RATE_LIMITED`; unconfigured token → `VERCEL_NOT_CONFIGURED` (503). **No mock success anywhere.**
- `src/lib/env.ts`: live-read `vercelConfig()` / `isVercelConfigured()`.
- Routes: `GET /api/vercel/status` (honest configured flag), `GET /api/vercel/projects`, `POST /api/vercel/deploy` (requires explicit `approve: true` checkpoint + per-user rate limit; creates deployment, waits bounded, returns verified URL + approver).
- Tests: `tests/vercel-engine.test.ts` against a stub `fetch` (auth header, teamId, deploy→READY polling, 429 handling, domain parent enforcement) → **534 total passing**, `tsc` clean, `next build` OK with all `/api/vercel/*` routes.
- **Blocker**: live verification needs `VERCEL_TOKEN` (+ team) and the `apps.thamjj13.top` domain added/verified on the Vercel team — documented in `.env.example`.

## 12. Tranche 6 — Agent task ↔ Vercel deploy integration (Phase 3 complete)

- `src/lib/server/agent-deploy.ts` — `deployAgentTask()`: requires explicit `approve: true`, then records real checkpoints on the agent task while performing the deployment: `deploy_approval → deploy (started/ok|failed) → verify (domain + live URL) → report`, sets task status running→completed/failed, writes an audit log. Deployment ERROR marks the checkpoint and task `failed` — never fabricated success. Optional `subdomain` attaches `sub.apps.thamjj13.top` through the approved-parent-enforced domain path.
- RPC action `agent_task_deploy` wired into `/api/rpc`.
- Tests: `tests/agent-deploy.test.ts` (approval gate, full success trail, failure trail) → **537 total passing**, `tsc` clean, `next build` OK.

## 13. Tranche 7 — Workflow automations (Phase 7, core)

- `src/lib/automations.ts` (shared) + `src/lib/server/automations.ts` (server): automations = trigger (manual/schedule/event) + ordered actions that reference **registered tool ids only**. Creation rejects unknown tools, invalid args, and any non-LOW-risk tool (`TOOL_RISK_TOO_HIGH_FOR_AUTOMATION`); schedule triggers require a preset. Execution (`runAutomation`) runs each action through the registry's guarded `call()` (authorize → validate → timeout), records an `automation_runs` row with real per-action outcomes, updates run counters, and audits. Ownership enforced; pause/disable/delete server-side.
- RPC actions: `automation_create/list/status/delete/run`. Rules + indexes added (owner-read, server-write-only).
- UI: `/automations` page (`automations-client.tsx`) — create from low-risk tools, run now, pause/activate, delete; nav entries in desktop sidebar + mobile More.
- Tests: `tests/automations.test.ts` → **541 total passing**, `tsc` clean, `next build` OK (`/automations` route present).

## 14. Tranche 8 — Android companion app (Phase 5, mobile client)

- **Backend support for native clients**: `src/lib/firebase/session.ts` now accepts a Firebase ID token via `Authorization: Bearer` (verified server-side with the Admin SDK, `checkRevoked=true`) in addition to the httpOnly cookie — one identity system for web + mobile. Test: `tests/session-bearer.test.ts`.
- **`mobile/matrix_app/`** — Flutter Android app (real code, single codebase reusable for Wear OS later): Firebase email auth, chat via `/api/ai/compare`, **QR pairing** with `mobile_scanner` → `/api/devices/pairing/complete`, device center (`/api/devices` list/unlink). Manifest requests only INTERNET + CAMERA (camera used only on the pairing screen). Full Android Gradle scaffolding + `mobile/README.md` build instructions (`flutterfire configure`, `google-services.json`, `flutter build apk --release`).
- Web verification after the session change: **543/543 tests**, `tsc` clean, `next build` OK.
- Not verified here: the Flutter app was authored but not compiled (no Flutter SDK in this sandbox) — build steps documented in `mobile/README.md`; run `flutter test` + `flutter build apk` on a machine with the SDK.

## 15. Tranche 9 — Wear OS companion (Phase 5, wear client)

- `mobile/matrix_wear/` — Flutter Wear OS app sharing the phone app's code (`path: ../matrix_app`): watch sign-in, **quick chat** (fast lane, short truncated answers), read-only **device status**. Manifest: `type.watch`, `standalone=false`, INTERNET only — no forced phone capabilities. Full Gradle scaffolding (minSdk 30 / Wear OS 3+). Build steps appended to `mobile/README.md`.
- Web repo unchanged and still green: **543/543 tests**, `tsc` clean. App code authored, not compiled here (no Flutter SDK in sandbox) — same honest caveat as the phone app.

## 16. Remaining phases

Windows desktop companion, Phase 6 voice polish, Phase 8 release checklist. Live external verification still gated on credentials: `VERCEL_TOKEN`, OpenRouter key for GLM-5.3-Flash:free, GitHub OAuth app, MQTT broker.
