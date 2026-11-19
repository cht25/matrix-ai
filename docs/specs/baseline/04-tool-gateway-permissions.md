# Baseline 04 — Agent Tool Gateway and permission system

**Status:** Implemented (source) for the registered tool set and approval
protocol; no physical device tools are implemented.

**Evidence:** `src/lib/ai/tools/{registry.ts,index.ts}`,
`src/lib/server/{tool-gateway.ts,tool-approvals.ts,request-security.ts}`,
`src/app/api/agent/tools/route.ts`, `firestore.rules`,
`tests/tool-gateway.test.ts`, `tests/tool-registry.test.ts`,
`tests/request-security.test.ts`.

## Implemented behavior

- Every capability is a `ToolSpec` in a server-side registry: stable id, Zod
  input schema, category, risk tier (`low`/`medium`/`high`/`critical`),
  required RBAC permissions, scopes, environment, timeout, model-callable
  flag, approval requirement, and audit requirement. `index.ts` registers
  built-in tools such as `projects.list`, `devices.list`, `device.status`,
  `reminders.create`, `family.list`, and notification tools.
- A model can only **request** a tool by id and arguments. The registry
  converts Zod schemas to JSON Schema for model-facing declarations and
  validates arguments before any handler runs.
- `tool-gateway.ts` is the only execution path. It rechecks permissions,
  device scopes, model-callable status, risk/approval, and a per-user rate
  limit; it runs handlers with timeouts and writes `audit_logs` records for
  success, denial, and error with a per-call request id.
- `tool-approvals.ts` implements real one-time approvals: server-created
  records bound to the owner, tool id, canonical argument hash, and expiry
  (10 minutes). Approval and consumption use Firestore transactions; a stale,
  mismatched, or reused approval is rejected.
- `GET /api/agent/tools` exposes descriptions only. `POST /api/agent/tools`
  requires a session, CSRF/origin protection for browser clients, a bounded
  body, and goes through the guarded gateway. Only reviewed read-only tools
  are advertised to chat models.
- Sensitive voice/device intents require confirmation in the assistant layer
  as well; confirmation text is not an approval token.

## Boundaries and non-goals

- Adding a tool requires a registry entry; ad-hoc model-defined tools are not
  executed. A missing permission, scope, or approval yields an explicit denial.
- Model-facing schemas never include handlers or server implementation detail.
- Audit writes are best-effort but failures are logged; they are not silently
  discarded.

## Partial / planned / deprecated

- **Partial:** no physical actuator command tool, MQTT broker adapter, or
  device acknowledgement protocol exists in source.
- **Planned:** additional notification delivery and device-action tools depend
  on separate consented integrations.
