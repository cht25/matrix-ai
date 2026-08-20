# MATRIX AI — ULTRA Implementation Prompt

**Copy this entire document to an AI coding agent.** The agent must inspect the real repository, fix the real bugs, and implement the missing production features **in this existing Matrix AI codebase**. Do not start a new app. Do not rebrand. Do not invent a parallel stack.

---

## 0. Who you are and how you must work

You are a senior full-stack engineer implementing production changes in **MATRIX AI**, a Next.js 15 / React 19 / TypeScript / Tailwind 4 / Firebase (Auth + Firestore) / Cloudinary / Groq + OpenRouter platform.

### Mandatory workflow

1. **Analyze first.** Read the files listed in §2 before writing code. Confirm current behavior. Do not assume features exist just because the README mentions them.
2. **Write a short implementation plan** (phases, files, data-model changes, risks) in the PR / commit notes.
3. **Implement for real.** Every button, form, OAuth path, publish action, admin action, and AI theme action must complete an end-to-end flow. No mock data, no dead buttons, no “coming soon” UI that looks clickable, no placeholder APIs, no fake deployments, no hardcoded demo users.
4. **Do not break existing functionality.** Chat, Agent artifacts, GitHub review-before-push, scanner, courses, quizzes, certificates, scam library, reports, MFA, password reset, i18n, health checks, and the no-demo-mode contract must keep working.
5. **Preserve product identity.** Keep the MATRIX visual language: monochrome (obsidian / charcoal / off-white), restrained steel-blue accent, Inter + Cormorant Garamond + Tangerine, calligraphic wordmark, CSS variables in `src/app/globals.css`, cinematic `CyberBackground`, honest error screens. Polish and extend — do not replace with a generic SaaS look.
6. **Ship tests** for new validation, hashing, project/file safety, theme persistence, deploy URL rules, and auth error mapping. Run `npm test` and `npm run typecheck`. Fix what you break.
7. **Security is not optional.** Never send DOB, birth-certificate numbers, GitHub tokens, Cloudinary secrets, or provider keys to an AI model or the browser console. Never store identity numbers in plaintext. Never allow one user to read another user’s theme, files, or deployments.

### Hard product rules already in this repo (do not violate)

- There is **no demo mode**. Missing config must render `ServerProblem` / honest 503s.
- Browser Firestore writes are denied. All mutations go through `/api/rpc` or dedicated API routes.
- The AI gateway (`/api/ai`) is the only path to Groq / OpenRouter. PII is redacted first.
- Agent never auto-pushes to GitHub. Review + explicit confirm required.
- Failures return error codes. Never fabricate an assistant reply, a deploy URL, or a quiz score.
- MATRIX is for ages **11–17**. Age is validated server-side.

---

## 1. Mission

Make MATRIX AI feel like a polished, production-ready AI product **without discarding its core concept**:

> Chat · create · learn · build · preview · publish / push with approval  
> All-in-one assistant + cyber-safety education + dedicated software Agent.

You must:

1. Fix Google / Gmail (and Facebook) authentication so success is success and failure is honest.
2. After OAuth signup, collect remaining required profile fields. **Stop requiring a birth-certificate image.** Collect **Date of Birth + Birth Certificate Number** only, with a clear, truthful explanation.
3. Polish UI/UX and make it properly responsive across phone, tablet, laptop, and desktop.
4. Make the admin panel a real control center, including course create/edit and a reliable admin bootstrap.
5. Add AI-controlled, **per-user** theme templates.
6. Upgrade Agent Mode into a real multi-file project workspace with folder tree, editor, live preview, autosave, import/export, and version history.
7. Add first-party **website publish/hosting** from Agent projects (in addition to existing GitHub push).
8. Add the other production features listed in §6 that this codebase is missing, if they can be implemented completely in this pass.

---

## 2. Current architecture (ground truth)

Read these before changing anything.

### Stack

| Layer | Reality in this repo |
|---|---|
| App | Next.js 15 App Router, React 19, TypeScript, Tailwind 4 |
| Auth | Firebase Auth email/password + Google + Facebook + TOTP MFA → ID token → `POST /api/auth/session` → httpOnly `__session` cookie (5 days) |
| DB | Cloud Firestore only. Snake_case collections. Server Admin SDK for writes |
| Mutations | `src/lib/server/rpc.ts` + `src/app/api/rpc/route.ts` |
| Images | Cloudinary signed private uploads (`security-screenshots/{uid}/`, `identity-documents/{uid}/`) |
| AI | `/api/ai` — Groq general/vision, OpenRouter NVIDIA Nemotron 3 Ultra for coding + Agent |
| Agent files | Parsed from `<<<MATRIX_FILE path="...">` blocks in `src/lib/ai/agent.ts`, stored on assistant message `metadata.artifacts` |
| Preview | Client-only `srcDoc` iframe in `src/components/agent-workspace.tsx` (inline CSS/JS) |
| GitHub | Encrypted OAuth token, explicit review-before-push, `src/lib/server/github.ts` |
| Theme today | `dark` / `light` / `system` in `localStorage` key `matrix-theme` (`src/lib/theme.tsx`) |
| Admin | RBAC via `admin_role_assignments` + `npm run set-admin <email> [role]` |
| i18n | English + Bangla (`src/lib/i18n`) |

