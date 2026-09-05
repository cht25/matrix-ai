# MATRIX AI — All-in-one AI Assistant & Coding Agent

**Chat · create · learn · build · preview · push with approval**

MATRIX AI is a production-ready, multilingual workspace that combines a broadly useful assistant with
cyber-safety tools, learning, and a dedicated software Agent. General Chat helps with writing, study,
planning, research, technology and safe digital life. Obvious coding requests are routed to the
**server-configured AI provider and model**. Explicit Agent mode adds text/code attachments,
reviewable file artifacts, a sandboxed static live preview, and encrypted GitHub OAuth with
review-before-push atomic commits. Existing screenshot scanning, scam reporting, courses, certificates,
security dashboard and RBAC administration remain available.

The platform uses **Firebase (Auth + Firestore)**, **Cloudinary** for private images, and an
**admin-configurable OpenAI-compatible provider** (endpoint, model and API key) for all AI work, with
**Groq / OpenRouter environment fallbacks**. Provider keys and GitHub OAuth tokens never reach
the browser or an AI prompt.

> Previously branded "THAMJJ13.TOP Cyber Safety AI" — rebranded to **MATRIX AI** (developer: THAMJJ13.TOP).
>
> **v2 (this branch): the backend migrated from Supabase to Firebase.** See
> [Migration notes](#migration-notes-supabase--firebase) for the full mapping.

---

## Table of contents

1. [Stack](#stack)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Firebase setup (new project → prod)](#firebase-setup-new-project--prod)
5. [Quick start (local)](#quick-start-local)
6. [Deploy to production](#deploy-to-production)
7. [Environment variables](#environment-variables)
8. [Firestore data model](#firestore-data-model)
9. [AI pipeline](#ai-pipeline)
10. [Context-aware UI & intent-driven responses](#context-aware-ui--intent-driven-responses)
11. [Security model](#security-model)
12. [Admin roles & permissions](#admin-roles--permissions)
13. [Testing](#testing)
14. [Production security checklist](#production-security-checklist)
15. [Fakes-free behavior & health](#fakes-free-behavior--health)
16. [Troubleshooting deployments](#troubleshooting-deployments)
17. [Internationalization](#internationalization)
18. [Migration notes (Supabase → Firebase)](#migration-notes-supabase--firebase)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Design | **MATRIX visual identity**: monochromatic (deep black · charcoal · off-white) with restrained steel-blue accent; editorial Inter + Manrope typography; custom calligraphic vector wordmark; monochrome lucide iconography; animated cinematic background (fine grids, sparse network topology, reduced-motion aware) |
| Database | **Cloud Firestore** (single source of truth — no other database) |
| Auth | **Firebase Auth** (email/password, Google, Facebook, TOTP MFA) with server-verified **session cookies** for SSR |
| Storage | **Cloudinary** (free tier) — server-signed uploads, private (authenticated) assets only |
| Authorization | Firestore **security rules** + a server-side RPC layer (`src/lib/server/rpc.ts`) that ports every Postgres `SECURITY DEFINER` function |
| Backend/API | Next.js route handlers (Node runtime, Admin SDK) |
| AI | **Admin-configurable OpenAI-compatible endpoint/model/API key** (Admin → AI usage) for chat, Agent/coding and screenshot analysis — with a separate **Chat model** and **Agent/coding model** field (each independently testable). Groq (general/vision) and OpenRouter Nemotron (`nvidia/nemotron-3-ultra-550b-a55b:free`; override with `OPENROUTER_CODING_MODEL`) remain as environment fallbacks. All traffic is behind `/api/ai` |
| i18n | English + Bangla dictionaries (architecture ready for more) |
| Tests | Vitest (AI pipeline, PII, classification, file validation, age rules, env config) |

The Firebase service account, AI provider keys, GitHub OAuth secret and encrypted GitHub access tokens exist **only server-side** and are never exposed to the browser.

---

## Architecture

```
Browser
  ├─ Firebase JS SDK ── sign-in (password / Google / Facebook / TOTP MFA)
  │      └─ idToken → POST /api/auth/session → httpOnly `__session` cookie (5 d)
  ├─ /api/upload-signature → signed Cloudinary grant → direct upload
  │      (private screenshots & ID docs — owner-folder-bound, image-only, ≤8 MB)
  └─ fetch /api/ai (chat + scan, SSE streaming)   ← session-cookie authenticated
                     │
Next.js server (any Node host / Firebase App Hosting)
  ├─ middleware.ts      edge routing only (unverified cookie presence check)
  ├─ Server components  Admin SDK + `src/lib/server/queries.ts` (scoped by verified uid)
  ├─ /api/rpc           ALL mutations — ports of the Postgres RPC layer
  │                      (ownership checks, validation, RBAC, audit, security events)
  ├─ /api/ai            AI gateway: rate limit → PII redaction → domain/safety
  │                      classification → RAG → Groq or OpenRouter → validation
  ├─ /api/upload-signature  one-shot signed Cloudinary upload grants
  ├─ /api/account/*     data export (GDPR-style) + self-service deletion w/ re-auth
  └─ /api/auth/session  session-cookie minting + user provisioning
                     │
Firebase (Admin SDK bypasses rules ONLY server-side)
  ├─ Auth               users, MFA factors, custom claims (admin)
  └─ Firestore          30+ collections (see data model)

Cloudinary (free tier)
  └─ Private images     security-screenshots/{uid}/…, identity-documents/{uid}/…
                        (authenticated assets — bytes only via server-signed URLs)
```

Key invariants (unchanged from the Supabase edition):

- **Every write goes through the server.** Browser Firestore rules deny all writes; `quiz_answers`,
  `audit_logs`, `ai_*` collections are not even client-readable. Clients can never fake a quiz score,
  an assistant message, or an audit entry.
- **The AI gateway is the only path to an AI provider.** PII is redacted before anything leaves the server.
  The endpoint/model/key can be changed by an admin at runtime (Admin → AI usage) or by environment fallback
  variables; failures return honest error codes — never a fabricated reply.
- **GitHub never auto-pushes.** Agent output becomes a reviewable file set; the user chooses a repository,
  branch and commit message, confirms review, and then one atomic commit is created. OAuth tokens are
  AES-256-GCM encrypted at rest and never sent to an AI provider.
- **No demo mode.** Missing configuration renders honest error screens, never fake data.

---

## Repository layout

```
src/
  app/                     Next.js App Router (pages + API routes)
    api/ai/                AI gateway (chat, scan, health) — SSE streaming
    api/rpc/               typed server mutations (the RPC layer port)
    api/auth/session/      session cookie mint/refresh/clear
    api/upload-signature/  one-shot signed Cloudinary upload grants
    api/account/           export + delete (with password re-auth)
    api/health/            honest service health for uptime checks
  components/              app shell, chat, scanner, courses, admin panel, settings…
  lib/
    firebase/              client SDK (Auth/Firestore), Admin SDK, session cookies
    server/                rpc.ts (Postgres function ports) + queries.ts (page reads)
    ai/                    Admin OpenAI-compatible provider, Groq + OpenRouter
                           fallbacks, coding detection, Agent artifact parser,
                           PII redaction, safety prompts, uploads
    server/github.ts       encrypted OAuth token store + atomic Git push
    server/cloudinary.ts   signed upload grants, private downloads, user asset wipe
    client/api.ts          browser helper: rpc(), mintSessionCookie(), uploads
    data.ts, env.ts        server data core + centralised env
  middleware.ts            edge routing guard
firestore.rules            security rules (RLS port)
firestore.indexes.json     composite indexes
scripts/seed.mjs           seeds Firestore from seed/0007_seed.sql
scripts/set-admin.mjs      promote a user to an admin role (+ custom claim)
seed/0007_seed.sql         seed source of truth (original SQL seed)
apphosting.yaml            Firebase App Hosting backend config
firebase.json              deploy config (rules, indexes, hosting, emulators)
```

---

## Firebase setup (new project → prod)

1. **Create the project** at [console.firebase.google.com](https://console.firebase.google.com)
   (Analytics optional). Note the **project id**.
2. **Register a Web app** (Project settings → Your apps → `</>`) and copy the config values —
   they become the `NEXT_PUBLIC_FIREBASE_*` env vars.
3. **Authentication** → Get started → enable:
   - **Email/Password** (leave "Email link" off),
   - **Google** and/or **Facebook** (for the OAuth buttons),
   - **Multi-factor authentication → TOTP** (for 2FA), and add your domain under
     **Authorized domains** (localhost is already there; add your deploy domain later).
   - Templates → customize the verification/reset emails if you like (they carry the
     `/verify` and `/reset-password` handlers automatically).
4. **Firestore Database** → Create database → **Production mode** → pick a region.
5. **Cloudinary** (free account — replaces Firebase Storage, which now requires
   the paid plan): create an account at [cloudinary.com](https://cloudinary.com),
   copy the **Cloud name**, **API key** and **API secret** from
   Dashboard → Settings → API keys. Nothing else to enable — uploads are signed
   by this app and stored as private assets.
6. **Service account** (Project settings → Service accounts → *Generate new private key*):
   take `client_email` and `private_key` from the JSON → `FIREBASE_CLIENT_EMAIL` /
   `FIREBASE_PRIVATE_KEY` env vars (keep the `\n` escapes on hosts like Render/Vercel).
   On Firebase App Hosting / Cloud Run / GCE you can skip this — Application Default
   Credentials are used automatically.
7. **Deploy rules (+ optional indexes):**
   ```bash
   npm run deploy          # firestore rules (+ the performance indexes)
   ```
   The app itself never requires composite indexes (all reads use
   equality-only filters with in-memory ordering), so this step only deploys
   the **security rules** — the indexes in `firestore.indexes.json` are an
   optional performance extra for large datasets.
8. **Seed the content** (countries, scam library, 7 courses, admin RBAC):
   ```bash
   npm run seed
   ```
9. **Make yourself an admin** (after signing up once in the app):
   ```bash
   npm run set-admin you@example.com super_admin
   ```

## Quick start (local)

```bash
npm install
cp .env.example .env.local   # fill in the Firebase values from the setup above
npm run seed                 # seed Firestore
npm run dev                  # http://localhost:3000
```

Optional — run Firebase against local emulators (no cloud project needed;
Cloudinary still needs real credentials for uploads):
```bash
npm run emulators            # auth :9099, firestore :8080, UI :4000
# in another shell, with the emulator env set:
FIRESTORE_EMULATOR_HOST=localhost:8080 FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
NEXT_PUBLIC_FIREBASE_API_KEY=demo NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-matrix-ai \
npm run seed && npm run dev
```

## Deploy to production

**Option A — Firebase App Hosting (recommended, fully on Firebase):**
requires the Blaze plan (a card on file; the free tier still covers this app comfortably).
```bash
npm i -g firebase-tools
firebase login
firebase experiments:enable webframeworks   # for `hosting.source` in firebase.json
firebase use --add                           # pick your project
firebase deploy                              # app + rules + indexes in one shot
```
(Or create a backend in the console with **App Hosting** and connect the repo —
`apphosting.yaml` configures runtime + env/secrets.)

**Option B — any Node host (Render, Railway, Fly, Docker…):**
`npm ci && npm run build && npm start` with the env vars from `.env.example`
(`render.yaml` is provided for Render). Health check: `GET /api/health`.

**Option C — Vercel:** import the repo, set the same env vars, deploy.

Whichever you choose, remember to:
- add your domain to Firebase Auth → Settings → Authorized domains,
- run `npm run deploy` once so the Firestore security rules exist in the
  Firebase project (composite indexes are optional — see
  [Troubleshooting deployments](#troubleshooting-deployments)).

---

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | client + server | Firebase web config (public by design) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | client | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | client + server | Firebase project id |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` / `..._APP_ID` | client | Firebase web config |
| `NEXT_PUBLIC_APP_URL` | client + server | canonical URL for links/emails (not used as a redirect target). Must be a host that is actually attached to the Render service |
| `FIREBASE_CLIENT_EMAIL` | server only | Admin SDK service account |
| `FIREBASE_PRIVATE_KEY` | server only | Admin SDK private key |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | server only | Private image storage (screenshots, ID docs) |
| `GROQ_API_KEY` | server only | General chat + vision environment fallback → Groq |
| `OPENROUTER_API_KEY` | server only | Coding auto-routing + Agent environment fallback → OpenRouter |
| `OPENROUTER_CODING_MODEL` | server only | Optional coding-model override; defaults to `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | server only | GitHub OAuth App for Agent-mode repository access |
| `GITHUB_TOKEN_ENCRYPTION_KEY` | server only | Encrypts GitHub tokens at rest (32+ random characters) |
| `GITHUB_OAUTH_CALLBACK_URL` | server only | Exact OAuth callback (`https://host/api/github/callback`) |
| `IDENTITY_PEPPER` | server only | HMAC pepper for birth-certificate numbers (32+ chars). Missing → identity submit fails honestly |
| `ADMIN_BOOTSTRAP_KEY` | server only | One-time key for `/admin/setup` to create the first super_admin |

## Firestore data model

Snake_case collections mirror the original tables. Timestamps are Firestore
`Timestamp`s; date-of-birth is an ISO `YYYY-MM-DD` string.

| Area | Collections |
|---|---|
| Identity | `profiles/{uid}`, `user_security_settings/{uid}`, `guardian_consents/{uid}`, `identity_verifications`, `countries/{ISO-2}` |
| Chat | `conversations` + `conversations/{id}/messages`, `conversation_summaries/{conversationId}`, `user_memories`, `attachments`, `security_analyses` |
| Learning | `courses`, `course_modules`, `lessons`, `quizzes`, `quiz_questions` (options embedded **without** the correct flag), `quiz_answers` (server-only correct answers), `quiz_attempts`, `course_progress/{uid}_{lessonId}`, `certificates/{uid}_{courseId}`, `certificate_verification` |
| Scam library | `scam_categories`, `scam_articles`, `scam_reports`, `reporting_resources`, `document_chunks` (RAG knowledge) |
| Security & integrations | `notifications`, `security_events`, `user_sessions`, server-only `github_connections` (encrypted token) |
| Admin | `admin_roles`, `admin_permissions`, `admin_role_permissions/{role}__{perm}`, `admin_role_assignments/{uid}`, `admin_access_grants`, `audit_logs` |
| AI ops | `ai_usage_logs` (rate limits + usage), `ai_safety_events` |

Quiz options deliberately ship without `is_correct` (the port of the old
`quiz_options_public` view); grading happens server-side in `/api/rpc` using
`quiz_answers` — scores can never be faked client-side.

## AI pipeline

`/api/ai` (port of the `ai-gateway` edge function, spec §24):

```
Auth → Rate limit (ai_usage_logs: 20/min · 300/day chat; 5/min · 50/day scan)
     → PII detection/redaction (never sent to an AI provider)
     → Broad task/coding detection + cyber-safety classification
     → Prompt construction (system + rolling summary + last 8 messages + safe memories)
     → RAG retrieval (document_chunks + scam articles + lessons + reporting resources)
     → Admin-configured OpenAI-compatible provider, else Groq (general/vision)
       or OpenRouter Nemotron (coding/Agent)
     → streaming or structured Agent artifacts + output validation + PII-leak filter
     → Store allowed response → usage/safety logs
```

`POST { action: "health", mode?: "agent" }` is unauthenticated and performs a real reachability check for the selected provider. `/api/health` reports general and coding AI separately.

## Context-aware UI & intent-driven responses

The chat surface is **minimal by default, intelligent when needed, powerful on
demand**. Capabilities exist in the system, but the interface only reveals the
ones the user's message actually asked for:

```
USER INTENT → CAPABILITY SELECTION → EXECUTION → CONTEXTUAL UI
```

| Layer | Module | Responsibility |
| --- | --- | --- |
| Intent detection | `src/lib/ai/intent.ts` | `detectIntent()` classifies one message into `CHAT · EXPORT · IMAGE_GENERATION · AGENT_TASK · CODE · RESEARCH · STUDY · HEALTH · FORMAT_CLARIFY`, plus the requested artifact (`NONE · PDF · DOCX · CSV · XLSX · JSON · TXT · MARKDOWN · CODE · IMAGE · …`). `analyzeContent()` reads the reply (code fence, table, JSON, sources, flashcards) and `planResponseActions()` decides which actions are valid for it. |
| Capability selection | `selectCapability()` / `effectiveMode()` | Chooses the gateway action (`chat · image · agent · orchestrate`) and the mode sent for that one message — an explicit image or agent request in General mode upgrades only that request, never the whole UI. |
| Artifact lifecycle | `src/lib/ai/artifacts.ts` | `Not Requested → Requested → Generating → Ready → Available`. The transition helpers refuse to skip a step, so an artifact can never be shown as available before it was asked for. Also holds the execution state and the **whitelisted** activity lines (no chain-of-thought is ever rendered). |
| File building | `src/lib/export/response-export.ts` + `src/lib/export/zip.ts` | Real PDF pages (paginated, correct xref), zipped OOXML `.docx` and `.xlsx`, CSV from detected tabular data, JSON extraction, Markdown/TXT. A format that the content cannot honestly produce returns `null` instead of an empty file. |
| Rendering | `src/components/assistant-message.tsx`, `chat-client.tsx` | Every panel is mounted conditionally from that state — nothing is painted and then hidden with CSS. |

What the user sees:

- **Normal chat** — the message, the reply, and `Copy · Regenerate · More ▾`. No
  export bar, no sandbox, no analytics, no reasoning panel.
- **`More ▾`** — only actions valid for that reply (Listen, Export, Report, …).
  `Export` opens an inline *Export as* row listing formats that fit the content:
  CSV appears only for tabular data, JSON only for structured data.
- **Explicit export** ("turn this into a PDF") — `PDF requested → Generating PDF…
  → ✓ PDF ready [Open] [Save]`. `pickArtifactContent()` resolves what "this"
  refers to (the previous answer for an acknowledgement, the reply's own table
  for a CSV request).
- **Ambiguous request** ("make a report") — a normal answer plus a minimal
  `What format would you like? [PDF] [DOCX] [Markdown]`. Never four files at once.
- **`don't export`** — export is removed from the actions and the More menu.
- **Image request** — `Preparing image… → Together AI → ✓ Image ready` with
  `Save · Regenerate · Edit prompt`. Ordinary messages never trigger generation.
- **Agent task** — the stage list while it runs, then one collapsed line
  (`Agent task completed [View]`). Performance numbers live behind
  `Activity ▾ → Performance ▾`, and plain chat records no execution trace at all.
- **Code answer** — `Copy code · Run · Explain` (Run only when a workspace or
  project really exists); the full workspace opens only for real project files.
- **Top bar** — `[Mode ▾] [Model ▾] … ● Ready [Settings ▾]`; strategy, auto-read,
  demo mode and routing detail are inside Settings.
- **Mobile** — one visible action plus `More ▾`, collapsed agent/activity panels.

Review it without credentials at `/dev-preview/chat` (dev builds only, mocked
gateway, same components and same intent logic; 404 in production).

## Security model

- **Session cookies**: the browser signs in with the Firebase client SDK, then the
  ID token is exchanged for a signed httpOnly `__session` cookie (5 days) —
  server components and every API route verify it with the Admin SDK.
- **Server-side authorization**: `src/lib/server/rpc.ts` re-checks ownership,
  RBAC permissions, audit logging and security events on every mutation —
  the direct port of the old `SECURITY DEFINER` functions.
- **Rules as the outer wall**: browsers can read only their own documents and
  public content; every client write is denied; `quiz_answers`, `audit_logs`,
  `admin_access_grants`, `ai_safety_events`, `certificate_verification` are
  server-only.
- **Private image storage (Cloudinary)**: uploads require a server-signed
  grant that pins the exact folder (`…/{uid}/`) and public_id; assets are
  stored as *authenticated* (not public) and their bytes are only reachable
  through server-signed URLs; the scan endpoint re-validates magic bytes,
  type and dimensions; account deletion wipes the user's folders.
- **Sensitive profile columns** (`date_of_birth`, `age_verified*`) change only via
  `complete_profile` / `review_identity_verification` — never direct writes.
- **Privileged admin access** to user conversations requires a reason, a
  time-limited grant (1–168 h) and an audit entry (`request_admin_access`).
- **Account deletion** requires password re-authentication, then removes storage,
  Firestore data, an audit row, and the Auth user.

## Admin roles & permissions

Seeded by `npm run seed` (see `seed/0007_seed.sql`):

| Role | Highlights |
|---|---|
| `super_admin` | everything |
| `security_admin` | verification/consent review, security events, reports, AI logs, privacy access |
| `content_admin` | scam library, courses, resources |
| `support_admin` | user lookups, report triage, consent review |
| `auditor` | read-only audit + AI-safety access |

Promote/demote with `npm run set-admin <email> [role|none]`. The Firestore
assignment applies immediately; the `admin` custom claim (used by rules +
middleware) activates on the user's next sign-in/token refresh.

### AI provider configuration

`super_admin` accounts can configure the AI provider from **Admin → AI provider
& usage**. The endpoint (OpenAI-compatible base URL or a full
`.../chat/completions` URL), model ID and API key are saved server-side in
Firestore `system_settings/ai_provider` and take effect on the next request —
no code deploy or restart. Only a masked key status (last four characters) is
returned to the browser. If nothing is saved, or the provider is disabled, the
existing `GROQ_API_KEY` / `OPENROUTER_API_KEY` environment fallbacks are used.

## Testing

```bash
npm test         # vitest: AI pipeline, PII redaction, domain/safety classification,
                 #        file validation, age rules, API failure taxonomy, env config
npm run typecheck
```

The context-aware UI is covered by four suites:

- `tests/intent.test.ts` — the spec's intent examples (`hi` → `CHAT/NONE`, "turn
  this into a PDF" → `EXPORT/PDF`, "generate an image…" → `IMAGE_GENERATION`,
  multi-step requests → `AGENT_TASK`, ambiguous "make a report" → format choice)
  plus content analysis and action planning.
- `tests/artifacts.test.ts` — the artifact lifecycle refuses to skip a step,
  activity lines never leak un-whitelisted text, and `pickArtifactContent()`
  resolves what an export request refers to.
- `tests/response-export.test.ts` — the built files are real: PDF pagination and
  xref offsets, zipped DOCX/XLSX packages readable entry by entry, CSV quoting,
  and "no spreadsheet out of prose".
- `tests/chat-render.test.ts` / `tests/contextual-ui.test.ts` — render the real
  component tree and assert what a user sees for each spec test case, and that
  the panels stay unmounted (not CSS-hidden) by default.

## Production security checklist

- [ ] Firestore + Storage deployed from this repo (`npm run deploy`)
- [ ] Auth providers enabled; unnecessary ones disabled; MFA (TOTP) on
- [ ] Deploy domain added to Auth → Authorized domains
- [ ] Service account key set **only** as server env (never `NEXT_PUBLIC_*`)
- [ ] `npm run seed` + `npm run set-admin` run exactly once
- [ ] `GET /api/health` wired to an uptime monitor
- [ ] Backup policy enabled (Firestore → scheduled exports; Cloudinary → account backups)

## Fakes-free behavior & health

If Firebase env vars are missing/invalid, the app renders honest
"Server problem — service not configured" screens and `/api/health` returns
`503 {"ok":false,"firebase":"not-configured",...}`. With credentials present it
performs live checks (Firestore, Cloudinary, configured AI provider and environment fallback
reachability) — never a cached lie.

**Health checks verify the real thing.** An AI provider is reported
`online` only after a request that proves it:

- admin-configured OpenAI-compatible endpoint → a **real 1-token
  `/chat/completions` call against the configured model** (results cached 60 s
  for successes / 5 s for failures so the UI poller cannot hammer quotas).
  A `GET /models` check is NOT used: OpenRouter and most proxies answer it
  `200` **without any valid key**, which once let the UI show "AI Online" while
  every chat request failed with 401.
- OpenRouter → `GET /auth/key` with the API key (validates the key + quota
  without burning the per-model free-tier budget).
- Groq → `GET /models` with the API key (Groq's `/models` requires a valid
  key, so it is an honest signal).

### Structured error logging & end-to-end probe

Every AI-gateway failure is logged server-side as structured JSON with no
secrets and no message contents: `event` (`ai_provider_failure` /
`ai_gateway_failure`), `timestamp`, `route`, `provider`, `model`, `httpStatus`,
`errorType`, `requestId` (echoed to the browser as the `X-MATRIX-Request-ID`
header and shown in the UI failure detail as a short reference), and a
sanitized `detail`. Grep your host logs by `event` or `requestId`.

To verify a deployment end-to-end (real sign-up, session mint, Chat request,
streaming request and Agent request — the exact browser flow):

```bash
node scripts/probe-ai.mjs https://your-deployment.example.com
```

The probe prints each HTTP status and MATRIX's own response JSON, including
the specific error codes the UI maps to user-visible copy. Error-code → UI-copy
map lives in `src/lib/api-errors.ts`; storage failures are reported honestly as
`CHAT_STORAGE_UNAVAILABLE` ("Chat storage unavailable") and never as a fake
"could not connect to the AI service".

## SEO & Google Search Console

- `/sitemap.xml` and `/robots.txt` are generated by `src/app/sitemap.ts` /
  `src/app/robots.ts` from `NEXT_PUBLIC_APP_URL` (`src/lib/seo.ts`).
- **Search Console verification works two ways, both shipped:**
  - the `google-site-verification` **meta tag** in `src/app/layout.tsx`, and
  - the **HTML file** `public/google2c32b414ac39f412.html` (Next.js only
    serves static files from `public/` — keep it there, not the repo root).
- The middleware matcher excludes `.html` (alongside images/fonts/manifest) so
  Googlebot's logged-out fetch of the verification file is never 307'd to
  `/login` — a redirect there fails HTML-file verification.

## Troubleshooting deployments

**Every app page (`/chat`, `/dashboard`, …) returns 500 right after a
successful login.** Symptom in the browser console: *"An error occurred in the
Server Components render"* and the host logs show a Firestore error such as
`9 FAILED_PRECONDITION: The query requires an index` or `7 PERMISSION_DENIED`
/`5 NOT_FOUND`.

- **Cause:** server-rendered pages failed while loading sidebar/dashboard data
  from Firestore. Queries that mixed filters with `orderBy` required Firestore
  **composite indexes**, which don't exist until somebody runs
  `firebase deploy --only firestore:indexes` for the project — a fresh project
  therefore crashed every page after sign-in (sign-in itself was unaffected
  because it absorbs Firestore provisioning failures).
- **Fix (shipped):** all reads now use equality-only Firestore filters (which
  never need composite indexes) and order/filter/limit in memory; the app
  layout additionally falls back to an empty sidebar — with the full error in
  the server logs — instead of 500-ing every page. The real fix is observable
  in your host logs as `[MATRIX] Sidebar data failed to load …`.
- **Still recommended:** deploy the security rules once
  (`npm run deploy`). Composite indexes from `firestore.indexes.json` remain
  available as an optional performance optimization for large datasets
  (`firebase deploy --only firestore:indexes`), but nothing breaks without
  them.

**`/api/health` shows `firebase: "unreachable"`.** The service account can mint
sessions but cannot reach Firestore: create the database (Firestore → Create
database → Production mode) and keep `FIREBASE_PRIVATE_KEY` pasted with `\\n`
escapes exactly as shown in `.env.example`.


**Every *guarded* page (`/chat`, `/dashboard`, …) returns 500 for logged-OUT
visitors, and the host logs show `TypeError: Invalid URL …
input: '/login?next=…'` from `middleware.js`.**

- **Cause:** the middleware used to emit a hand-built 307 whose `Location`
  was a bare relative path. Next 15.5's middleware adapter parses that header
  as a URL and throws on relative input, turning every redirect-to-login into
  a 500 under `npm start` (i.e. on Render).
- **Fix (shipped):** redirects are built with
  `NextResponse.redirect(new URL(path, request.nextUrl))` — resolved against
  the URL the visitor actually requested, so the host can never change, and
  Next relativizes the emitted header back to `Location: /login?next=…`.

**Custom subdomain (Cloudflare + Render) redirects to `https://thamjj13.top`
and the browser shows a plain-text `Not Found`.** This is **not** a missing
`/login` route and it is **not** an SPA catch-all problem.

- This app is Next.js App Router. `GET /login` is a real page
  (`src/app/(auth)/login/page.tsx`). The branded 404 (`src/app/not-found.tsx`)
  says **"Page not found"** in HTML. A bare `Not Found` body is Render's
  default response when the `Host` header is not attached to this service.
- `src/middleware.ts` used to 307 unauthenticated visitors from `/` (and
  every other non-public path) to `/login` with an **absolute**
  `Location` built from `request.url`. Behind Cloudflare / Render that URL
  can inherit a different host — typically the apex you set as
  `NEXT_PUBLIC_APP_URL` or as Render's *primary* custom domain. If
  `thamjj13.top` is not itself added to the Render service (only the
  subdomain is), the apex returns plain-text `Not Found`.
- **Fix in this repo:** `/` is now public (the homepage already renders the
  login screen) and middleware redirects are **relative** (`Location: /login?next=…`)
  so they cannot change host.
- **Fix on the host:**
  1. Render → your service → Custom Domains: add **exactly** the hostname
     you visit (the subdomain). Do not mark an unbound apex as the
     primary domain / "redirect to".
  2. Cloudflare: DNS CNAME for the subdomain → `*.onrender.com`, proxy
     orange-cloud is fine. SSL/TLS mode **Full (strict)**. Remove any
     Redirect / Page Rule that sends `*.thamjj13.top` to the apex unless
     the apex is also attached to this same Render service.
  3. Set `NEXT_PUBLIC_APP_URL` to the hostname that actually reaches
     Render (e.g. `https://app.thamjj13.top`), then redeploy so the
     value is baked into the client bundle.
  4. Firebase Auth → Settings → Authorized domains: add that same host.
  5. Confirm `GET https://<your-subdomain>/api/health` and
     `GET https://<your-subdomain>/login` both hit this app.

**Do not add an Express-style `app.get('*')` / Next rewrite to `/`.** This
is not a static SPA. A catch-all rewrite would shadow `/login`, `/chat`,
and every API route. Unknown paths already fall through to
`src/app/not-found.tsx`.

## Internationalization

English + Bangla dictionaries (`src/lib/i18n`) ship today; the architecture is
ready for more locales. The AI answers in the user's language.

## Migration notes (Supabase → Firebase)

| Supabase | Firebase |
|---|---|
| Auth (email/password, OAuth, MFA, reset emails) | Firebase Auth + TOTP MFA + session cookies |
| Postgres RLS (67 policies) | `firestore.rules` (client reads only) + server-side ownership checks |
| `SECURITY DEFINER` RPCs (complete_profile, submit_quiz_attempt, issue_certificate, security_score, rag_search, admin_*…) | `src/lib/server/rpc.ts`, invoked via `/api/rpc` |
| Edge functions (`ai-gateway`, `export-data`, `delete-account`, `auth-events`) | `/api/ai`, `/api/account/export`, `/api/account/delete`, provisioning inside `/api/auth/session` |
| Storage buckets (`security-screenshots`, `identity-documents`) | Cloudinary folders under the same names + signed uploads of private assets |
| `quiz_options_public` view | options embedded on `quiz_questions` without the correct flag; answers in server-only `quiz_answers` |
| `promote-admin.sql` | `npm run set-admin` |
| `db reset / db push` | `npm run seed` (idempotent merge) |

**Seed fix included:** the original SQL join silently dropped 41 of 42 lessons
(the lesson title sat in the module-title column). The Firestore seed rebuilds
the intended mapping — every module gets its 2 lessons (title + summary now both
preserved), so courses contain their full 6 lessons each.

**Migrating existing data:** Supabase data can be exported table-by-table to
JSON and imported into the collections above (IDs may be kept as-is; point the
owner fields at Firebase Auth uids — see `scripts/seed.mjs` for the write pattern).
