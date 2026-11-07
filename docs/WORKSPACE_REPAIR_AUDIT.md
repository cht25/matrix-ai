# MATRIX workspace repair audit

Audit date: 2026-11-07. Repository baseline: `f65ad24`, plus the existing uncommitted shared-service hardening in this branch. This audit covers the newly requested Chat/Coding/Agent/Canvas/Build/Deployment mission. The message refers to screenshots, but no image attachments were available in the conversation; the four explicit textual defect reports are treated as mandatory reproduction targets.

## Existing architecture (preserve)

- Next.js 15 App Router / React 19 / TypeScript; Firebase Auth session cookies and ID tokens; Firestore Admin SDK is the server write boundary.
- Project source: `projects/{id}/files`; snapshots: `projects/{id}/versions/{id}/files`; tasks: `agent_tasks/{id}/checkpoints`; builds: `build_runs/{id}`; releases: `deployments/{id}/files`; public routing: `published_sites/{slug}` and `/s/{slug}/{path}`.
- AI providers are server-side adapters selected through `src/lib/ai/config.ts`; runtime administrator configuration is stored separately. Existing GitHub and Vercel integrations remain available.
- `/api/rpc` owns project CRUD; `/api/ai` owns conversation; `/api/build` streams `runBuildPipeline`; `FirestoreDeploymentProvider` implements static hosting; `/api/projects/{id}/preview` and `/s/{slug}` serve content with CSP sandboxing.

## Lifecycle trace and root causes

### 1. Ordinary chat can execute a project build

`chat-client.tsx` calls `shouldRunBuildPipeline(buildIntent)` without first requiring `mode === "agent"`. `detectBuildIntent` can return build actions in General/Code mode. Conversely, `/api/ai` inherits a stored `agent` mode when the request omits an explicit mode. Execution authority is therefore ambiguous.

Repair: explicit per-request execution policy; only an activated Agent may enter the build runtime. General/Code responses remain conversational/code-block answers. Persist and restore the active project independently of the chat mode.

### 2. Generated source is dumped into chat / raw HTML appearance

The Agent streaming path emits every provider delta before parsing `MATRIX_FILE` blocks. It also stores up to 60 KB of each source file in message metadata, and the workspace fetch copies whole project files back into chat metadata. The custom Markdown parser only recognizes simple word-language fences and has no filename/download contract. Unfenced HTML is consequently rendered as escaped paragraph text (safe, but not a useful code answer).

Repair: buffer Agent generation server-side, emit only execution events and file summaries, persist source once in the project, and return file references rather than source-bearing chat artifacts. Coding assistance gets filename-aware fenced blocks, safe token highlighting, Copy and Download. Never inject AI HTML into the authenticated DOM.

### 3. “The project has no files to build” / disappearing files

There are multiple divergent paths: `/api/ai` ensures a project by conversation, while `/api/build` accepts a separate project ID; the chat does not send a server-validated active project in the AI body. File writes in the AI path are best-effort and can fail while a reply still looks successful. The workspace can reload server files over an unsaved editor buffer. `actions.build=false` correctly refuses to generate, but an incorrect/empty project ID then produces `NO_FILES` without identifying the mismatch.

Repair: one owner-checked active project per conversation, explicit project IDs on every runtime request, transactional deterministic file writes and revision checks, durable pre-build manifest/entry diagnostics, and no replacement of dirty editor state by a background reload.

### 4. Localhost production URL

`siteOrigin()` already rejects several loopback forms, but `absoluteUrl()` accepts any stored absolute HTTP URL, and deployment records/URL lists can contain legacy values. The reported `http://localhost:10000/s/canvas` is therefore displayable even though current generation normally uses the canonical origin. Request Host headers are not a deployment authority.

Repair: validate canonical public origins and explicit verified domain mappings; sanitize legacy generated URLs at every API/UI boundary; never construct a public URL from Host or a preview server. Keep loopback only in explicitly local test/runner configuration, never in production-facing records.

### 5. “Agent task completed” beside “Build failed”

`/api/build` never creates or updates an `agent_tasks` record. The chat synthesizes all six Agent stages before execution and reports `toolsExecuted: 1` merely because files were parsed. `AgentActivityCard` labels a finished response “Agent task completed” without consulting build/deployment state. RPC callers can also write checkpoint/status values directly.

Repair: bind each runtime build to a persisted task; derive task state from actual build/deployment outcomes; remove client-authored success checkpoints; show separate Task / Build / Deployment states and recover them after reload.

### 6. Build and publish are not release verification

`FirestoreDeploymentProvider.build` performs static validation/inlining, not dependency installation or framework compilation. Deploy deletes the currently served file set before uploading replacements, activates `published_sites` after database writes, and never fetches the public URL. A partial upload can break the old release; a DB write can be labelled live even when routing is unavailable. Rollback has the same issue.

Repair: immutable staged release files and an atomic pointer switch; preserve the previous release; verify the canonical HTTP document and required assets before `live`; expose verification evidence/error. Framework builds require a configured isolated runner (or real configured hosting build), otherwise fail with an explicit capability error rather than pretending static inlining compiled React/TypeScript.

## Implementation order

1. Mode separation, safe code rendering, source-free Agent chat and context binding.
2. Transactional project manifest/file operations and durable task/build state.
3. Static release staging + public HTTP verification + rollback; isolated framework runner contract.
4. Workspace/Canvas editor and preview integration, recovery and responsive checks.
5. Regression/security tests, production build, browser checks and truthful verification report.

No production deployment or production data mutation is authorized by this audit. Existing collections are extended additively; no historical SQL is executed.