### Critical files

```
src/app/layout.tsx                          root layout, ThemeProvider, CyberBackground
src/app/globals.css                         design tokens (do not throw away)
src/app/(auth)/login/page.tsx
src/app/(auth)/register/page.tsx
src/app/(auth)/register/register-form.tsx   email signup + broken OAuth
src/components/auth/login-screen.tsx        login + OAuthButtons + AuthShell
src/app/api/auth/session/route.ts           session cookie mint + ensureUserDocuments
src/lib/firebase/session.ts                 cookie options (secure / sameSite)
src/lib/firebase/auth-errors.ts             error taxonomy (underused on OAuth)
src/lib/client/api.ts                       rpc(), mintSessionCookie(), uploadOwnedFile()
src/lib/server/rpc.ts                       completeProfile, identity, RBAC, courses…
src/app/api/rpc/route.ts                    action map
src/components/onboarding-client.tsx        still requires birth-certificate IMAGE
src/app/(app)/onboarding/page.tsx
src/components/app-shell.tsx                sidebar / mobile drawer / bottom nav
src/components/chat-client.tsx              chat + agent mode + attachments
src/components/agent-workspace.tsx          preview / flat file list / GitHub tab
src/lib/ai/agent.ts                         artifact parser, path safety
src/lib/ai/prompts.ts                       SYSTEM_PROMPT + AGENT_SYSTEM_PROMPT
src/app/api/ai/route.ts                     gateway
src/lib/theme.tsx                           dark/light/system only
src/components/settings/appearance-panel.tsx
src/components/admin/*                      overview, users, courses (publish toggle only)
scripts/set-admin.mjs                       CLI-only admin bootstrap
src/middleware.ts                           unverified cookie presence / admin UX gate
src/lib/routing.ts                          public / auth paths
```

### Firestore collections you will extend (do not rename existing ones)

Existing: `profiles`, `user_security_settings`, `guardian_consents`, `identity_verifications`, `countries`, `conversations` + `messages`, `conversation_summaries`, `user_memories`, `courses`, `course_modules`, `lessons`, `quizzes`, `quiz_questions`, `quiz_answers`, `quiz_attempts`, `course_progress`, `certificates`, `scam_*`, `notifications`, `security_events`, `user_sessions`, `github_connections`, `admin_*`, `audit_logs`, `ai_usage_logs`, `ai_safety_events`.

You will add new collections for projects, project files, deployments, theme preferences, and hashed identity numbers. Keep snake_case. Scope every document by `user_id` / `owner_id`. Enforce ownership in RPC.

---

## 3. Known bugs and gaps you must treat as confirmed

These were identified by reading the current code. Verify, then fix the real cause — do not paper over them with a toast.

### 3.1 Google / Gmail “Failed” even though the Auth account is created

This is the highest-priority auth bug.

**What happens today**

1. Firebase Auth `signInWithPopup(Google)` succeeds → Auth user is created.
2. The UI then calls `mintSessionCookie()` and/or `finishSignIn()`.
3. Any post-Auth failure is caught and shown as a generic **“Sign-in with google failed”**.
4. On the register form, `mintSessionCookie().catch(() => {})` **swallows** session errors, then hard-redirects to `/onboarding`. If the cookie was not minted, middleware bounces the user to `/login` and the flow looks broken.

**Concrete defects**

