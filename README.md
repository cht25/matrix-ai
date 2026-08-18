# MATRIX AI — AI Cyber Safety & Cybersecurity Education Platform

**For users aged 11–17 · Operated by THAMJJ13.TOP White Hat Team**

MATRIX AI is a production-ready, teen-first cybersecurity education platform: an AI chat assistant,
screenshot scanner, scam library, reporting assistant, emergency help mode, 7 courses with quizzes and
verifiable certificates, a security dashboard, and a full RBAC admin panel — all protected by
**Supabase PostgreSQL + Row Level Security + private storage**, with **Groq** behind a secure
server-side AI gateway.

> Previously branded "THAMJJ13.TOP Cyber Safety AI" — rebranded to **MATRIX AI** (developer: THAMJJ13.TOP).

---

## Table of contents

1. [Stack](#stack)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Quick start (local)](#quick-start-local)
5. [Deploy to production](#deploy-to-production)
6. [Environment variables](#environment-variables)
7. [Edge Functions](#edge-functions)
8. [Database](#database)
9. [AI pipeline](#ai-pipeline)
10. [Security model](#security-model)
11. [Admin roles & permissions](#admin-roles--permissions)
12. [Testing](#testing)
13. [Production security checklist](#production-security-checklist)
14. [Demo mode](#demo-mode)
15. [Internationalization](#internationalization)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Design | **MATRIX visual identity**: monochromatic (deep black · charcoal · off-white) with restrained steel-blue accent; editorial Inter + Manrope typography; custom calligraphic vector wordmark; monochrome lucide iconography; animated cinematic background (fine grids, sparse network topology, reduced-motion aware) |
| Database | **Supabase PostgreSQL** (single source of truth — no other database) |
| Auth | Supabase Auth (email/password, Google, Facebook, MFA/TOTP) |
| Storage | Supabase Storage (private buckets + signed URLs) |
| Authorization | PostgreSQL Row Level Security (RLS) + role-based admin access |
| Backend/API | Supabase Edge Functions (Deno) |
| AI | **Groq** (`llama-3.3-70b-versatile` chat, `llama-3.2-11b-vision-preview` scanning) behind the AI Gateway, **streaming responses** |
| i18n | English + Bangla dictionaries (architecture ready for more) |
| Tests | Vitest (AI pipeline, PII, classification, file validation, age rules) + SQL RLS test suite |

The `service_role` key and `GROQ_API_KEY` exist **only server-side** (edge functions / server env) and are never exposed to the browser.

## Product experience

```
Open MATRIX  →  Login (root / shows the login screen for guests)
                    ↓
            Onboarding / verification (multi-step: basic → DOB → age
            verification → email → profile)
                    ↓
            MATRIX AI chat (streaming, temporary chat, screenshot
            attachments, empty-state suggestion cards)
                    ↓
            Scanner · Scam Library · Report · Emergency · Courses ·
            Certificates · Security dashboard · Settings · Docs
```

- `/` shows the professional login experience for unauthenticated users and routes authenticated users straight to `/chat` (no landing page).
- Chat has a desktop sidebar (logo, new chat, search, grouped history — Today / Yesterday / Previous 7 days / Older, with rename/archive/delete) and a mobile drawer + bottom navigation bar.
- AI responses **stream progressively** with stop / retry / regenerate, markdown, code blocks with copy buttons, timestamps, and image attachments that run the screenshot scanner.
- `/docs` is a full documentation system: sticky sidebar, Ctrl+K search, reading progress, breadcrumbs, table of contents, prev/next navigation, callouts and code blocks.
- Admin panel lives at `/admin` with sub-routes: `/admin/users`, `/admin/verification`, `/admin/consents`, `/admin/reports`, `/admin/courses`, `/admin/scams`, `/admin/security`, `/admin/audit-logs`.

### Visual identity (design override)

- **Logo** — custom calligraphic vector MATRIX wordmark (editorial letterforms + signature swash) with a monogram M mark; used on login, sidebar, docs, certificate and footer; monochrome, theme-adaptive.
- **Typography** — Inter for UI, Manrope for display moments (bundled locally via Fontsource); the wordmark is the only calligraphic element.
- **Color** — near-monochrome: `#050608` deep black, `#0b0d10` surfaces, `#e9ebee` ink, restrained steel-blue `#93a5be` accent. No bright gradients, no neon, no rainbow.
- **Background** — fine geometric grid, sparse network nodes, thin data paths, faint technical glyphs; extremely subtle, mobile-reduced, static under `prefers-reduced-motion`.
- **Chat** — editorial layout: AI replies are typographic (hairline rule, no bubbles); user messages are understated bordered notes; large centered composer with attachment and send controls.
- **Icons** — monochromatic lucide icon set; no emoji in navigation or UI chrome (content copy may carry typographic marks only).
- **Certificate** — bordered certificate document with corner accents, the calligraphic wordmark, and public-safe fields only.
- Regenerate favicons anytime with `node scripts/generate-icons.mjs`.

## Architecture

```
                         USER
                           │
                           ▼
                    Web / Mobile UI  (Next.js)
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      Supabase Auth   PostgreSQL    Supabase Storage
      (email/OAuth/     (RLS)       (private buckets,
         MFA)                           signed URLs)
              │            │            │
              └────────────┼────────────┘
                           ▼
                  Supabase Edge Functions
                    (AI Gateway)
                           │
                           ▼
                         Groq
```

The frontend **never calls Groq directly** — it calls the `ai-gateway` edge function with the user's JWT.

## Repository layout

```
├── src/                          # Next.js app
│   ├── app/
│   │   ├── page.tsx              # landing page
│   │   ├── (auth)/               # login, register, forgot/reset password
│   │   ├── (app)/                # dashboard, chat, scanner, courses, settings, admin…
│   │   ├── verify/               # email verification / OAuth callback
│   │   ├── emergency/            # "I Need Help Now" (public)
│   │   ├── certificate/verify/[id]/  # public certificate verification
│   │   └── privacy/              # privacy page
│   ├── components/               # UI kit + feature components
│   ├── lib/
│   │   ├── supabase/             # browser + server clients
│   │   ├── demo/                 # demo-mode preview data (never in production)
│   │   ├── i18n/                 # en + bn dictionaries
│   │   └── utils.ts              # age validation etc.
│   └── middleware.ts             # route protection + admin RBAC gate
├── supabase/
│   ├── config.toml
│   ├── migrations/               # 0001–0007: schema, functions, RLS, seed data
│   ├── functions/                # edge functions
│   │   ├── ai-gateway/           # chat + screenshot analysis (full pipeline)
│   │   ├── export-data/          # GDPR-style data export
│   │   ├── delete-account/       # server-side account deletion workflow
│   │   └── auth-events/          # auth webhooks → security events & sessions
│   └── tests/rls.test.sql        # RLS/constraint test suite
├── tests/                        # Vitest suite (AI, PII, age, storage)
└── scripts/promote-admin.sql     # how to grant admin roles
```

## Quick start (local)

```bash
# 1. Install
npm install

# 2. Start Supabase locally (needs Docker + Supabase CLI)
supabase start          # applies migrations + seed automatically

# 3. Configure env
cp .env.example .env.local
# fill NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY from `supabase status`

# 4. Set the Groq key for the AI gateway
supabase secrets set GROQ_API_KEY=gsk_...
supabase functions serve ai-gateway --env-file .env.local

# 5. Run the app
npm run dev
```

## Deploy to production

```bash
# Database + seed
supabase link --project-ref <ref>
supabase db push
supabase db seed --path supabase/migrations/0007_seed.sql   # if not included in push

# Edge functions
supabase secrets set GROQ_API_KEY=gsk_...
supabase secrets set SUPABASE_WEBHOOK_SECRET=<random>
supabase functions deploy ai-gateway export-data delete-account auth-events

# Auth webhook (optional but recommended): Dashboard → Auth → Webhooks →
#   "New webhook" → events user.signed_in / user.signed_out / user.updated /
#   user.password_recovery_requested / user.password_updated / user.identity_created
#   URL: https://<project-ref>.supabase.co/functions/v1/auth-events
#   secret: the SUPABASE_WEBHOOK_SECRET you set

# Frontend
npm run build && npm run start   # or deploy to Vercel/your host
```

Enable email confirmations, restrict Auth redirect URLs, and configure Google/Facebook OAuth
providers in the Supabase dashboard. Configure SMTP for branded emails (verification, reset, alerts).

### Promote your first admin

```sql
-- find your id, then run scripts/promote-admin.sql
select id, email from auth.users where email = 'you@example.com';
```

## Environment variables

See `.env.example`. Summary:

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | frontend | Supabase client |
| `NEXT_PUBLIC_APP_URL` | frontend | canonical URL |
| `NEXT_PUBLIC_DEMO_MODE` | frontend | `true` = clearly-badged UI preview (never in production) |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only | admin API access (edge functions use their own injected copy) |
| `GROQ_API_KEY` | server-only (edge secret) | AI gateway |
| `SUPABASE_WEBHOOK_SECRET` | server-only (edge secret) | auth webhook signature verification |
| `SMTP_*` | server-only | custom transactional email |

**Never** expose `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, SMTP or OAuth secrets to client code.

## Edge Functions

### `ai-gateway` — the only way the frontend reaches Groq
`POST { action: "chat" | "scan" }` with the user JWT.

- **chat** — full pipeline (see below), conversation management, rolling summaries for long chats,
  safe memory extraction, PII redaction, refusals without LLM calls, rate limiting
  (20/min, 300/day per user), usage + safety logging.
- **scan** — validates the uploaded screenshot (magic bytes, size, dimensions — executables and
  mismatched MIME types are rejected), re-checks ownership of the storage path, analyzes with the
  vision model, stores the result in `security_analyses`.

### `export-data` — JSON export of the user's own data (safe fields only), stored in the private
`exports` bucket with a 7-day signed URL; logs a `data_exported` security event.

### `delete-account` — server-side deletion workflow: removes private storage objects, deletes all
user-owned rows (conversations cascade to messages/summaries), audits, then `admin.deleteUser`
(which cascades to `auth.users` → `profiles`). Requires `confirm: "DELETE"` after client-side
re-authentication.

### `auth-events` — verifies the Supabase Auth webhook signature (legacy header or HMAC-SHA256),
maps events (`user.signed_in` → `login`, `user.signed_out` → `logout`, password events, identity
events) into `security_events` + `user_sessions`, and sends login-alert notifications.

## Database

All changes are migration-based (`supabase/migrations/0001–0007`):

- `0001` — profiles, identity_verifications, guardian_consents, user_security_settings,
  oauth_profiles, countries
- `0002` — conversations, messages, summaries, user_memories, attachments, security_analyses
- `0003` — scam_categories, scam_articles, scam_reports, reporting_resources, document_chunks (RAG)
- `0004` — courses, modules, lessons, quizzes, questions, options, attempts, progress, certificates,
  certificate_verification
- `0005` — notifications, security_events, user_sessions, admin RBAC, audit_logs, ai_usage_logs,
  ai_safety_events, admin_access_grants
- `0006` — **functions, triggers, grants, and every RLS policy**
- `0007` — seed data (20 countries, admin roles/permissions, 10 scam categories, 10 verified scam
  articles, 16 verified reporting resources, 10 RAG knowledge chunks, **7 courses · 21 modules ·
  42 lessons · 21 quizzes · 63 questions**)

Highlights:

- `handle_new_user()` trigger validates DOB **server-side** at signup — `11 ≤ age ≤ 17` or signup fails.
- `age_verified` / `date_of_birth` are write-protected: only SECURITY DEFINER functions
  (`complete_profile`, `review_identity_verification`) can change them.
- `quiz_options` are not exposed to learners — a public view strips `is_correct`; scoring happens in
  `submit_quiz_attempt()` in the database, so clients can never fake scores.
- `issue_certificate()` checks eligibility in SQL and issues unique `MATRIX-YYYY-XXXXXXXX` IDs;
  `verify_certificate_lookup()` is anon-callable and returns only public-safe fields.
- Temporary chats are hard-deleted after 24h by `expire_stale()` (scheduled via pg_cron when available).
- RAG uses PostgreSQL full-text search over `document_chunks` + scam articles + lessons + reporting
  resources (`rag_search`), with a trust model (`trusted_official` / `trusted_internal` /
  `review_required` / `user_generated`) — only trusted sources feed the AI.

## AI pipeline

```
User Request
    ↓
Authentication (JWT)
    ↓
Rate limit (DB-backed: 20/min chat, 5/min scans)
    ↓
PII detection & redaction  (emails, phones, OTPs, passwords, cards,
                            JWTs, government IDs, addresses…)
    ↓
Cyber domain classification   → off-topic: refuse (no LLM call)
    ↓
Cyber safety classification   → harmful: refuse + redirect (no LLM call)
    ↓
Prompt construction (system prompt + summary + recent messages +
                     safe memory + RAG context + verified reporting resources)
    ↓
Groq (llama-3.3-70b-versatile)
    ↓
Output safety validation + PII-leak check
    ↓
Store allowed response → return
```

The refusal path for off-topic/harmful requests **never contacts Groq**, so the guardrails are cheap
and deterministic; the system prompt is an additional layer, never the only one.

## Security model

- **RLS on every user-owned table** — `auth.uid() = user_id` policies; admins never get blanket
  access to conversations (see below).
- **Admin RBAC** — `admin_roles` × `admin_permissions` (`has_permission()` SECURITY DEFINER); no
  `is_admin` boolean flags as the only mechanism. Roles: `super_admin`, `security_admin`,
  `content_admin`, `support_admin`, `auditor`.
- **Privileged data access** — admins request a **time-limited grant** (`request_admin_access`,
  reason required, 1h–7d); `admin_list_conversations` / `admin_view_conversation` enforce the grant
  and write an audit entry. Conversations are never visible by default.
- **Storage** — private buckets (`chat-attachments`, `security-screenshots`,
  `identity-documents`, `certificates`, `exports`); per-user folder isolation enforced by path
  checks in the edge function + storage policies; signed URLs with short expiry; avatars are
  public-read only.
- **Secrets** — passwords/OTPs/tokens are never stored in app tables (they live in `auth.users`
  hashed form only); birth certificate numbers are never stored — only a verification reference
  and outcome; `user_memory_guard` trigger blocks storing secret-like text in memories.
- **PII before AI** — `_shared/pii.ts` redacts personal data before any Groq call; the model is
  instructed to never request or echo secrets; responses are scanned for leaked PII and redacted.
- **Audit** — sensitive admin actions write `audit_logs`; AI usage/safety events log only safe
  metadata (never raw prompts).
- **Account deletion** — re-authenticate → confirm → server-side workflow → storage cleanup →
  `admin.deleteUser`. Data export exists with 7-day expiry.

## Admin roles & permissions

| Permission | Super | Security | Content | Support | Auditor |
|---|---|---|---|---|---|
| `admin.manage` | ✅ | | | | |
| `users.view` | ✅ | ✅ | | ✅ | |
| `users.view_pii` | ✅ | ✅ | | | |
| `verification.review` | ✅ | ✅ | | | |
| `consent.review` | ✅ | ✅ | | ✅ | |
| `content.manage` | ✅ | | ✅ | | |
| `reports.view` | ✅ | ✅ | ✅ | ✅ | |
| `security.view` | ✅ | ✅ | | | ✅ |
| `ai.view` | ✅ | ✅ | | | ✅ |
| `learning.view` | ✅ | | ✅ | | |
| `certificates.view` | ✅ | ✅ | ✅ | | ✅ |
| `audit.view` | ✅ | ✅ | | | ✅ |
| `privacy.access` | ✅ | ✅ | | | |
| `system.settings` | ✅ | | | | |

Assign roles with `scripts/promote-admin.sql`.

## Testing

```bash
npm test                 # 40 Vitest tests: PII redaction, domain/safety classification,
                         # Groq provider (mocked), prompt/output validation, file validation,
                         # age rules (10→reject, 11→ok, 17→ok, 18→reject, future→reject)
npx tsc --noEmit         # typecheck
```

Database tests (`supabase/tests/rls.test.sql`) cover RLS access, age validation, constraints,
SECURITY DEFINER function exposure and profile-column protection. Run them with
`supabase db test` (or psql) against a local instance.

## Production security checklist

- [ ] RLS enabled on every user-owned table (verified by `supabase/tests/rls.test.sql`)
- [ ] `service_role` key never exposed (server-only)
- [ ] Storage policies tested; private buckets verified; signed URLs short-lived
- [ ] Auth redirect URLs restricted; email confirmations enabled; OAuth providers configured securely
- [ ] SECURITY DEFINER functions audited; `search_path` set on every one
- [ ] `GROQ_API_KEY` / webhook secret set as edge secrets, not client env
- [ ] Backups enabled (Supabase project settings)
- [ ] Auth webhook configured → login alerts + security events
- [ ] SMTP configured with safe templates (no secrets in emails)
- [ ] `NEXT_PUBLIC_DEMO_MODE` stays `false` in production

## Demo mode

`NEXT_PUBLIC_DEMO_MODE=true` serves a clearly-badged preview with sample data so you can click
through the product **without any backend**. It stores nothing, calls no AI, and is intended for
development/testing only. All production behavior requires the real Supabase project + Groq key.

## Internationalization

`src/lib/i18n/` contains English and Bangla dictionaries with a tiny `t()` helper; the architecture
supports adding more locales without touching page code. Course/lesson content lives in the database
(already schema-ready for per-language content via `document_chunks.language`).

---

© MATRIX AI — **THAMJJ13.TOP White Hat Team**. If you are in danger, tell a trusted adult.
