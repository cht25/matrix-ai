# Collaborative model pool

MATRIX can use several models on one request. This replaces the
"GPT OSS 120B only" rule described in `SINGLE_MODEL.md`; GPT OSS 120B remains
the default and the preferred coordinator.

## Which models

Defined in `src/lib/ai/models/registry.ts` (all served by Groq with
`GROQ_API_KEY`): GPT OSS 120B (default), Llama 3.3 70B, Qwen3 32B,
GPT OSS 20B, Llama 3.1 8B.

A model is used only when a credential exists **and** the provider's live model
list contains it. Otherwise it is shown as not configured / not offered /
unverified with the reason, and is never scheduled. If the model list cannot be
read, only the default model is used. Nothing in the UI claims a model that is
not actually reachable.

## Choosing models

- Settings → Models, or the picker in the chat composer.
- Auto = every available model; otherwise up to 4 chosen models.
- Stored per user in `model_pools/{uid}`; API `GET/PUT /api/models`.

## How a request runs

Planning is deterministic (no model call): `src/lib/ai/orchestrator/plan.ts`.

- Short/simple request, or one active model → one request.
- Otherwise specialists work on sub-tasks in parallel (dependent tasks wait for
  their inputs), their results are compared, and the coordinator writes one
  final answer. Asking for "separate answers from each model" returns one
  section per model instead.
- A model that fails, is rate-limited or is over its budget is replaced by the
  next suitable one. If none can do a task, the task is reported as failed —
  no text is invented. If every model is down the request fails with
  `AI_PROVIDER_UNAVAILABLE` and the user's message is kept.
- The Agent build pipeline splits design / implement / repair / review across
  the pool the same way; files are written only when a model actually produced them.

## Rate budgets

`src/lib/ai/orchestrator/scheduler.ts` keeps a rolling 60-second token ledger
per model. The per-minute budgets are MATRIX's own scheduling limits
(`MATRIX_MODEL_TPM_<KEY>`), not a statement of the provider account's quota.
A provider rate-limit response cools the model down for 30 seconds.

## Not verified in the build environment

No provider key was available where this was developed, so behaviour is covered
by tests against a simulated provider (`tests/multi-model.test.ts`), not by
live calls. Which of the extra models your Groq account actually offers is
shown on the Models page once deployed.
