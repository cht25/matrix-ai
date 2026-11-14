# MATRIX AI runs on GPT OSS 120B only

## The model

| | |
| --- | --- |
| Model | GPT OSS 120B |
| Provider | Groq (`https://api.groq.com/openai/v1`) |
| Model ID | `openai/gpt-oss-120b` |
| Credential | `GROQ_API_KEY` (server-side only) |

This is the ID the existing integration already used. Nothing about the
endpoint changed.

## Where it is configured

- `src/lib/ai/model.ts` — the only file that spells the model ID. Browser-safe
  constants: ID, label, provider, capabilities.
- `src/lib/ai/config.ts` — server-only. `matrixModelRoute()` builds the single
  route; `createAIRoutes`, `createAIRoutesFromDb` and `resolveExecutionRoutes`
  all return that one route (or none when no key is set).
- `src/lib/ai/executor.ts` — `completeWithModel` / `streamWithModel`. They
  refuse to run with more than one route or with any other model ID.

Optional: `GPT_OSS_API_KEY` + `GPT_OSS_BASE_URL` serve the same model from a
dedicated OpenAI-compatible endpoint. It replaces the Groq route; it is never
a second attempt. `GPT_OSS_MODEL` may only spell `gpt-oss-120b` with or without
the `openai/` prefix; anything else is ignored.

Old overrides (`GROQ_CHAT_MODEL`, `GROQ_CODING_MODEL`, `GROQ_FAST_MODEL`) are
ignored with a startup warning. Saved per-user model preferences and the
admin-saved provider records are no longer read. They were not deleted.

## What uses it

Everything that generates text: chat in every mode (General, Study, Code,
Health, Research, Creative, Orchestrator), Agent mode and its tools, and every
stage of the build pipeline — design specification, file generation,
continuation, repair, polish and the post-build fix pass — for both new
projects and edits. MATRIX has no separately-named agent classes; "Website
Builder", "Coding", "Design", "Debugging", "Project Management", "Deployment"
and "Research" work are these modes and pipeline stages, which differ only in
system prompt and tools.

The "lane" and "strategy" controls (Auto / Fast / Balanced / Reasoning /
Coding) change instructions and limits, not the model.

## Failure behaviour

A transient failure (rate limit, 5xx, timeout, network, empty reply) is
retried once on the same model. Then the real error is returned:

- the chat shows a specific provider error with Retry; the user's message
  stays in the conversation;
- a stream that has already produced text is not restarted — the partial text
  is kept and the error is shown;
- a build stops with `AI_PROVIDER_FAILED` (or `AI_NOT_CONFIGURED`), writes no
  files, and leaves the project as it was.

No reply is fabricated and no other model is tried.

## What was removed

- Provider clients: GLM / Z.ai, Gemini, Anthropic, OpenRouter (and the Ollama
  and generic OpenAI chat routes that lived in the provider registry).
- The provider registry, managed-provider store, runtime admin provider
  config, capability ranking, fallback chains and per-user model preferences.
- RPC actions `model_preference_set`, `admin_ai_provider_*`,
  `admin_ai_managed_provider*`; the admin "Providers & models" screens.
- The model selector. `/models` and `/api/models` are a read-only status of
  the one model.
- GLM CogView image generation, GLM and Gemini text-to-speech, Gemini
  speech-to-text.
- Environment variables `GLM_*`, `ZAI_API_KEY`, `GEMINI_*`, `OPENROUTER_*`,
  `ANTHROPIC_*`, `OLLAMA_*`, `GROQ_CHAT_MODEL`, `GROQ_CODING_MODEL`,
  `GROQ_VISION_MODEL` from `.env.example`, `render.yaml`, `apphosting.yaml`.

## Consequences to know about

- **No image understanding.** GPT OSS 120B is text-only. Attaching an image
  in chat, the Agent image reference and the screenshot scanner now answer
  `VISION_NOT_SUPPORTED` and explain it. Previously these used GLM or Gemini
  vision.
- **Speech** is a separate service, not a language model. Voice input is
  transcribed by Whisper on Groq (same key), then OpenAI if `OPENAI_API_KEY`
  is set; the transcript goes to GPT OSS 120B as text. Read-aloud uses the
  browser voice unless an OpenAI-compatible speech endpoint is configured.
- **Image generation** is a separate media service (Together AI). A saved
  GLM image configuration is ignored.
- Messages produced by other models before this change keep their original
  provider label in chat history.

## Tests

`tests/single-model.test.ts` runs the real gateway route, the real build
pipeline and the real provider client against a local HTTP server and
intercepts every outbound request, with credentials for all removed providers
left in the environment.
