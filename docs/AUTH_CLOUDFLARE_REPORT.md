# Delivery report — Google auth lifecycle + Cloudflare Workers AI

Two-part delivery on branch `arena/b6879f80-matrix-ai`:

1. **Auth lifecycle** — post-redirect Google sign-in now reaches a fully loaded
   authenticated chat instead of landing back on `/login`.
2. **Cloudflare Workers AI** — integrated into the existing provider
   abstraction as the primary provider (when configured) with the existing
   providers as automatic fallback, plus free-tier quota management.

Both parts shipped together in this branch's pull request.

---

## 1. Google auth lifecycle

### What was wrong

After `signInWithRedirect` returned, the app had no single owner for the
redirect result, the Firebase initial-state wait, backend session minting or
post-login navigation — several components each waited on a different signal,
so the landing screen could conclude "logged out" and show `/login` even
though Firebase had a user.

### What changed

- **`src/lib/auth/lifecycle.ts` (new)** — one central state machine:
  `INITIALIZING → AUTHENTICATED → PROFILE_LOADING → READY`, plus
  `UNAUTHENTICATED` and `ERROR`. It owns, in order:
  - the memoised redirect-result consumer (`consumeOAuthRedirect` — exactly
    once per page, shared by login/register/verify/watcher);
  - `waitForAuthUser` (waits for Firebase's initial state — never declares
    logged out before it resolves);
  - `setPersistence(browserLocalPersistence)` (local persistence so the
    session survives refresh; `localStorage` is never a source of truth);
  - backend session GET-probe first, mint only when the probe says the cookie
    is missing/invalid (`ensureBackendSession`, single-flight);
  - a navigation-loop guard (sessionStorage attempt counter, 120 s window,
    max 2 attempts, diagnostic on block).
  Tokens are never logged; only stage/status diagnostics
  (`src/lib/auth/diagnostics.ts` stages extended: `auth-init`,
  `persistence`, `auth-state`, `id-token`, `session-check`, `profile`,
  `navigation`, `chat-load`).
- **`src/components/auth/auth-provider.tsx` (new)** — React context over the
  lifecycle; mounted in `src/app/layout.tsx`.
- **`src/components/auth/login-screen.tsx`** — renders from the lifecycle
  decision (`wait` / `navigate` / `form` / `error`), performs the single
  `window.location.replace` post-login navigation (no `/login` entry left in
  history), shows a recoverable ERROR banner with Retry, and blocks the
  loop-guard dead-end with a "Try again" path. Email/password auth untouched.
- **`src/app/(auth)/register/register-form.tsx`** — same lifecycle-driven
  navigation + guard.
- **`src/app/api/auth/session/route.ts`** — added `GET` probe
  (`{authenticated, uid, onboarding_complete}`); the `POST` mint (with
  `ensureUserDocuments`, so no duplicate profiles) is unchanged.
- Chat pages log a `[QORVYNA chat] history loaded` diagnostic (conversation id,
  message count, mode — never content).

### Regression coverage

`tests/auth-lifecycle.test.ts` (18 tests) simulates the full flow: initial
auth-state wait, redirect consumption, backend probe vs mint, navigation
decision, error recovery, loop guard, persistence choice. The existing
14-step manual checklist (Google new/existing account, email/password,
refresh persistence, logout/relogin) still applies for a live smoke test —
the automated suite covers the lifecycle mechanics, not live Google
credentials.

---

## 2. Cloudflare Workers AI integration

### Architecture decisions

- **Provider, not a side app.** `CloudflareProvider implements AIProvider`
  inside the existing abstraction (`src/lib/ai/cloudflare.ts`), so chat,
  advanced chat, Agent mode, compare, health and the admin panels all gain it
  automatically. Nothing existing was removed or replaced.
- **Primary + fallback.** When `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`
  are set, the Cloudflare route leads the pool (`coordinatorRank: 0`); the
  existing Groq/dedicated routes remain configured as automatic fallback for
  every call site that falls back (`completeWithFallback` /
  `streamWithFallback`).
- **Exact endpoint.** `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL_ID}`,
  `Authorization: Bearer {CLOUDFLARE_API_TOKEN}` (backend env only), default
  model `@cf/zai-org/glm-4.7-flash`.
- **Both response shapes** are handled: OpenAI-compatible
  (`result.choices[0].message.{content,tool_calls}`) and native
  (`result.response`) — for chat and for SSE streaming (`data:` frames,
  optional `[DONE]`).