| File | Defect |
|---|---|
| `src/components/auth/login-screen.tsx` `oauth()` | After a successful popup, `finishSignIn()` (`mintSessionCookie` + `record_security_event` + `router.push`) throwing is mapped to `"Sign-in with " + provider + " failed"`. The Auth account already exists. `describeAuthError()` is **not** used here. Popup-closed / cancelled are ignored on login (good) but other Firebase codes (`auth/unauthorized-domain`, `auth/account-exists-with-different-credential`, `auth/popup-blocked`, `CONFIGURATION_NOT_FOUND`) collapse to “failed”. |
| `src/app/(auth)/register/register-form.tsx` `oauth()` | Same generic error. **No `getRedirectResult` handler** (login has one; register does not). Redirect fallback therefore never completes on `/register`. Session mint errors are swallowed. Always redirects to `/onboarding` even for returning Google users who already finished profile. |
| `src/lib/client/api.ts` `mintSessionCookie()` | Force-refreshes the ID token then POSTs `/api/auth/session`. Failures throw `SESSION_MINT_FAILED` / `INTERNAL`. Login treats this as “Google failed”. |
| `src/lib/firebase/session.ts` `sessionCookieOptions()` | `secure: process.env.NODE_ENV === "production"`. On an HTTPS preview / custom domain this is fine; on mixed HTTP production-like hosts the cookie will not stick. Audit and make this host-aware (`request.nextUrl.protocol` or `x-forwarded-proto`) so the cookie is set correctly. |
| OAuthButtons | Busy state clears in `finally` even when a redirect is in flight; not fatal, but combine with a single shared OAuth helper. |

**Required fix (do all of this)**

1. Extract **one shared OAuth helper** used by login and register:
   - `signInWithPopup` first.
   - On `auth/popup-blocked`, `auth/operation-not-supported-in-this-environment`, or COOP/iframe issues → `signInWithRedirect`.
   - Both `/login` and `/register` must handle `getRedirectResult` on mount.
   - Ignore `auth/popup-closed-by-user` and `auth/cancelled-popup-request` (no error banner).
   - Map every other Firebase code through `describeAuthError()` plus specific copy for:
     - `auth/account-exists-with-different-credential` → “An account with this email already exists. Sign in with email/password, then link Google in Settings.”
     - `auth/unauthorized-domain` → operator must add the host in Firebase Authorized domains.
     - `auth/operation-not-allowed` → Google/Facebook provider not enabled.
     - session mint failure → **do not say Google failed**. Say the Auth sign-in succeeded and the server session could not be created; offer Retry session. Do not create a second Auth user.
2. After Auth success:
   - Always `getIdToken(true)` then `mintSessionCookie()`.
   - Call `ensureUserDocuments` (already in session route). Surface provision failures in server logs only; do not fail sign-in if the cookie minted.
   - Record `login` security event best-effort.
3. **Post-OAuth routing (critical product requirement):**
   - If the profile is missing DOB or birth-certificate number (or onboarding incomplete) → `/onboarding?source=google` (or `facebook`).
   - If onboarding is complete → `next` query or `/chat`.
   - Never dump a brand-new Google user into chat with an empty profile.
   - Returning users must not be forced through registration steps again.
4. Pre-fill name + email from the Google/Facebook profile. Do not ask for a password. Do not require email/password fields for the OAuth path.
5. Link accounts when the same verified email already exists, using Firebase’s recommended account-linking flow. Never create a silent duplicate profile.
6. Add an integration-style unit test around the error mapper so “Auth succeeded / session failed” can never again be labeled “Google failed”.

### 3.2 Birth-certificate IMAGE is still required

`register-form.tsx` step 2 and `onboarding-client.tsx` step 3 still upload a PNG/JPG to Cloudinary `identity-documents/{uid}/` and call `submit_identity_verification` with `verification_type: "birth_certificate"` and a storage path.

**Replace this.** Image upload of a birth certificate is no longer required and must be removed from the default user flow.

Keep Cloudinary for **screenshot scanner** uploads. Do not delete the scanner pipeline.

### 3.3 Agent workspace is not a real IDE

Today:

- Files live only on the latest assistant message `metadata.artifacts`.
- File list is a **flat** button list (no folders).
- There is **no editor** — read-only `<pre>`.
- Preview inlines CSS/JS into `srcDoc`. Images / extra assets are not resolved.
- No persistence of a project across chats.
- No ZIP import/export.
- No version history.
- No first-party publish. Only GitHub push.
- Agent file caps: 40 files, 300 KB/file, 700 KB total (`parseAgentResponse`). Raise these carefully and persist large trees in a dedicated collection, not a single Firestore message document (1 MiB limit).

### 3.4 Admin cannot actually manage the platform

- `CoursesAdmin` can only toggle `published` / `draft`. The content tab literally says course/lesson/quiz editing lives in the Firebase console.
- Users tab is read-only.
- No in-app way to create the first admin. Only `scripts/set-admin.mjs`.
- No system settings, usage, AI-model, or deploy admin views.

### 3.5 Theme is local-only and not AI-driven

`src/lib/theme.tsx` stores `dark|light|system` in `localStorage`. It is not per-account, not synced, and the AI has no structured “show theme templates” action.

### 3.6 UI polish / responsive debt

The shell already has a mobile drawer + bottom nav + `lg:` sidebar, but:

- Agent workspace is a right drawer that is awkward on phones (full-screen overlay is fine; file tree + editor + preview need a stacked mobile layout).
- Admin tables (`min-w-[720px]`) are not usable on small screens.
- Chat composer / immersive height / bottom-nav collisions need a pass on 375px, 768px, 1024px, 1440px.
- Empty / loading / error / success states exist in some places and are missing in others (admin load failures, GitHub repo load, onboarding).
- Appearance panel uses emoji as icons — replace with lucide, keep the MATRIX look.

---

## 4. Identity verification: DOB + Birth Certificate Number

### 4.1 Why these two fields (implement this explanation in the UI, verbatim-quality)

Show this explanation on onboarding and in Settings, in the user’s language:

> MATRIX is for people aged 11–17. We ask for your **date of birth** so we can check that you are in that age range, apply the correct guardian-consent rules for your country, and keep adult accounts out of a youth platform.
>
> We ask for your **birth certificate number** (not a photo) so the security team can confirm you are a real person in that age range without collecting a scan of a legal document. A document image is a high-risk piece of identity data. A number can be checked and stored as a one-way hash.
>
> We never send your date of birth or certificate number to the AI. We never show the number back in chat, logs, or analytics. Only hashed data is stored. Admins see a masked reference and a verification status, not the raw number.

### 4.2 Logical + secure implementation

**Collect**

- `date_of_birth` as `YYYY-MM-DD` (already the contract).
- `birth_certificate_number` as a trimmed string.
- Optional country-specific format hint (e.g. Bangladesh vs generic). Accept alphanumeric + hyphens/spaces; normalize to uppercase alphanumeric before hashing.

**Validate server-side only** (`complete_profile` / new `submit_identity_number`)

1. DOB via existing `validateDob()` — 11 ≤ age ≤ 17, not future, not missing. Keep `tests/age.test.ts` green; extend if you add timezone-safe parsing.
2. Certificate number:
   - required, length 6–32 after normalization
   - charset `[A-Z0-9]`
   - reject obvious fakes (`000000`, `123456`, all same digit) with `CERT_NUMBER_INVALID`
   - rate-limit submissions (e.g. 5 / day / uid)
3. Hash with a server-only pepper:
   - `identity_hash = HMAC-SHA256(IDENTITY_PEPPER, uid + ":" + normalizedNumber)`
   - also store `identity_hash_global = HMAC-SHA256(IDENTITY_PEPPER, normalizedNumber)` for duplicate detection across accounts
   - store `identity_last4` (last 4 of normalized number) for admin masking only
   - **never** write the raw number to Firestore, logs, analytics, or AI prompts
4. Add `IDENTITY_PEPPER` to `.env.example` (32+ random chars). If missing, identity submit must fail honestly (`not-configured`), not store plaintext.
5. Uniqueness: if `identity_hash_global` already belongs to a **different** uid with `approved` or `pending_review` status → `CERT_NUMBER_IN_USE`.
6. Create / update `identity_verifications` with:
   - `verification_type: "birth_certificate_number"`
   - `verification_status: "pending_review"` (or auto-approve only if you also implement a deterministic checksum — default is human review)
   - `identity_hash`, `identity_hash_global`, `identity_last4`
   - `date_of_birth_snapshot` is **not** required if DOB already lives on `profiles`; do not duplicate unnecessarily
7. `profiles.age_verified` stays `false` until an admin approves (existing `review_identity_verification`).
8. PII redaction (`src/lib/ai/pii.ts`) must detect certificate-number-like tokens and DOB patterns in chat and redact them. Add tests.
9. Account export may include verification **status**, never the raw number or hash pepper.
10. Account deletion must delete verification docs.

**UI flow after Google / Facebook signup**

```
OAuth success
  → session cookie
  → /onboarding
       1. Confirm name (pre-filled)
       2. Date of birth + why
       3. Birth certificate number + why + show/hide toggle
       4. Country / optional school / grade
       5. Guardian consent if country+age requires it (keep existing logic)
       6. Email verification if the provider did not verify email
       7. Done → /chat
```

Remove the identity-document file picker from register and onboarding. Admin verification queue must review number-based submissions (masked `••••AB12`, type, submitted-at, approve/reject with reason). Do **not** break the old image-based queue rows if any exist; render them as “legacy document” and allow approve/reject without requiring a new upload.

**Email/password register** should use the same remaining-info steps. Collapse the old 6-step “upload ID” wizard into this cleaner flow. Keep password ≥ 8 and email verification.

---

## 5. Implementation plan (execute in this order)

Do not skip Phase 0–2. Later phases may land in the same PR if complete, but auth + identity must be correct first.

### Phase 0 — Reconnaissance (no product regressions)

