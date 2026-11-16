# Google sign-in after the domain migration — root cause and fix

**Applies to:** `qorvyna.thamjj13.top` (was `matrix.thamjj13.top`)
**Covers:** the "We couldn't finish Google sign-in" failure, and the switch from
popup to a full-page redirect flow.

---

## 1. What the authentication code actually is

| Item | Value / location |
| --- | --- |
| Firebase project id | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (no project id is committed to this repository; `.firebaserc` ships the placeholder `YOUR_FIREBASE_PROJECT_ID`) |
| Firebase Web SDK | `firebase` **^12.17.1** (modular v9+ API) |
| Web config (browser) | `src/lib/firebase/web-config.ts` → re-exported by `src/lib/env-public.ts`, consumed by `src/lib/firebase/client.ts` |
| Web config (server) | same resolver, via `src/lib/env.ts` (`env.firebasePublic`) |
| `authDomain` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, resolved by `web-config.ts` (see §3) |
| Google OAuth client id | **not configured in the app.** The client SDK uses the Google provider registered in Firebase Authentication, which uses the project's auto-created *Web client* in Google Cloud. There is no `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and no client secret in this repository — never add one to the browser bundle. |
| Transport (before) | `signInWithPopup`, with `signInWithRedirect` only as a fallback when the popup was blocked |
| Transport (after) | `signInWithRedirect` **only** — popups removed from the active flow |
| Auth architecture | Firebase Authentication **directly in the browser**, plus a first-party session exchange: the browser POSTs the Firebase ID token to `POST /api/auth/session`, the route verifies it with the Admin SDK and sets the httpOnly `__session` cookie (5 days) used by SSR, middleware and every API route. There is no third-party OAuth callback and no custom OAuth handler. |
| Auth environment variables | `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_APP_URL`, `QORVYNA_ALLOWED_ORIGINS` (new, optional), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `QORVYNA_TRUST_PROXY_HEADERS` |
| Old production domain | `https://matrix.thamjj13.top` |
| New production domain | `https://qorvyna.thamjj13.top` |
| Hosting | **Not Firebase Hosting.** A Next.js server (`next start`) on Render / Firebase App Hosting / any Node host, usually behind Cloudflare. `firebase.json` only configures Firestore rules/indexes. |

### Hardcoded old-domain references found

`src/lib/seo.ts` (`PRODUCTION_ORIGIN`, `PRODUCTION_CHAT_URL`), `render.yaml`,
`apphosting.yaml`, `.env.example`, `src-tauri/tauri.conf.json`,
`mobile/matrix_app/lib/config.dart` (+ its test), the phone-release fallbacks in
`src/components/devices/devices-client.tsx`,
`src/components/admin/app-release-settings.tsx`, `src/lib/server/app-updates.ts`,
and `src/lib/deploy/format.ts`. All production defaults now point at
`qorvyna.thamjj13.top`. Historical/audit documents
(`REPOSITORY_AUDIT.md`, `docs/VERIFICATION.md`, `docs/GITHUB_OAUTH_PRODUCTION_CALLBACK.md`,
`README.md`) are left as written records; treat this file as the current truth.

---

## 2. Root cause

Two independent defects combined into one unhelpful sentence.

### 2.1 The redirect/popup step could not identify the right auth handler

`authDomain` is *not* "the website domain". It is the origin that serves
Firebase's own auth helper (`/__/auth/handler`). The old code rewrote it
silently:

```ts
// before — src/lib/env-public.ts and src/lib/env.ts (duplicated)
if (raw.endsWith(".firebaseapp.com") || raw.endsWith(".web.app")) return raw;
return projectId ? `${projectId}.firebaseapp.com` : raw;
```

Consequences after the domain change:

- A deliberately configured custom `authDomain` (what most migration guides
  tell you to set) was **discarded without a word**, and — worse — a value with
  a scheme (`https://…`) did not even match the `endsWith` test, so the app
  quietly used a different origin than the operator believed.
- The decision was duplicated in two files, so client and server could drift.
- Nothing ever checked that a custom `authDomain` is actually served by this
  deployment. Pointing `authDomain` at a Next.js host without a reverse proxy
  produces exactly the reported dead end: the browser leaves the site, and the
  URL it lands on is not a Firebase auth handler.

### 2.2 A session failure was reported as a Google failure

After a successful Google sign-in the browser calls `POST /api/auth/session`.
That route is behind the CSRF origin check in
`src/lib/server/request-security.ts`, whose allowlist was
`request.url` **or** `NEXT_PUBLIC_APP_URL`. On a new domain, with
`NEXT_PUBLIC_APP_URL` still pointing at `matrix.thamjj13.top` (it did — see
`render.yaml`/`apphosting.yaml`), or with a proxy that rewrites `Host`, that
request answers **403 `BAD_ORIGIN`**.

