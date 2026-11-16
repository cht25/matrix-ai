# Changelog

Notable changes to QORVYNA. Newest first.

## Google sign-in: domain migration fix + full-page redirect

Google Sign-In was failing on `qorvyna.thamjj13.top` with "We couldn't finish
Google sign-in", even though the domain was listed in Firebase Authorized
domains. Two defects caused it, and both are fixed. See
[docs/AUTH_DOMAIN_MIGRATION.md](docs/AUTH_DOMAIN_MIGRATION.md).

### Authentication

- **Popup replaced by full-page redirect.** `signInWithPopup` /
  `linkWithPopup` are gone from the active flow: sign-in uses
  `signInWithRedirect` + `getRedirectResult`, linking uses `linkWithRedirect`.
  This is what Firebase recommends for environments where popups fail (mobile
  Chrome, iOS, in-app browsers, COOP/partitioned storage).
- **Redirect results are consumed exactly once per page load** (memoised), so a
  returning redirect can never mint two sessions or navigate twice. A new
  "Finishing sign-in…" state covers the return trip and a "Redirecting to
  Google…" state covers the departure; stale attempts expire after 10 minutes
  so a spinner can never hang.
- **The intended destination survives the round trip** (`?next=` plus a
  sessionStorage hint across reloads), and post-login navigation uses
  `location.replace()` so the redirect URL cannot stay in history.
- **Session failures are no longer reported as Google failures.** A 403 from
  the session endpoint (rejected Origin) used to surface as the generic
  "couldn't finish Google sign-in" message; it now says the domain is not
  allowed to create the session and names the setting to fix.
- **`authDomain` is resolved by one shared, unit-tested module**
  (`src/lib/firebase/web-config.ts`) instead of a silent rewrite duplicated in
  the client and the server. Default stays `<projectId>.firebaseapp.com`; a
  custom hostname is honoured and activates a new `/__/auth/*` reverse proxy to
  the project's real Firebase auth handler. `src/lib/env.ts` and
  `src/lib/env-public.ts` now share that resolver.
- **New `QORVYNA_ALLOWED_ORIGINS`** (comma-separated exact origins) lets a
  deployment keep the previous domain or a `www` host inside the session
  allowlist during a migration. The 403 body now lists the allowed origins.
- **Safe diagnostics.** `[QORVYNA auth]` logs the stage, provider, Firebase
  error code, message and Identity Toolkit detail together with the hostname and
  the resolved `authDomain`. Errors are read through a field allowlist, so
  credentials, ID tokens and passwords cannot reach the log.
- No user ids, profiles, account links or email/password flows were changed.

### Domain

- Production defaults moved from `matrix.thamjj13.top` to
  `qorvyna.thamjj13.top` in `src/lib/seo.ts`, `render.yaml`,
  `apphosting.yaml`, `.env.example`, the Tauri config and the Android app
  config.

## QORVYNA — 2026-11-16

The product is renamed from MATRIX to **QORVYNA**, the assistant tells the
truth about itself, and requests for real work are executed instead of
described. No data migration is needed; existing deployments, accounts,
installed apps and published sites keep working. See
[docs/REBRAND_MIGRATION.md](docs/REBRAND_MIGRATION.md).

### Brand

- New name, tagline ("ONE INTELLIGENCE. INFINITE POSSIBILITIES.") and logo on
  the web app, the Android and Wear OS apps and the desktop app: titles,
  metadata, web manifest, favicons, app icons, splash colours, link preview,
  e-mail templates, PDF exports and interface copy in English and Bangla.
- One source for the brand (`src/lib/brand.ts`) and one generator for all
  artwork (`npm run brand:assets`, from `scripts/brand/geometry.mjs`).
- New palette taken from the logo: navy ground, blue primary, cyan-to-violet
  gradient. The animated "rain" background is replaced by a static glow whose
  strength is a setting.
- Accent and danger colours are split into a text colour and a fill colour, so
  filled buttons meet contrast in both themes (they did not in the dark theme).

### Assistant identity

- The assistant identifies as **QORVYNA AI** in every mode and language.
- Asked which model or provider powers it, it answers from the routing the
  request really used — no hard-coded or invented value — and says QORVYNA did
  not create the underlying model.
- Standalone identity questions are answered by the gateway itself, without a
  model call. The identity is also part of every system prompt.

### Execution

- "Update my project", "Change the design", "Add this feature", "Remove this
  component", "Modify the backend", "Improve the application", "Rebrand the
  platform" and "Deploy it" are recognised as work on a project, in English,
  Bangla and Banglish.
- In Agent mode they run through the build pipeline. In a chat mode nothing is
  sent to the model: the request waits on an **Awaiting approval** card with
  *Run with Agent* and *Answer in chat instead*.
- The gateway's `AGENT_RUNTIME_REQUIRED` answer now starts the pipeline in the
  browser instead of ending as an error.
- Every task ends in a stated outcome derived from the run record: Completed,
  Failed, Blocked or Awaiting approval. A blocked task names the obstacle and
  the next step and offers no pointless retry.
- A chat reply that claims project work with no run behind it is labelled
  "Text only" with a button to run the request for real.

### Design

- Fixed the cascade between the hand-written styles and Tailwind. Element
  resets and the defaults of shared primitives (card, field, button, chip,
  eyebrow) now sit in Tailwind's `base` / `components` layers, so utilities
  written in the markup take effect. Previously they were silently overridden:
  paragraph margins, heading sizes and colours, link colours and underlines,
  state colours on chips and cards, and padding on fields and cards.
- Consistent type scale (page title 28 px, section or card title 17 px,
  sub-heading 15 px).
- The chat welcome screen fits the space it has on any screen instead of
  opening scrolled past its own logo on phones and short windows.
- A finished Agent run is shown once: reply, run card, one line of facts. The
  same message is no longer repeated in three places.
- Browser `confirm()` / `prompt()` dialogs are replaced by accessible in-app
  dialogs everywhere, including the password prompt for account deletion.
- Smaller fixes: sign-up page had two headings saying the same thing; buttons
  nested inside links; buttons missing their base class; a search field whose
  icon overlapped its text; the top bar's mixed icon-button styles; the status
  label cut mid-letter on narrow phones.

### Compatibility

- Settings that carried the old name are read under both names
  (`QORVYNA_<NAME>`, then `MATRIX_<NAME>`).
- Agent file blocks are parsed in both the new and the old form.
- Published sites get `window.MATRIX_ENV` as an alias of `window.QORVYNA_ENV`.
- Identifiers whose change would break data or installs are kept: hosts,
  application IDs, browser storage keys, wire formats, certificate IDs.

### Developer tooling

- `/dev-preview/app`: the real application frame and security overview with
  sample data, plus the shared interface primitives in one place.
- `/dev-preview/chat`: new scenarios for identity questions, the approval card
  and runs that end completed, failed and blocked.
- New test suites: `tests/ai-identity.test.ts`,
  `tests/execution-routing.test.ts`, `tests/rebrand-compat.test.ts`.

### Android and Wear OS

- Launcher icons, app labels, splash colour and in-app colours follow the new
  brand. The Wear OS project gains the launcher icons and theme resources its
  manifest already referenced.
- Build settings are read as `QORVYNA_API_BASE`, `QORVYNA_APP_VERSION` and
  `QORVYNA_APP_BUILD`, with the `MATRIX_` names as fallback.