- Map every auth entry: login, register, forgot/reset password, verify, OAuth popup + redirect, session mint, middleware bounce, onboarding gate.
- Confirm which admin permissions exist in seed (`super_admin`, `security_admin`, `content_admin`, `support_admin`, `auditor`).
- Confirm Agent artifact limits and where files are stored.
- Note CSS variables you must keep.

### Phase 1 — Auth that actually completes

- Shared OAuth helper + redirect result on **both** pages.
- Honest error taxonomy.
- Session cookie reliability (Secure / host / SameSite).
- Post-login routing based on profile completeness.
- Account linking.
- Tests for error mapping and routing helpers.

### Phase 2 — Onboarding: DOB + certificate number

- RPC + Firestore + pepper + hashing + uniqueness + rate limit.
- Replace image UI.
- Admin queue update.
- PII redaction updates.
- i18n strings (en + bn).
- Tests.

### Phase 3 — UI/UX polish (same identity, higher craft)

Responsive breakpoints:

- 360–430px phones: stacked Agent workspace (tabs: Preview / Files / Publish), bottom nav not covering composer, 44px targets, 16px inputs (already in CSS), drawer working.
- 768–1024px tablets: usable split (tree | editor or preview), admin cards instead of wide tables.
- 1280px+ desktop: sidebar + optional Agent side panel / full workspace page.

Improve, don’t reinvent:

- `app-shell.tsx` information architecture: Chat, Agent, Projects, History, Learn, Scanner, Settings. Keep Emergency. Keep Admin for staff.
- Dashboard: become a real home (recent chats, recent projects, deploys, courses, security score) while remaining honest if a section is empty.
- Profile / account: existing settings tabs stay; add theme templates + projects + deployments there as real panels.
- Loading skeletons, empty states, error + retry, success toasts — every new surface.
- Accessibility: labels, focus rings (already global), keyboard file tree, `prefers-reduced-motion` (already respected).
- Dark/light remain first-class. Theme templates layer on top of the token system.

### Phase 4 — Per-user AI theme templates

**Behavior**

If the user says things like “change your theme”, “change the theme”, “show themes”, “switch theme”, “make it darker/light/ocean/midnight” in chat (en or bn/Banglish):

1. The gateway must detect a **theme intent** (deterministic classifier in `src/lib/ai/domain.ts` or a small dedicated helper — do not rely only on the LLM).
2. The chat UI renders a **Theme Gallery** card (not just markdown). Several professionally designed templates, each with:
   - name, short description
   - color swatches (bg, surface, ink, accent)
   - preview tile that actually uses those tokens
3. Clicking **Apply** saves the template to **that user’s** `profiles.theme_id` + `user_security_settings` / `user_preferences` and updates CSS variables for that browser only.
4. Other users are unaffected. Incognito / other account does not inherit it.
5. Settings → Appearance lists the same templates + Dark / Light / System.
6. “Reset to MATRIX default” is required.

**Implementation notes**

- Extend `:root` / `[data-theme]` with `[data-theme-template="midnight"]` etc. Templates must still support light + dark bases **or** be explicit dark/light pairs. Ship at least **6 complete templates**, for example:
  - MATRIX Default (current tokens)
  - Midnight Ink
  - Ivory Editorial
  - Carbon Steel
  - Aurora
  - Forest Signal
- Persist `theme` (`dark|light|system`) and `theme_template` on the user document via RPC `settings_update` / `theme_update`.
- Hydrate from server in `(app)/layout.tsx` so the account theme wins over stale localStorage after login. Keep the blocking theme script in `layout.tsx` to avoid flash.
- Never put theme CSS in a way that leaks into published user sites.

### Phase 5 — Agent Mode = online IDE for web projects

Build a real **Project** abstraction.

**Data model (suggested)**

```
projects/{projectId}
  owner_id, title, description, stack ("static-web" | …),
  conversation_id?, created_at, updated_at, archived_at

projects/{projectId}/files/{fileId}
  path, content, language, updated_at, updated_by ("user"|"agent")

projects/{projectId}/versions/{versionId}
  created_at, source ("autosave"|"agent"|"restore"|"import"),
  summary, file_count

deployments/{deploymentId}
  project_id, owner_id, status (queued|building|live|failed|unpublished),
  slug, public_url, error, log[], created_at, updated_at
```

Store file content in the file docs, **not** on chat messages. Chat artifacts should **upsert into the active project** (merge by path). Keep a copy of the agent reply in the conversation for history.

**Workspace UX** (`AgentWorkspace` + a first-class `/projects` and `/projects/[id]` route)

Must support:

- Multiple files and nested folders (tree view, expand/collapse).
- Create / rename / delete file or folder (RPC, path-safe via `safeAgentPath`).
- Open a folder and see the whole project structure.
- Code editor for the active file (textarea + monospace is acceptable if it is a real editor: tab key, line count, dirty state; a lightweight editor is fine — do not add a huge dependency unless it is justified and works).
- **Live preview** of the project:
  - Prefer serving preview through a same-origin route e.g. `GET /api/projects/:id/preview/*` that resolves HTML/CSS/JS/images from the project files with sandbox headers (`Content-Security-Policy`, no cookie leak).
  - Also keep a client `srcDoc` fallback for a single HTML file.
  - Resolve relative CSS, JS, images, fonts that exist in the project.
  - Refresh preview on save (debounce 300–500ms).
- Edit → save → preview updates immediately.
- Common static web structures: `index.html`, `css/`, `js/`, `images/`, `assets/`.
- Autosave (debounce) with dirty indicators.
- Version history: snapshot on Agent apply, on publish, and on manual “Save version”. Restore a version (creates a new snapshot first).
- Import ZIP (server-side unzip of text + common web assets; reject zip bombs, binaries except images, path traversal). Export ZIP of the project.
- Import/export individual files.
- Multi-file Agent: when the user is in a project, attach the tree (paths + truncated contents) as Agent context and apply returned `MATRIX_FILE` blocks as a reviewable diff. User confirms **Apply to project**.
- Error detection: basic HTML/JS syntax diagnostics in the editor (honest — no fake “AI compiled this”). Optional “Ask Agent to fix” sends the current file + error text to Agent.
- Do not claim framework builds (Next/Vite) were compiled unless you implement a real builder. Static HTML/CSS/JS is the supported publish target. If the Agent generates a React/Vite tree, preview should say so honestly and still allow file editing + GitHub push.

**Caps (enforce server-side)**

- e.g. 80 files / project, 200 KB text / file, 5 MB images / project, 20 projects / user unless you add plans. Return clear errors.

### Phase 6 — Publish / host the website from MATRIX

Users must be able to preview a project and publish it from the platform.

**v1 (must be real, not a mock)**

- “Publish” on the project/workspace.
- Server builds a static snapshot from project files (only user-owned files, path-safe).
- Host at a stable same-origin URL:
  - `https://<app-host>/s/<slug>`
  - slug: user-chosen or generated, unique, `[a-z0-9-]{3,40}`
- Middleware / routing: published sites are public **read-only**. They must **not** require login. They must **not** inherit the app chrome, session UI, or theme. Serve with:
  - `Content-Type` correct for html/css/js/svg/png/jpg/webp/ico/woff2
  - `X-Content-Type-Options: nosniff`
  - restrictive CSP (no parent cookie access)
  - no `__session` leakage
- Deployment record: status (`queued` → `building` → `live` | `failed`), timestamps, URL, short log (real steps: validate → snapshot → write → activate).
- Controls: Publish, Republish, Unpublish, Open live site, Copy URL, View logs.
- Unpublished slugs return the app 404, not a blank 200.
- Custom domains: implement **or** ship a complete “Add domain” flow that stores the domain, shows DNS instructions (CNAME to the app host), and verifies via a `/.well-known/matrix-domain` challenge. If DNS verification is not possible in this environment, do **not** show a fake “connected” state — show `pending_dns` honestly and still keep slug URLs working.
- Env / secrets for static sites: allow `PROJECT_ENV` key/value pairs injected only into a generated `env.js` the user opts into. Never expose server `.env`. Never send secrets to the AI.

Keep GitHub push as a separate, existing path.

### Phase 7 — Admin control center

**Admin bootstrap**

- Document in README (already has `npm run set-admin`).
- Add a **one-time** in-app bootstrap: if Firestore has **zero** `admin_role_assignments`, the signed-in user may enter `ADMIN_BOOTSTRAP_KEY` (server env) on `/admin/setup` to become `super_admin` and set the custom claim. After one assignment exists, the page 404s. Audit the action.
- Never hardcode a default email/password admin.

**Admin must be able to manage from one place**

Extend `/admin` (keep RBAC):

| Area | Required capability |
|---|---|
| Overview | Existing stats + new: projects, live deploys, AI usage 24h |
| Users | Search, filter, view profile (non-PII), disable/enable, assign role (`users.manage` / super_admin), force logout |
| Verification | Number-based queue (masked), approve/reject with reason |
| Consents | Keep |
| Courses | **Full CRUD**: create/edit course, modules, lessons (markdown body), quizzes + options; set correct answer server-side only; publish/unpublish/archive; reorder |
| Scam library | Keep status toggles; add create/edit article if not complete |
| Security | Keep events/sessions/safety |
| Audit logs | Keep |
| Content / CMS | Settings: maintenance flag, min/max age, registration open, feature flags (agent, publish, oauth) stored in `system_settings/global` |
| Usage | Read `ai_usage_logs` aggregates (counts only) |
| Deployments | List live sites, unpublish abusive ones (admin) |