The client then did this:

```ts
// before — src/lib/auth/oauth.ts
if (isSessionFailure(err)) return { status: "session-failed", ... };
function isSessionFailure(err) {
  // only 5xx / SESSION_MINT_FAILED
}
```

A 403 was therefore *not* a session failure, so `describeAuthFailure()` fell
through to its last line:

```
We couldn't finish Google sign-in. Please try again or use email instead.
```

That is exactly the message in the bug report. Google had already succeeded;
the user was told Google failed, and the actual cause (a 403 from the origin
allowlist) was invisible because the response body was parsed for a string
`error` while the route returns `{ error: { code, message } }`.

### 2.3 Why it is not simply "add the domain to Authorized domains"

Firebase's *Authorized domains* list controls which origins may start a
sign-in. It does not control (a) which origin serves the auth helper, (b) the
Google Cloud OAuth client's authorized JavaScript origins, (c) this
deployment's own session-cookie origin allowlist, or (d) the canonical origin
the app believes it is served from. All four are separate, and (c)/(d) were
wrong in this repository.

---

## 3. What changed in the code

### `src/lib/firebase/web-config.ts` (new — one resolver for client and server)

`authDomain` rules, no silent replacement:

1. unset / unusable → `<projectId>.firebaseapp.com` (always authorized, served
   by Google, correct for this hosting model);
2. `*.firebaseapp.com` / `*.web.app` → used verbatim;
3. any other hostname → used verbatim **and** `sameOriginAuthHandler = true`,
   which is what activates the `/__/auth` reverse proxy below. A warning is
   recorded when that host does not equal `NEXT_PUBLIC_APP_URL`, because then
   the browser would leave the site and still not find a handler;
4. a pasted scheme/port/path is reduced to the hostname with a warning.

It also warns about a placeholder-looking API key or project id. Warnings are
non-secret and logged once per server process (`[QORVYNA] Firebase config: …`).

### `src/app/api/auth/firebase-handler/[[...path]]/route.ts` (new) + `next.config.ts` rewrite

A reverse proxy for Firebase's documented "custom domain" setup: `/__/auth/*`
→ `https://<projectId>.firebaseapp.com/__/auth/*` (GET/HEAD/POST, hop-by-hop
headers stripped, `set-cookie` preserved, 15 s timeout, 502 on upstream
failure). Public URL is `/__/auth/*` via a `next.config.ts` rewrite, because
Next treats route folders starting with `_` as private. **Inert** unless
`authDomain` is a custom hostname — with the default `*.firebaseapp.com`
authDomain it answers 404 and nothing requests it. `/__/auth` was added to
`PUBLIC_PATHS` so the middleware does not bounce the auth helper to `/login`.

### `src/lib/auth/oauth.ts` (rewritten transport)

- `startOAuthSignIn()` → `signInWithRedirect()`; `signInWithPopup` and
  `linkWithPopup` are gone from the active flow (a unit test asserts it).
- `consumeOAuthRedirect()` → `getRedirectResult()` **once per page load**
  (memoised promise). Concurrent callers (login screen, register screen,
  `/verify`, the app shell) share the same result, so a redirect can never be
  minted twice.
- Redirect result handling: `null`/`auth/no-auth-event` → nothing to do;
  user cancellations → `cancelled` (no scary error); account-exists → "sign in
  with email and password, then link it in Settings"; blocked storage and
  in-app-browser cases get their own copy.
- Any failure after the credential arrives is reported as `session-failed`
  (including 403), with a specific message for `BAD_ORIGIN` naming
  `NEXT_PUBLIC_APP_URL` / `QORVYNA_ALLOWED_ORIGINS`.
- Intended destination survives the round trip and reloads:
  `rememberPostLoginPath()` / `postAuthPath()` (10-minute freshness, same-origin
  paths only). The login screen navigates with `location.replace()` so the
  redirect URL cannot stay in history and look like a loop.
- Stale markers (>10 min) are discarded, so an abandoned attempt can never
  leave a permanent spinner. Nothing loops: a completed link redirect clears
  its marker before reloading.
- Linking uses `linkWithRedirect()` with a pending-link marker. If the browser
  comes back *signed in* instead of linked, the code refuses to treat that as a
  successful link and signs the session out rather than attaching someone
  else's Google account.

### `src/lib/auth/diagnostics.ts` (new)

Structured, redacted diagnostics: stage, method, provider, Firebase error code,
message, `status`, Identity Toolkit `errorMessage`, current hostname/origin,
`authDomain` + its source, project id, secure-context flag, redirect status.
Errors are read through an allowlist of fields — never spread or stringified —
so `credential`, `idToken`, `accessToken`, `refreshToken` and passwords cannot
reach a log line (a test asserts this). Production logs one compact line;
`next dev` logs the full (still redacted) object.

