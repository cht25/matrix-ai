# Baseline 03 — In-house agent orchestration

**Status:** Partial — a bounded project-building agent with persisted task
state exists. It is not a general autonomous isolated coding worker.

**Evidence:** `src/lib/ai/{agent.ts,agent-execution.ts,executor.ts,pipeline.ts,build-intent.ts,execution-policy.ts,task-outcome.ts}`,
`src/lib/ai/orchestrator/`, `src/lib/server/{agent-tasks.ts,agent-deploy.ts,build.ts,continuation.ts,tool-gateway.ts}`,
`src/app/api/build/route.ts`, `src/app/api/agent/tools/route.ts`,
`tests/{agent.test.ts,agent-execution-truth.test.ts,agent-tasks.test.ts,agent-clarification.test.ts,build-intent.test.ts}`.

## Implemented behavior

- Chat and execution are separate paths. `build-intent.ts` and
  `execution-policy.ts` decide whether a request is a real build task, a
  clarification, or a normal answer. A clarification pauses the task in
  Firestore until the user answers; `cancel` and task-interruption handling
  are explicit.
- `agent-execution.ts` classifies actual model output into states such as
  `PLANNING`, `FILE_GENERATION`, `VALIDATION`, and `FAILED`. A request to build
  is never evidence that files were generated. Only bounded full-file writes
  with safe paths are accepted from labeled protocols, structured JSON, or
  allow-listed tool calls.
- `src/lib/server/agent-tasks.ts` persists one header per run in `agent_tasks`
  and append-only checkpoints in `agent_tasks/{id}/checkpoints`. Checkpoint
  steps include inspect, plan, permission check, edit, build, test, diagnose,
  repair, deploy approval, deploy, verify, and report. Statuses include
  planning, running, awaiting approval/input, completed, failed, cancelled.
  Checkpoints are written only after real server-side results.
- `src/lib/server/build.ts` and `src/lib/deploy/` manage build runs, file
  validation, static preview, publish URLs, and verification. Generated
  backend code is not executed in the web process.
- The agent has bounded tool access through the Tool Gateway (see baseline 04)
  and reuses the model pool for design/implement/repair/review responsibilities.
- Continuation logic resumes a paused task with prior clarifications instead
  of re-asking for information the user already supplied.

## Boundaries and non-goals

- Tool set is constrained to registered tools; there is no arbitrary shell,
  unrestricted filesystem, or general framework backend execution.
- Deployment requires explicit approval and credentials; preview/publish URLs
  are resolved from validated configuration, not request Host headers.
- Agent state must never be inferred from the original prompt once work starts.

## Partial / planned / deprecated

- **Partial:** no isolated resource-limited runner for arbitrary generated
  backend code; no persistent database provisioning for generated apps.
- **Planned:** self-healing patches and general full-stack generation with
  PostgreSQL/Supabase/Turso/SQLite adapters are roadmap items.
- **Deprecated:** prose-only claims of deployment success were removed; any
  remaining documentation that says otherwise is stale and should be fixed.
