# MATRIX system audit

Audit date: 2026-11-07. Source baseline: `f65ad2468963d78bbd8d7bd037925431be3dfa60`. Working branch: `arena/f05e0edc-matrix-ai`.

## Scope and evidence

All 427 tracked files were inventoried. Application routes, server modules, authorization rules, provider adapters, deployment manifests, mobile clients and tests were inspected; this is not a claim that every generated/dependency file or every historical prompt was manually reviewed. Historical audit documents are implementation history, not proof of current production behavior.

- `npm ci --no-audit --no-fund`: passed (951 installed packages).
- Baseline `npm test`: **587 tests / 61 files passed**. Many tests use serialized in-memory Firestore/provider doubles; these are unit/contract tests, not production integration evidence.
- Baseline `npm run typecheck`: passed.
- Public production page fetched successfully: MATRIX login, email/Google/Facebook sign-in and the ages 11–17 positioning are visible.
- Production `/api/health` at 2026-11-07T02:09:11Z reported Firebase/Cloudinary reachable, general/coding AI online, OpenRouter coding model `nvidia/nemotron-3-ultra-550b-a55b`, image AI not configured. This endpoint is not an end-to-end account workflow test and its reported model differs from the source's `:free` suffix.
- No production credentials, authenticated production account, deployment identity or hardware are available. Production data was not read or modified. Exact deployed commit and private workflows cannot be established from public pages.

## Existing architecture

Next.js 15 App Router / React 19 / Tailwind 4; Firebase Auth and Firestore; server-only Admin SDK; `/api/rpc` action dispatcher; SSE `/api/ai`; Groq, OpenRouter and configurable OpenAI-compatible transport; Cloudinary uploads; static generated-project preview/publishing; GitHub OAuth and Vercel token integration. Legacy Flutter phone and Wear clients are present. There is no Tauri application, MQTT service, screen-sharing transport or worker deployment in the baseline.

## Confirmed defects and gaps

| Priority | Finding | Evidence / consequence |
|---|---|---|
| P0 | Device unlink is not access revocation | `server/pairing.ts` only sets `revoked_at`; Firebase sessions remain valid. Stored `scopes` are descriptive, not enforced. |
| P0 | Mutation CSRF protection is inconsistent | `/api/rpc` checks Origin; pairing, agent tools, upload signing and other cookie-authenticated mutations do not consistently do so. RPC compares host without scheme and accepts missing Origin. |
| P0 | Provider model verification is incomplete | The invalid Qwen default was previously removed, but Groq chat/fast and OpenRouter coding still have unverified hardcoded defaults. Runtime agent health probe uses the chat model. Saved admin API key is plaintext in Firestore (not browser-exposed). |
| P0 | Schedule controls do not schedule execution | `automations.ts` stores hourly/daily/weekly, but no worker, due-time field or scheduler exists. Registered production tools are predominantly reads. Event trigger has no event dispatcher. |
| P1 | Microphone permission is denied by deployment policy | `next.config.ts` sends `microphone=()` while chat offers speech recognition. Bangla/English TTS exists; wake word and voice-tool execution do not. |
| P1 | Canvas is not the requested visual canvas | `canvas-client.tsx` wraps the project HTML/file editor and explicitly says visual editing is unsupported. |
| P1 | Navigation does not match the product hierarchy | Automations/Devices/Models are dispersed or buried; mobile primary bar contains Canvas/Family instead of the requested Automations/More combination. Workspace appears twice with different destinations. |
| P1 | Session inventory is misleading | Every session mint adds a random `user_sessions` row; rows are not bound to the actual cookie/token. Repeated mints create duplicates. |
| P1 | Agent/builder execution is narrower than advertised | Project generation, checkpoints and static build/deploy modules exist; arbitrary isolated backend/database execution, durable general task queue and production self-healing do not. |
| P1 | Family safety is incomplete | Family and invitation code exists, but linked-device supervision, permitted usage telemetry and explicit screen-sharing sessions are absent. |
| P1 | Notifications are only an in-app list | No Web Push subscription/delivery service, Android push transport or delivery worker. |
| P2 | Deployment manifests drift from runtime configuration | App Hosting/Render omit newer Resend, pairing, vision and other variables; Render pins a questionable model default. Historical SQL seed is not an active Firestore migration. |
| P2 | Native apps lack lifecycle robustness | Flutter device screen can set state after disposal, has no reconnect/focus refresh or visible account identity; no Flutter/Java SDK is available to compile it here. |

## Preservation decisions

Keep Firebase Auth identities and Firestore as the canonical store. Add fields/subcollections to existing collections rather than create a competing backend. Do not run the historical SQL seed against Firestore or production. Do not reassign historical device rows without an explicit ownership migration. Do not deploy this branch automatically.

See `FEATURE_STATUS.md`, `DATABASE_AUDIT.md`, `SECURITY_AUDIT.md` and `IMPLEMENTATION_ROADMAP.md`. Implementation verification is recorded separately in `docs/VERIFICATION.md` as changes land.