- **Agent tool-calling** travels on the non-streaming request
  (`tools` + `tool_choice: "auto"`) exactly like the Groq adapter, so the
  existing backend tool-execution engine runs unchanged; structured output
  (`response_format`) is requested only for models whose registry spec allows
  it.

### Files changed (Cloudflare part)

| File | Change |
| --- | --- |
| `src/lib/ai/cloudflare.ts` | **new** provider (endpoint, auth, buildBody, chat, streamChat, healthCheck, listCloudflareModels, credential parsing, `isCloudflareQuotaExhausted`, redacted logging config) |
| `src/lib/ai/cloudflare-quota.ts` | **new** server-only quota accounting (Firestore `cloudflare_usage/<UTC-date>`, Neuron analytics, request safety budget, exhaustion gate) |
| `src/lib/ai/models/registry.ts` | `provider: "groq" \| "cloudflare"`, new GLM 4.7 Flash spec (`CLOUDFLARE_MODEL_KEY` / `CLOUDFLARE_MODEL_ID`) |
| `src/lib/ai/config.ts` | `cloudflareRoute()` / `hostedRoute()` / `configuredRoutes()`, cloudflare-first primary, status/log updates |
| `src/lib/ai/models/pool.ts` | per-provider catalog verification (Cloudflare's own model list), TPM override, dedicated-endpoint detection fix |
| `src/lib/ai/provider-error.ts` | `AIProviderName` += `"Cloudflare"`; `CLOUDFLARE_QUOTA_EXHAUSTED` → `AI_PROVIDER_QUOTA_EXHAUSTED` |
| `src/lib/api-errors.ts` | new `provider-quota` failure kind with quota-reset copy |
| `src/app/api/ai/route.ts` | orchestrator path now fallback-capable; quota-aware fallback step detail |
| `src/app/api/rpc/route.ts` | `admin_cloudflare_quota` action (`ai.view` permission) |
| `src/components/admin/cloudflare-quota-panel.tsx` | **new** quota dashboard card |
| `src/components/admin/ai-usage-panel.tsx` | renders the quota panel on the Usage tab |
| `.env.example` | Cloudflare section (see below) |
| `tests/single-model.test.ts` | allows only the `@cf/zai-org/glm-…` catalog spelling; all legacy GLM/z.ai/bigmodel bans kept |

Auth-lifecycle files are listed in section 1; both parts are in the same PR.

### Environment variables

```bash
# required (both together) — backend only, never shipped to the browser
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_DEFAULT_MODEL=@cf/zai-org/glm-4.7-flash   # optional; this is the default

# optional quota safety valves (defaults shown)
CLOUDFLARE_DAILY_NEURON_BUDGET=10000
CLOUDFLARE_NEURON_SAFETY_RESERVE=500     # effective in-app budget = budget − reserve
CLOUDFLARE_DAILY_REQUEST_BUDGET=400      # used only when Neuron usage cannot be read
```

Unset → Cloudflare is a no-op and the deployment behaves exactly as before.

### Configuration steps (Cloudflare dashboard)

1. Open the Cloudflare dashboard → **Workers & Pages** → any project (or the
   account home). Copy the **Account ID** from the right-hand rail →
   `CLOUDFLARE_ACCOUNT_ID`.
2. **My Profile → API Tokens → Create Token** → use the **Workers AI**
   template (grants *Workers AI – Read* and *Workers AI – Edit*) → copy the
   token → `CLOUDFLARE_API_TOKEN`.
3. Set both values in the backend environment (and optionally
   `CLOUDFLARE_DEFAULT_MODEL`; verify any id against
   `https://developers.cloudflare.com/workers-ai/models/`).
4. Redeploy. Admin → AI → Usage shows the Cloudflare quota card; Admin → AI →
   Providers shows the Cloudflare health probe.
5. To add more models later: add specs in
   `src/lib/ai/models/registry.ts` with `provider: "cloudflare"` and the exact
   catalog id — availability is verified against the account's own model list,
   never assumed.

### Quota management (Free tier, 10 000 Neurons/day, reset 00:00 UTC)

- Every request is **gated before it is sent** and recorded after it.
- Actual usage is read from Cloudflare's GraphQL analytics when the token may
  read it, otherwise from neuron counts the API reported on responses —
  **never estimated from tokens**. When neither is readable, a request-count
  safety budget is the stop valve.
- On exhaustion (`CLOUDFLARE_QUOTA_EXHAUSTED`, HTTP 402/403/429 with
  neuron/quota semantics) the gate stops new Cloudflare requests, the typed
  error is fallback-eligible so **another configured provider answers**
  (or the user gets the clear quota message), the session/project/message are
  preserved, `retryAt` is the next 00:00 UTC, and **no paid upgrade path
  exists anywhere in the code**.
- Dashboard: Admin → AI → Usage → "Cloudflare Workers AI quota" (UTC day,
  Neurons or request fallback, % bar, reset time, exhaustion state).

### Security

- Token/account id read only from backend env; `server-only` imports;
  client receives at most `redactedConfig()` (first/last 4 characters).
- Every upstream error passes `sanitizeProviderDetail` — the token never
  appears in API responses, logs or the admin panel.
- Invalid account id → `INVALID_ACCOUNT_ID` (not "model unavailable");
  permission errors → auth failure; unknown model → model-unavailable;
  rate limit vs free-quota exhaustion are distinguished.

---

## 3. Tests performed and results

Command: `npx tsc --noEmit`, `npm test`, `npm run build`.

| Suite | Result |
| --- | --- |
| Full suite (`npm test`) | **106 files / 1263 tests passed** (baseline 103/1213) |
| `tests/auth-lifecycle.test.ts` | 18/18 passed |
| `tests/cloudflare-provider.test.ts` (new) | 20/20 passed |
| `tests/cloudflare-quota.test.ts` (new) | 12/12 passed |
| `tests/single-model.test.ts` (guards) | 27/27 passed |
| `tests/multi-model.test.ts` | passed (run with no `CLOUDFLARE_*` env — Cloudflare is a no-op there) |
| `npx tsc --noEmit` | clean |
| `npm run build` (Next 15 production build) | succeeded |

Cloudflare test scenarios covered (mocked `fetch`, no network):

1. endpoint + Bearer auth + native response shape — ✔
2. OpenAI-compatible response shape incl. tool calls — ✔
3. SSE streaming (both chunk styles, `[DONE]`) — ✔
4. invalid API token → authentication failure — ✔
5. invalid account id → `INVALID_ACCOUNT_ID` (distinct) — ✔
6. missing-permission token → auth failure, not quota — ✔
7. unknown model → model-unavailable — ✔
8. free-quota 429 neuron message → `CLOUDFLARE_QUOTA_EXHAUSTED`, gate marked,
   fallback-eligible, `retryAt` = UTC reset — ✔
9. quota gate refuses to send (fetch never called) — ✔
10. request cancellation (`AbortSignal`) — ✔
11. health probe via model-list endpoint (no inference spend) — ✔
12. account model listing + honest failure — ✔
13. token absent from every error/report/log payload — ✔

Quota accounting covered: UTC day keys/reset, Firestore record+read, GraphQL
Neuron read, response-reported fallback, "unavailable" honesty, request-budget
safety net, exhaustion stops requests, no-op when unconfigured, server-only
source scan.

Auth covered by the 18 lifecycle tests listed in section 1.

## 4. Known limitations

- **Live Google OAuth and live Cloudflare calls were not exercised from this
  sandbox** (no Google project, no Cloudflare account, and outbound network is
  restricted). Auth and Cloudflare behaviour is verified by simulated
  lifecycle/fetch tests plus a clean production build; a live smoke test
  against real credentials (the 14-step checklist + one real Workers AI chat)
  remains for the operator.
- Cloudflare GraphQL analytics may be denied by the token's permission set —
  the dashboard then honestly reports "unavailable" and the request safety
  budget governs (by design; no token-derived estimates ever shown).
- Neuron accounting across concurrent instances uses Firestore
  read-modify-write (not a transaction): undercounting is possible under heavy
  concurrency; the safety reserve + request budget absorb it.
- Tool-calling/structured-output/context-window per model come from the
  registry spec and Cloudflare's model list; the live docs could not be
  re-fetched from this sandbox, so verify `CLOUDFLARE_DEFAULT_MODEL` against
  the model catalog when changing it.
- `/api/models` still reports only models configured **on this deployment**;
  adding a Cloudflare spec does not make it "available" until the account
  credentials are set and the account's model list contains it.
