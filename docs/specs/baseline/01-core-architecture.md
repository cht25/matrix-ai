# Baseline 01 — QORVYNA AI core architecture

**Status:** Implemented (source) for the web application and API layer;
cross-platform shells are described separately in
[07-cross-platform.md](07-cross-platform.md).

**Evidence:** `README.md`, `ARCHITECTURE.md`, `SYSTEM_ARCHITECTURE.md`,
`src/app/`, `src/app/api/`, `src/lib/`, `src/middleware.ts`, `package.json`.

## Implemented behavior

- The primary product is a responsive **Next.js 15 App Router** application
  (`src/app`). Public pages, auth pages, `/(app)` modules, `/(admin)` modules,
  docs, certificate verification, and dev-only previews are separate route
  groups. `npm run dev`, `npm run build`, and `npm start` are the standard
  local/production commands.
- **Firebase Auth + Firestore** are canonical. The browser signs in with
  Firebase client Auth, exchanges an ID token at `POST /api/auth/session` for a
  signed httpOnly cookie, and server code verifies that cookie through the
  Admin SDK (`src/lib/firebase/{client,admin,session}.ts`).
- `src/middleware.ts` performs routing-only cookie checks. Every privileged
  API independently verifies identity and authorization; middleware is not an
  authorization boundary.
- `src/app/api/rpc/route.ts` is the shared mutation/query envelope
  (`{ success, data, error }`) with Zod validation and ownership/RBAC checks in
  `src/lib/server/rpc.ts`. Privileged helpers live in `src/lib/server/`.
- `POST /api/ai` is the streaming (SSE) chat gateway. Its order of operations
  is auth → rate limit → PII redaction → safety/domain classification →
  retrieval/memory context → model routing → provider call → validation.
- `POST /api/build`, project preview routes, `/s/<slug>` published sites,
  signed Cloudinary uploads, device pairing routes, and the protected
  `/api/jobs/automations` worker endpoint are distinct bounded subsystems.
- Firestore stores users, profiles, conversations, messages, projects and file
  subcollections, build runs, agent tasks, published sites, deployments,
  families, devices, automations, approvals, usage logs, and audit logs.
  Browser writes are default-denied by `firestore.rules`; server writes use
  Admin SDK with ownership checks.
- TypeScript is strict (`tsconfig.json`), Zod validates untrusted input, and
  Vitest covers pure logic and contracts in `tests/`.

## Boundaries and non-goals

- Provider credentials, GitHub/Vercel tokens, and service-account material are
  server-only. Browser code receives masked status only.
- Model output is data, never an authorization source. Tools are revalidated
  by the server; generated code is not executed in the Next.js process.
- Account devices (QORVYNA Connect) and physical ESP32 actuators are different
  entities; a paired phone is not a smart-home device.
- Browser timers are not a scheduler. Durable due records live in Firestore and
  are claimed by a separately deployed authenticated worker.

## Partial / planned / deprecated

- **Partial:** a single generated OpenAPI document does not exist; API behavior
  is documented in code plus `API_DOCUMENTATION.md`.
- **Planned:** robotics is a stated direction in `README.md` but has no
  implementation. A resource-limited isolated code runner is a roadmap item.
- **Deprecated / legacy:** internal identifiers containing `matrix` are kept
  on purpose for installed-app and data compatibility (see
  `docs/REBRAND_MIGRATION.md` and `mobile/README.md`). `seed/*.sql` is not a
  migration mechanism for this Firestore deployment.