Every admin write already requires permission + `log_audit`. Keep that.

Course editor must be real: saving a lesson writes `lessons`; saving a quiz writes `quiz_questions` **without** `is_correct` on the public shape and `quiz_answers` server-only (existing contract). Do not leak answers to the client.

### Phase 8 — Production platform features (implement completely if you touch the area)

Prioritize features that already have a foothold in the repo.

**Must implement in this pass**

- Professional responsive UI pass (§5 Phase 3).
- User profile / account (already exists — complete gaps: OAuth-linked providers list, onboarding status).
- Chat history (exists) + **project history**.
- Project/workspace management.
- File explorer + editor + multi-file AI + live preview + autosave + versions + ZIP import/export.
- Website deploy + status + URL + logs + unpublish.
- Google/Facebook auth fixed + email verification + password recovery (already exist — verify they still work).
- Proper onboarding (Phase 2).
- User-specific theme templates + dark/light.
- Notifications: use existing `notifications` collection. Add a bell in the shell with unread count and mark-read RPC. Create notifications for: verification approved/rejected, deploy live/failed, admin course publish is optional.
- Admin analytics / user / course / content / settings / audit (Phase 7).
- Usage limits: keep existing AI rate limits; show remaining daily chat/scan in Settings honestly from server counts. Do not invent paid plans unless you implement a complete, working plan model (if you skip billing, do not add a fake Upgrade button).

**Implement if you can finish the flow entirely**

- Custom domains with DNS verification.
- Project environment variables as described.
- Basic in-editor diagnostics + “Fix with Agent”.
- Accessibility pass (axe-level: labels, contrast on new templates, skip-link already exists).

**Do not fake**

- Real-time collaborative editing
- Full cloud IDE language servers
- Kubernetes / Docker deploy of user backends
- Stripe billing
- Push notifications / native apps
- A theme “marketplace” with third-party uploads (ship a first-party template gallery only)

If a nav item exists, it must work. If you cannot finish a feature, do not add the button.

---

## 6. AI product behavior to add

Update `SYSTEM_PROMPT` / `AGENT_SYSTEM_PROMPT` and the gateway:

- Theme intent → structured UI payload, e.g. message metadata `{ action: "theme_gallery" }`. The model may also answer briefly; the gallery is authoritative.
- Agent in a project: instruct it to emit complete files with the existing `MATRIX_FILE` protocol; mention folder structure; do not claim preview/publish happened.
- When the user says “publish this”, the **UI** starts the deploy workflow; the model must not invent a URL.
- Never request birth certificate images, IDs, OTPs, passwords.

Add classifier tests so “change your theme” / “থিম পরিবর্তন করো” open the gallery.

---

## 7. Security, privacy, and compliance checklist

- [ ] Raw birth-certificate number never stored, logged, exported, or sent to Groq/OpenRouter
- [ ] HMAC pepper only on server; rotate-ready (store `identity_hash_version`)
- [ ] DOB only via `complete_profile` / admin review (already the rule)
- [ ] Published sites cannot read `__session` or call `/api/rpc`
- [ ] Preview and published HTML sandboxed (`sandbox` iframe + CSP)
- [ ] ZIP import: size limit, entry limit, no `..`, no symlinks
- [ ] Admin bootstrap key is env-only and single-use in practice (assignments > 0 disables it)
- [ ] OAuth tokens (GitHub) remain encrypted; unused by publish
- [ ] Rate limits on identity submit, publish, ZIP import, OAuth session mint
- [ ] Firestore rules updated for any new **client-readable** collections; writes still server-only
- [ ] `.env.example` updated; README updated; no secrets committed

---

## 8. Files you will almost certainly create or substantially edit

**Create**

```
src/lib/auth/oauth.ts                         shared popup/redirect/session helper
src/lib/server/identity-number.ts             normalize + HMAC + uniqueness
src/lib/theme-templates.ts                    template tokens
src/components/theme-gallery.tsx              AI + settings gallery
src/lib/server/projects.ts                    project/file/version RPCs
src/lib/server/deploy.ts                      snapshot + activate + logs
src/app/(app)/projects/page.tsx
src/app/(app)/projects/[id]/page.tsx
src/components/projects/file-tree.tsx
src/components/projects/file-editor.tsx
src/components/projects/project-workspace.tsx
src/app/s/[slug]/[[...path]]/route.ts         public static host (or equivalent)
src/app/api/projects/[id]/preview/[[...path]]/route.ts
src/app/api/projects/[id]/zip/route.ts
src/app/(app)/admin/setup/page.tsx
src/components/admin/course-editor.tsx
src/components/notifications-bell.tsx
tests/identity-number.test.ts
tests/oauth-errors.test.ts
tests/theme-intent.test.ts
tests/project-paths.test.ts
tests/deploy-slug.test.ts
```