### `src/lib/server/request-security.ts`

Allowed origins are now: the request's own origin, `NEXT_PUBLIC_APP_URL`,
`QORVYNA_ALLOWED_ORIGINS` / `MATRIX_ALLOWED_ORIGINS` (exact origins,
comma-separated), and `X-Forwarded-Host/-Proto` only when
`QORVYNA_TRUST_PROXY_HEADERS=true`. Malformed entries are ignored and never
widen the list. The 403 body now carries `BAD_ORIGIN` plus the allowed origins,
which is what makes the next occurrence self-diagnosing.

### Client `/api/auth/session` handling

`mintSessionCookie()` reads both `{ error: "CODE" }` and
`{ error: { code, message } }`, so a 403 keeps its real code (`BAD_ORIGIN`) and
its explanation instead of degrading to `SESSION_MINT_FAILED`. The route now
returns the standard envelope with operator hints.

### UI

`src/components/auth/login-screen.tsx`, `src/app/(auth)/register/register-form.tsx`:
"Finishing sign-in…" state while the redirect result is consumed, "Redirecting
to Google…" state for the moment before the browser leaves, buttons disabled
while a redirect is in flight. `src/components/auth/auth-redirect-watcher.tsx`
(mounted in the app shell) resumes a link redirect on `/settings`.
`src/app/verify/page.tsx` now uses the shared consumer instead of calling
`getRedirectResult()` itself.

### Domain defaults

`src/lib/seo.ts`, `render.yaml`, `apphosting.yaml`, `.env.example`,
`src-tauri/tauri.conf.json`, `mobile/matrix_app/lib/config.dart` → the new
production origin.

---

## 4. Configuration the owner must apply

### Firebase console (project `NEXT_PUBLIC_FIREBASE_PROJECT_ID`)

1. **Authentication → Settings → Authorized domains**: must contain
   `qorvyna.thamjj13.top` (and `www.qorvyna.thamjj13.top` if you serve it),
   **plus** `<projectId>.firebaseapp.com` (never remove it — the auth handler
   lives there). `localhost` stays for development.
2. **Authentication → Sign-in method → Google**: enabled, *Web client*
   selected, support email set. The client id and secret must be the pair from
   the same Google Cloud OAuth client — do not paste a secret from a different
   client. If in doubt, follow Firebase's documented procedure: disable Google,
   save, re-enable, re-save, then reopen and confirm the id is unchanged.
3. **Authentication → Sign-in method → Email/Password**: still enabled (it is
   untouched by this change).
4. Leave **Email enumeration protection** / "one account per email" as they
   are; the code handles `account-exists-with-different-credential` either way.

### Google Cloud console (APIs & Services → Credentials)

Open the **Web client** whose client id appears in Firebase → Google provider
(it is named "Web client (auto created by Google Service)"). Do **not** create a
second one.

- **Authorized JavaScript origins**: `https://qorvyna.thamjj13.top`, plus
  `https://www.qorvyna.thamjj13.top` if used. Keep `https://matrix.thamjj13.top`
  while the old domain still redirects. Remove nothing else that is in use.
- **Authorized redirect URIs**: `https://<projectId>.firebaseapp.com/__/auth/handler`
  (this is the only redirect URI Firebase needs). Remove any URI that points at
  `https://matrix.thamjj13.top/__/auth/handler` — that handler never existed on
  the old domain either.
- No new OAuth client, no client-secret change, no re-consent.

### Host / deployment environment (Render, App Hosting or wherever `next start` runs)

Required:

```bash
NEXT_PUBLIC_APP_URL=https://qorvyna.thamjj13.top      # canonical origin; also the session-origin allowlist
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<your project id>
NEXT_PUBLIC_FIREBASE_API_KEY=<same project's web API key>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<projectId>.firebaseapp.com   # keep this
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<…>
NEXT_PUBLIC_FIREBASE_APP_ID=<…>
FIREBASE_CLIENT_EMAIL=<service account email>
FIREBASE_PRIVATE_KEY=<service account key>
```

Optional, only while the old domain still serves the app:

```bash
QORVYNA_ALLOWED_ORIGINS=https://www.qorvyna.thamjj13.top,https://matrix.thamjj13.top
```

Behind a TLS-terminating proxy that **overwrites** `X-Forwarded-Host`/
`X-Forwarded-Proto`, also set `QORVYNA_TRUST_PROXY_HEADERS=true`.

`NEXT_PUBLIC_*` values are compiled into the browser bundle: **rebuild and
redeploy**, an env change alone is not enough.

Hosting checks:

- HTTPS on the new host (redirect OAuth requires it; `localhost` also works).
- One canonical host: redirect `www` → apex *or* list both origins as above;
  never serve the app on two hosts that both try to finish a redirect.
- `/__/auth/*` must not be intercepted by a Cloudflare rule/WAF. With the
  default `authDomain` nothing uses it; with a custom `authDomain` it is the
  handler.
- Do not add a `frame-ancestors`/X-Frame-Options rule that blocks
  `https://<projectId>.firebaseapp.com` from embedding nothing — the popup is
  gone, so the only requirement is that the top-level navigation to the
  authDomain is allowed.

---

## 5. Verification

### Automated (ran in this change)

```
npm ci
npx tsc --noEmit              # clean
npx vitest run                # 103 files, 1212 tests, all passing
npx next build                # clean production build
```

New tests: `tests/auth-web-config.test.ts` (authDomain rules, proxy target),
`tests/oauth-redirect.test.ts` (redirect-only transport, one-shot consumption,
session-vs-Google failure separation, link safety, destination preservation),
`tests/auth-session-origin.test.ts` (origin allowlist, `BAD_ORIGIN` propagation,
log redaction).

Real Chromium checks against a running dev server (headless Chromium via
`playwright-core`):

| Check | Result |
| --- | --- |
| `/login` renders the email/password form and the Google button | pass |
| No spinner flash on a clean visit | pass |
| Clicking **Google** opens **no popup**; `signInWithRedirect` is called | pass (0 popups, `redirect-start` logged once) |
| `getRedirectResult` runs once on mount and clears the pending marker | pass |
| `/register`, `/verify`, `/forgot-password` render with no JS errors | pass |
| `/__/auth/handler` with default (`*.firebaseapp.com`) authDomain | 404, inert — no behaviour change |
| `/__/auth/handler` with a custom authDomain | proxy route reached (forwards to `<projectId>.firebaseapp.com`) |

### Not verified here — must be done on production

This environment cannot reach `identitytoolkit.googleapis.com`,
`accounts.google.com` or `<projectId>.firebaseapp.com`, and no Firebase
credentials, project access or Google account exist in it. **A real Google
round trip therefore has not been performed.** Do not consider the fix
confirmed until the following pass on `https://qorvyna.thamjj13.top`:

1. Google sign-in with an **existing** Google account → lands on `/chat`, same
   uid/profile as before (`__session` cookie present, httpOnly).
2. Google sign-in with a **new** Google account → one profile document, no
   duplicate Firestore user.
3. Visiting `/login?next=/devices` then signing in with Google → ends on
   `/devices`.
4. Browser **refresh** after sign-in → still signed in (no bounce to `/login`).
5. **Logout**, then sign in again with Google → works, no redirect loop.
6. Email/password login, registration, password recovery → unchanged.
7. `www.qorvyna.thamjj13.top` (if used) → sign-in works there as well.
8. Mobile Chrome (and the Android in-app browser, if shipped) → redirect flow
   completes without the "in-app browser" message.
9. Cancel at the Google screen → returns to `/login` with the form (no error
   banner, no spinner stuck).
10. Failed attempt → browser console shows `[QORVYNA auth] redirect-result …`
    with a real error code. **That line is the diagnostic you need; it never
    contains tokens or secrets.**

If step 1 fails, read the console code first:

| Code | Meaning / fix |
| --- | --- |
| `auth/unauthorized-domain` | add the host in Firebase → Authentication → Settings → Authorized domains |
| `auth/operation-not-allowed` | Google provider disabled, or the API key belongs to another project |
| `auth/configuration-not-found` / `auth/api-key-not-valid` | `NEXT_PUBLIC_FIREBASE_API_KEY` is not this project's key |
| `auth/network-request-failed` | client cannot reach `identitytoolkit.googleapis.com` / `accounts.google.com` (ad-blocker, firewall, in-app browser) |
| `auth/account-exists-with-different-credential` | email already registered with a password — sign in with the password, then link Google in Settings |
| `BAD_ORIGIN` (403) | the session endpoint rejected this origin: set `NEXT_PUBLIC_APP_URL`/`QORVYNA_ALLOWED_ORIGINS` and redeploy |
| `SESSION_MINT_FAILED` (500) | `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` missing or wrong on the host |

---

## 6. What was intentionally not changed

- No user ids, profiles, Firestore documents, custom claims or account links
  are touched. Sign-in remains the same Firebase user; the session exchange is
  idempotent (`ensureUserDocuments` only fills in missing fields).
- Email/password, password recovery, MFA and email verification are unchanged.
- `authDomain` is **not** blindly replaced by the website domain. The default
  stays `<projectId>.firebaseapp.com`; the same-origin option is available and
  supported, but only with the reverse proxy this change adds.
- No mock or fallback authentication was introduced anywhere.
