# QORVYNA AI Constitution

This constitution governs how QORVYNA AI is specified, built, tested, and
released. It applies to the web application, the Tauri desktop shell, the
Android/Flutter clients, the server APIs, and the runtime AI agent engine.
It is development governance only: it does not change any runtime behavior or
replace the application's own AI orchestration.

## Core Principles

### I. User-First AI Experience

The assistant MUST be understandable, controllable, and useful to the intended
audience, including users aged 11–17 and Bangla-speaking users. Capabilities
and limitations MUST be stated plainly. Requests for real work are executed
through the appropriate application path or parked for explicit approval;
they are never answered with invented prose claiming success. User-visible
state (progress, errors, approvals, sources) MUST be observable.

### II. Privacy and Security by Design

Privacy and security are requirements of the first iteration, not hardening
work deferred to release. Authentication and authorization MUST be verified
server-side on every privileged request. Firestore rules default-deny writes;
the Admin SDK performs canonical writes after ownership, family, or RBAC
checks. Secrets, provider keys, and service credentials MUST stay server-side
and out of client bundles, prompts, logs, and repositories. Sensitive actions
require explicit, informed user confirmation.

### III. Reliable and Verifiable AI Responses

Every AI claim MUST be traceable to what actually happened: a produced file,
a completed tool call, a verified provider response, or an explicit failure.
Unavailable providers, unverified models, missing credentials, rate limits,
and retrieval failures MUST be reported honestly, never masked as successful
answers. Fallbacks MUST be visible to the user. Deterministic checks — parsers,
validators, tests, and build verification — take precedence over model
self-reporting.

### IV. Modular and Maintainable Architecture

The existing boundaries are mandatory: `src/app` for App Router routes,
`src/app/api` for HTTP handlers, `src/lib/firebase` for identity and session
helpers, `src/lib/server` for privileged operations, `src/lib/ai` for provider
and orchestration logic, `src/lib/projects` and `src/lib/deploy` for build and
publishing helpers. New capabilities MUST reuse these boundaries instead of
introducing parallel frameworks. Modules with pure logic stay free of React,
network, and Firestore imports so they remain unit-testable.

### V. Cross-Platform Consistency

A shared capability MUST behave consistently on web, Tauri desktop, and
Android clients, or the difference MUST be explicit in the specification and
UI. Platform-specific integrations MUST stay behind their own adapters and
capability declarations. Shared logic MUST NOT introduce Windows, Android, or
web build regressions; a change to one target is validated against the
targets it can affect.

### VI. Accessibility and Responsive Design

Interfaces MUST be usable on desktop, tablet, and small screens, with
keyboard-accessible controls, readable contrast, and language-aware text
direction where relevant. Voice and visual affordances are enhancements to a
fully usable manual path, never the only path. Loading, error, and approval
states MUST be announced clearly and remain operable after a failed request.

### VII. Performance and Resource Efficiency

Requests MUST be bounded: input sizes, output tokens, tool timeouts, retry
counts, and per-user rates have explicit limits. Model scheduling uses local
budget ledgers only as scheduling policy, never as a claim about provider
quotas. Long-running work belongs in durable records and separately deployed
workers, not in browser timers or an unbounded server process. Avoid new
dependencies unless an existing library cannot meet the requirement.

### VIII. Test-Driven and Specification-Driven Development

New behavior starts as a specification with observable outcomes and explicit
compatibility boundaries. Implementation is checked against the constitution
in `/speckit.plan`, decomposed in `/speckit.tasks`, and reviewed for
inconsistency with `/speckit.analyze` before integration. Tests are written
for pure logic, contracts, and security boundaries. Passing unit tests alone
never upgrade a partially implemented or externally unverified feature to
"verified".

## Engineering Standards

### Type Safety and Strict Validation

TypeScript strict mode is the default. All untrusted input — HTTP bodies,
query parameters, model output, tool arguments, imported files — MUST be
validated with Zod or an equivalent existing validator before use. Unknown
structured output is rejected rather than coerced into a successful result.
Shared response envelopes and error codes MUST remain backward compatible.

### Reusable Components and Clean Architecture

Reuse existing UI primitives, hooks, server helpers, and provider adapters.
Keep pure policy and classification separate from transport and persistence.
Do not duplicate authorization, validation, or formatting logic in route
handlers when a shared helper exists. Prefer small, focused modules with
clear ownership over large catch-all utilities.

### Secure API and Database Access

Every API verifies identity independently of middleware. Mutations apply the
shared origin/CSRF protection for browser clients and accept native bearer
clients only through the existing device-session path with route-level
authorization. Privileged reads and writes go through server helpers that
enforce ownership, family membership, or admin RBAC. Firestore rules stay
default-deny for browser writes. Signed upload paths and private media stay
server-controlled.