**Edit**

```
src/components/auth/login-screen.tsx
src/app/(auth)/register/register-form.tsx
src/components/onboarding-client.tsx
src/lib/server/rpc.ts
src/app/api/rpc/route.ts
src/app/api/auth/session/route.ts
src/lib/firebase/session.ts
src/lib/firebase/auth-errors.ts
src/lib/theme.tsx
src/app/globals.css
src/app/layout.tsx
src/components/app-shell.tsx
src/components/chat-client.tsx
src/components/agent-workspace.tsx
src/lib/ai/agent.ts
src/lib/ai/prompts.ts
src/lib/ai/domain.ts
src/lib/ai/pii.ts
src/app/api/ai/route.ts
src/components/admin/courses-admin.tsx
src/components/admin/verification-queue.tsx
src/components/admin/overview-tab.tsx
src/lib/i18n/en.ts
src/lib/i18n/bn.ts
src/lib/routing.ts
src/middleware.ts
src/lib/env.ts
.env.example
README.md
firestore.rules
```

---

## 9. Acceptance criteria

A reviewer should be able to do all of the following on a configured deployment:

### Auth

- [ ] Continue with Google on `/login` and `/register` creates/signs in the Firebase user **and** mints `__session` **and** lands in the correct place.
- [ ] If session mint fails after Auth success, the UI says the session failed (with Retry), never “Google failed”, and Retry does not create another user.
- [ ] Redirect-based OAuth completes on both pages.
- [ ] Facebook follows the same contract.
- [ ] Existing email/password, forgot password, reset password, verify email, TOTP MFA still work.
- [ ] New Google users are asked for remaining info; they are not asked for a password or a birth-certificate photo.

### Onboarding / identity

- [ ] DOB + birth certificate number are required; explanation is visible.
- [ ] Invalid age (10 or 18+) is rejected server-side with the existing codes.
- [ ] Certificate number is not stored in plaintext (inspect Firestore).
- [ ] Duplicate number on another account is rejected.
- [ ] Number never appears in `/api/ai` payloads (redacted if pasted in chat).
- [ ] Admin can approve/reject and the user gets a notification.

### UI

- [ ] Phone / tablet / desktop layouts work for chat, Agent workspace, projects, admin, settings.
- [ ] No overlapping composer vs bottom nav.
- [ ] MATRIX visual identity intact.
- [ ] Empty/loading/error/success states on new surfaces.

### Themes

- [ ] “Change your theme” shows the gallery.
- [ ] Applying a template changes only that account (server-persisted).
- [ ] Logout / other user is unaffected.
- [ ] Dark/light/system still works.

### Agent / projects / preview / publish

- [ ] Agent can create multiple files in folders; they appear in a tree.
- [ ] User can edit a file and see preview update.
- [ ] Opening a project shows the full structure.
- [ ] Single `index.html` previews; multi-file HTML/CSS/JS/images preview.
- [ ] ZIP export downloads the project; ZIP import recreates it.
- [ ] Version restore works.
- [ ] Publish produces a working public URL that serves the site without login.
- [ ] Unpublish removes it.
- [ ] Deploy status + logs are real.
- [ ] GitHub review-before-push still works.

### Admin

- [ ] Bootstrap key can create the first super_admin when none exist.
- [ ] Admin can create a course with a lesson and a quiz; learners can take it; answers are not in the client payload.
- [ ] Admin can manage users (at least role + disable) and review verifications.
- [ ] Sensitive actions are audited.

### Quality bar

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] No new `any` abuse, no `console.log` of tokens/PII
- [ ] No leftover “TODO”, “coming soon”, or disabled primary CTAs
- [ ] README / `.env.example` document `IDENTITY_PEPPER`, `ADMIN_BOOTSTRAP_KEY`, and any new vars

---

## 10. What “done” looks like

MATRIX still feels like MATRIX: calligraphic mark, obsidian UI, honest errors, youth cyber-safety + all-in-one assistant.

It now also behaves like a real product:

- OAuth that finishes.
- Age verification that is proportionate (DOB + number, hashed).
- An admin who can run the school/content side without the Firebase console.
- A theme the user can change by talking to the AI, stored on their account.
- An Agent that can own a folder of files, show a live site, and publish it to a URL.

Work until the acceptance list is true. If a choice conflicts with security or the no-fakes rule, choose the honest, secure version and document it in the README.
