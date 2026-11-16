# Changelog

Notable changes to QORVYNA. Newest first.

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
