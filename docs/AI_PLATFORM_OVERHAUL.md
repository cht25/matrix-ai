# AI platform overhaul: design variety, revisions, model fallback, voice, streaming

This document records what was wrong, what changed, and how to operate it.

## 1. Websites all looked the same

**Cause.** There was no design step. The Agent prompt carried one generic set
of site instructions, generation ran at low temperature, and nothing analysed
the brief (industry, audience, tone), so every model converged on the same
layout and palette. The build prompt also asked for "plain HTML, CSS and
JavaScript" and gave no Tailwind guidance.

**Fix.** `src/lib/design/site-spec.ts` builds a *Design Specification* before
any code is written: purpose, industry, audience, direction, palette,
typography, layout, navigation, components, pages, imagery, responsive rules,
animation and accessibility. It is seeded per project (same project → stable,
new project → different), honours every colour / font / mode / page the user
names, and repairs palettes to WCAG AA contrast. The model may refine it
(`designPlanPrompt` → `mergeModelDesignSpec`); invalid refinements are dropped.
The spec is stored on the project (`design_spec`, `design_brief`) and injected
into generation as concrete Tailwind tokens (Tailwind Play CDN; the published
and preview routes' CSP already allow it).

## 2. Redesign / revision requests did nothing

**Causes.** Edit mode told the model not to redesign; large files were silently
left out of context while the model was told not to touch them; the auto-fix
pass sent no file contents; nothing checked that files actually changed, so
"done" was reported for a no-op.

**Fix.** `classifyDesignRevision` decides what a request changes (full
redesign, palette, typography, navigation, hero, mobile, layout, add page, or
none) and `reviseDesignSpec` changes exactly those parts. The pipeline
(`src/lib/server/build.ts`) sends real file contents (limits raised), applies
only files whose content differs, retries once when nothing changed, and then
stops with `NO_CHANGES_MADE` / `DESIGN_UNCHANGED` instead of claiming success.
The project is left untouched in that case. "Files changed" comes from the
stored diff.

`src/lib/deploy/design-quality.ts` adds a static design check (viewport,
responsive breakpoints, navigation, hierarchy, missing pages, empty page). It
is static analysis only — it does not render the page in a browser.

## 3. Model routing

Agent order: **GLM → Gemini → GPT OSS 120B**, then anything else configured.
Normal chat keeps GPT OSS 120B first. A model the user selected always leads
the chain and still falls back.

- Authentication, billing and "model not found" errors now advance to the next
  provider (previously they stopped the run).
- After an account-level failure, other models on the same account are skipped.
- Failing models are cooled down (10 min auth/billing/missing model, 60 s
  timeout, 30 s rate limit) and promoted again afterwards.
- A reply that has already started streaming is never spliced with another
  model's output.
- The UI shows which model answered and when a fallback happened
  (`run.model`, message metadata, **Models → routing order**).

### GLM

Failure causes found: a hard-coded, unverified default ID (`glm-5-turbo`);
Z.ai keys placed in `GLM_API_KEY` were sent to the mainland endpoint (401);
numeric business codes (1113 no balance, 1211 model missing, …) were not
understood; catalogue discovery fell back to a static list.

Now: `ZAI_API_KEY` or `GLM_API_KEY` both work; the gateway (Z.ai, Z.ai Coding
Plan, BigModel) is discovered automatically unless `GLM_BASE_URL` is set; the
model list comes from the account's own catalogue; numeric codes are mapped to
their real meaning in diagnostics.

### Gemini

Failure causes found: `GEMINI_MODEL` defaulted to empty so the route was
dropped; no catalogue discovery; consecutive same-role turns, empty parts and
missing thought signatures caused 400s; thinking tokens used up the output
budget and produced empty replies.

Now: only `GEMINI_API_KEY` is required; models are picked from the live
catalogue; history is normalised; thought signatures are replayed; the output
budget accounts for thinking.

## 4. Voice input

- The microphone is in the composer in **every** mode, including Agent.
- Stopping a recording puts the transcript in the text box for editing. It is
  **not** sent until the user presses Send.
- Language selector (auto-detect + 16 languages incl. Bangla, English, Hindi,
  Arabic, Urdu), remembered per browser. Right-to-left text is handled.
- Live transcript while speaking when the browser supports it and a language
  is chosen; the recording is always kept so the server can transcribe if the
  browser cannot.
- Server transcription: Groq Whisper → OpenAI → Gemini, first that works.
  Audio storage (Cloudinary) is no longer required for dictation.
- Re-transcribe in another language, record more (appends), or discard.

## 5. Streaming

- Streamed text lives in a small external store (`src/lib/stream-store.ts`);
  only `StreamingReply` re-renders per frame, not the whole chat screen.
- Markdown blocks are memoised by content, so finished paragraphs and code
  blocks are not re-rendered or re-highlighted while later text arrives.
- Unfinished inline markers (`**bold`, `` `code ``, `[link](`) are closed
  provisionally so raw symbols do not flash.
- The live bubble and the saved message share the same box, and the saved
  message does not replay its entry animation, so nothing jumps on completion.

## 6. Configuration

| Variable | Purpose |
| --- | --- |
| `ZAI_API_KEY` or `GLM_API_KEY` | GLM (Agent primary) |
| `GLM_BASE_URL` | Optional; skips gateway auto-discovery |
| `GEMINI_API_KEY` | Gemini (Agent fallback, speech fallback) |
| `GROQ_API_KEY` | GPT OSS 120B (chat default, Agent fallback) and Whisper |
| `GEMINI_MODEL`, `GEMINI_CODING_MODEL`, `GLM_MODEL`, … | Optional pins; leave blank to use the catalogue |

## 7. What was and was not verified

Verified here: type-check, the full unit/integration suite, and a production
build. Fallback, error classification, design variety, revision behaviour and
the transcription route are covered by tests using local stubs.

Not verified here: calls to the real GLM, Gemini, Groq or OpenAI APIs (no keys
in the development sandbox), and in-browser behaviour (microphone, live
recognition, streaming, responsive layouts). These need a check on a deployed
environment with real keys.
