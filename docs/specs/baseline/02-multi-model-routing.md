# Baseline 02 — Multi-model AI routing

**Status:** Partial — routing, registry, catalog verification, pool, and
fallbacks are implemented in source. Live model availability depends on
operator credentials and a provider's actual catalog; no universal quota or
model entitlement is guaranteed.

**Evidence:** `src/lib/ai/{router.ts,routing-policy.ts,model-catalog.ts,provider-health.ts,config.ts,groq.ts,openai.ts,cloudflare.ts,pipeline.ts}`,
`src/lib/ai/models/{registry.ts,pool.ts,types.ts}`,
`src/lib/ai/orchestrator/{plan.ts,run.ts,scheduler.ts}`,
`src/app/api/models/route.ts`, `src/app/api/ai/route.ts`,
`tests/{multi-model.test.ts,modes-router.test.ts,execution-routing.test.ts,cloudflare-provider.test.ts}`.

## Implemented behavior

- `models/registry.ts` is the only place where language-model IDs are written.
  Each spec carries stable key, provider, strengths, role tier, context/output
  limits, a conservative local TPM budget, and supported modes.
- `routing-policy.ts` deterministically classifies a turn as `conversation`,
  `artifact`, or `image` without a model call. `router.ts` maps mode, lane, and
  strategy onto workload tiers used by prompts and limits. Manual preferences
  are expressed as `models: { auto: false, enabled: [...] }` and are not
  silently overridden.
- `models/pool.ts` establishes availability from facts: a server credential
  that can serve the model plus a live provider catalog entry or approved
  probe. Discovery failures are reported, not cached as permanent absence.
  At most four models collaborate on one request (`MAX_ACTIVE_MODELS`).
- Transport adapters implement a common provider interface: Groq, a generic
  OpenAI-compatible endpoint, and Cloudflare Workers AI are in the active
  configuration path. The admin-configured OpenAI-compatible route can target
  additional compatible services; provider choice is server-controlled.
- `orchestrator/plan.ts` creates a deterministic collaboration plan; `run.ts`
  executes independent tasks in parallel, replaces failed/rate-limited models,
  and has a coordinator synthesize one final answer. If nothing can do a task,
  it is recorded as failed — no answer is invented on a model's behalf.
- `orchestrator/scheduler.ts` maintains a rolling 60-second token ledger,
  per-model budgets, and cool-down after real rate-limit responses. Budgets are
  QORVYNA scheduling limits, not claims about a provider account's quota.
- `GET /api/models` reports configured/offered/unavailable state and diagnostics;
  `POST /api/models/test` runs a real probe. `GET /api/ai/...` streaming chat
  exposes provider and model outcome metadata to the client.
- `image/` contains a separate image-generation provider registry; GLM plans
  prompts and never emits binary images itself.

## Boundaries and non-goals

- Credentials never enter client bundles. The browser never selects a provider
  endpoint directly.
- Fallback follows an explicit order and is reported; a failed provider is not
  presented as a successful answer.
- Exact models, context windows, and entitlements are discovered at runtime.
  Documentation must not promise a fixed Gemini model or universal quota.

## Partial / planned / deprecated

- **Partial:** live provider/catalog verification was not exercised in this
  checkout; behavior is covered by unit/contract tests against simulated
  providers.
- **Partial:** older architecture documents name a single 120B model as the
  only option; current source uses the collaborative pool with Cloudflare as
  the artifact-capable route when configured. Source takes precedence.
- **Planned:** no automatic model capability learning or billing-aware
  scheduler is implemented.