### No Hardcoded Secrets or Exposed Credentials

Credentials come from environment variables, the server-only settings store,
or deployment secret management. Placeholder values in examples MUST be
clearly fake. Masked status is the only key material returned to a browser.
Do not add real tokens, private URLs, account identifiers, or signed URLs to
commits, specs, fixtures, or documentation.

### Error Handling, Logging, and Observability

Failures return typed, actionable errors with stable codes and appropriate
HTTP status. Structured logs record request context and provider/tool
outcomes without user secrets, raw credentials, or unnecessary personal data.
Audit records for privileged actions and tool calls are written by the server.
A missing optional integration reports "not configured" rather than throwing
an unhandled error or faking success.

### Persistence and Backward Compatibility

Firestore is the canonical persistence layer; do not introduce a second
database without an approved specification. Preserve existing document shapes,
collection names, and IDs. Schema changes require a readable migration or
idempotent backfill path, and existing records MUST remain readable during
rollout. Renamed environment variables keep their legacy aliases while
existing deployments transition.

### Automated Testing and Release Validation

Every change runs `npm run typecheck` and `npm test`. Behavior changes add or
update Vitest coverage in `tests/`. `npm run build` gates releases. Native
frontend changes run `npm run native:check`; Windows or Android release builds
are run only when changed native configuration requires it. Deployment
documentation MUST distinguish verified local checks from staging/production
validation that still needs credentials or devices.

## AI Engineering Standards

### Model-Provider Abstraction and Routing

Models are addressed through the shared registry, routing policy, and provider
adapters, never through hardcoded fetch calls in UI or route code. A model is
scheduled only when a server credential exists and the provider's live catalog
or approved probe confirms availability. Selection is deterministic for a
given request and user preference; manual selections are not silently
overridden. Provider fallbacks are explicit, logged, and reported to the user.

### Explicit Tool Permissions and Approval Boundaries

A model may only request tools by registered id with validated arguments. The
Tool Gateway independently rechecks permissions, scopes, risk tier, and
approval before execution. Medium-and-higher-risk side effects require a
server-created, owner-approved, argument-bound, time-limited, one-time
approval record. Only reviewed read-only tools are exposed as model-callable.
Denials are audited and surfaced, never hidden behind a generic failure.

### Safe Agent Execution and Traceability

Model output is data, not authority. Generated files are parsed, constrained
to safe paths and size limits, and written to a project workspace — never
executed in the Next.js server process. Planning, execution, and final
response synthesis are distinct stages with separate responsibilities. Every
tool call has a request id, outcome, and audit record. Agent task state is
persisted in Firestore with checkpoints; a request to build is not evidence
that work completed.

### Failure Recovery Without Fabrication

Rate limits, timeouts, provider outages, and validation errors trigger
documented fallback or retry paths with bounded budgets. If no eligible model
or tool can complete a task, the task fails with a clear code and the user's
input is preserved. Optional retrieval or memory enrichment never becomes a
hard dependency of chat. No response may claim the existence of hardware,
credentials, deployments, quotas, or capabilities that this repository does
not implement.

## Platform Requirements

### Web

Preserve the responsive Next.js App Router experience: public pages, auth
pages, authenticated modules, admin area, streaming chat, Agent Studio,
workspace, and API routes. Web-specific behavior MUST keep the existing
session cookie, CSRF/origin protection, and default-deny Firestore rules.

### Windows Desktop

Preserve the Tauri 2 shell, its Rust commands, explicit capability set,
deep-link scheme, native notification/shortcut/tray behavior, and the bundled
frontend build path. New web behavior MUST remain compatible with the shell's
CSP and offline-first native bundle. Do not widen native permissions for a
web-only feature.

### Android

Preserve the Flutter phone and Wear OS clients, their API compatibility,
revocable device pairing, and their named Android application IDs. Native
integrations MUST remain consent-based and explicitly permissioned; the
clients do not silently collect installed apps, usage, or history. Do not
change application IDs, update URLs, or build identifiers without a
migration specification.

## Governance

The constitution is the highest-priority development document in this
repository. Every `/speckit.plan` and `/speckit.tasks` run MUST include a
constitution check; non-compliance requires an explicit, reviewed amendment or
a redesign. Amendments are made with `/speckit.constitution`, must state the
rationale and version bump, and are reviewed with the affected specs and
tasks. Semantic versioning applies: MAJOR for removing or redefining a
principle, MINOR for new principles or materially expanded guidance, PATCH
for clarification. Architecture and feature docs describe evidence from the
code; this constitution describes the rules for changing it.

**Version**: 1.0.0 | **Ratified**: 2026-11-19 | **Last Amended**: 2026-11-19
