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

## 3. Model: GPT OSS 120B only

> Supersedes the multi-provider routing and fallback that first shipped with
> this overhaul. See `docs/SINGLE_MODEL.md` for the full description.

MATRIX runs on one language model, GPT OSS 120B (`openai/gpt-oss-120b` on
Groq). The ID is defined once in `src/lib/ai/model.ts`; `src/lib/ai/config.ts`
builds the single server-side route. There is no model selector, no ranking and
no fallback. A transient failure is retried once on the same model; after that
the real provider error is shown with Retry, the user's message is kept, and a
build writes no files.

## 4. Voice input

- The microphone is in the composer in **every** mode, including Agent.
- Stopping a recording puts the transcript in the text box for editing. It is
  **not** sent until the user presses Send.
- Language selector (auto-detect + 16 languages incl. Bangla, English, Hindi,
  Arabic, Urdu), remembered per browser. Right-to-left text is handled.
- Live transcript while speaking when the browser supports it and a language
  is chosen; the recording is always kept so the server can transcribe if the
  browser cannot.
- Server transcription: Groq Whisper → OpenAI, first that works. The
  transcript is then sent to GPT OSS 120B as text.
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
| `GROQ_API_KEY` | GPT OSS 120B (the only language model) and Whisper speech-to-text |
| `GPT_OSS_API_KEY` + `GPT_OSS_BASE_URL` | Optional dedicated endpoint for the same model, used instead of Groq |
| `GROQ_AUDIO_MODEL`, `OPENAI_API_KEY`, `OPENAI_AUDIO_MODEL` | Speech-to-text only |
| `TOGETHER_API_KEY` | Image generation service |

## 7. What was and was not verified

Verified here: type-check, the full unit/integration suite, and a production
build. Design variety, revision behaviour, error classification, the
transcription route and the single-model guarantees (`tests/single-model.test.ts`)
are covered by tests using local stubs.

Not verified here: calls to the real Groq API (no keys in the development
sandbox), and in-browser behaviour (microphone, live recognition, streaming,
responsive layouts). These need a check on a deployed environment with real
keys.
