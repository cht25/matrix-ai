# MATRIX workspace/build/deploy repair — verification record

Date: 2026-11-07 (Asia/Dhaka)
Branch: `arena/f05e0edc-matrix-ai`
Base: `f65ad2468963d78bbd8d7bd037925431be3dfa60` (`main`)

This record describes what was implemented and what was actually verified in the sandbox. It does **not** claim a production deployment occurred. Production data was not mutated, and no credentials were added to the repository.

## Commits in this repair

| Commit | Scope |
| --- | --- |
| `76a48e3` | Prior shared-service hardening: request security, model catalog/routing, Canvas persistence, automations, device credentials, encrypted runtime AI keys. |
| `fee0fcd` | `docs/WORKSPACE_REPAIR_AUDIT.md`: lifecycle audit and root causes. |
| `d57f46c` | Strict Chat / Coding Assistance / Agent Execution separation; safe code-block rendering; source-free agent chat persistence. |
| `6a3c318` | Transactional project file operations, deterministic file IDs, manifests, revision checks, restore points. |
| `a0cd22d` | Durable `agent_tasks` bound to real `build_runs`; server-written execution states/checkpoints; cooperative cancellation. |
| `b0b04ce` | Staged deployment artifacts, HTTP verification before `live`, rollback verification, localhost/private URL sanitization. |
| `f55e740` | Deployment success details, mobile preview toggle, 20 mandatory repair test cases. |

## Commands and results

All commands were run from `/home/user/matrix-ai`.

```text
npm run typecheck
  -> clean (after each stage and final)

npm test -- --reporter=dot
  -> Test Files  71 passed (71)
     Tests       643 passed (643)

npx vitest run tests/mandatory-repair-cases.test.ts --reporter=dot
  -> Test Files  1 passed (1)
     Tests       20 passed (20)

npm run build
  -> Next.js production build completed successfully
     log: /tmp/matrix-repair-build.log

npm run test:browser
  -> desktop/mobile responsive smoke passed
     /api/models: real HTTP 401
     /api/devices: real HTTP 401
     cross-origin session deletion: real HTTP 403
     unconfigured automation worker: explicit HTTP 503
     health endpoint: HTTP 503, ok=false because local service credentials are not supplied
     log: /tmp/matrix-repair-browser.log
```

The browser smoke intentionally verifies honest unconfigured states. It is not an authenticated end-to-end AI/build/deploy test.

## Root causes addressed

1. **Mode mixing / raw HTML in chat**
   - `src/lib/ai/execution-policy.ts` makes execution authority explicit.
   - General/Code requests cannot acquire Agent build authority.
   - `/api/ai` rejects executable Agent work with `AGENT_RUNTIME_REQUIRED` and no longer writes project files.
   - `src/components/markdown.tsx` + `src/lib/code-blocks.ts` render code answers as escaped, highlighted blocks with language, filename, Copy and Download. Raw HTML answers are shown as code, never trusted markup.

2. **“The project has no files to build”**
   - Conversation/project context is carried through `active_project_id` → `initialProjectId` → build request `project_id`.
   - Empty builds fail with `NO_FILES` and a file-count-aware message.
   - Project files are loaded from Firestore, not browser storage.

3. **Non-transactional workspace writes**
   - `src/lib/server/projects.ts` now uses Firestore transactions for upsert/delete/rename/apply/restore.
   - Deterministic file IDs prevent duplicate path documents.
   - Project `revision` and `file_manifest` are maintained atomically.
   - Editor autosave sends `expected_revision`; conflicts pause autosave instead of silently overwriting.

4. **Fake/synthesized Agent progress**
   - Build runs are bound to persisted `agent_tasks`.
   - Execution states (`QUEUED`, `PLANNING`, `CREATING_FILES`, `BUILDING`, `TESTING`, `DEPLOYING`, `DEPLOYED`, `FAILED`, `CANCELLED`, etc.) are derived from real run state.
   - Browser RPC cannot write checkpoints or mark tasks completed; only cancellation may be requested.
   - Legacy synthesized Agent activity cards were removed from chat rendering.

5. **Deployment marked live from a DB write / localhost URLs**
   - `FirestoreDeploymentProvider` stages artifacts, sets `verifying`, HTTP-fetches the canonical public URL and bounded local assets, then activates `live`.
   - Failed verification restores the previous artifact set and does not report success.
   - Rollback re-stages snapshot files and HTTP-verifies before activation.
   - `absoluteUrl()` strips localhost/127.0.0.1/private dev hosts; generated public URLs use `siteOrigin()` (`https://matrix.thamjj13.top`).

6. **Success screen lacked deployment truth**
   - `DeploySuccessPopup` now shows project title, deployment ID, live URL, environment/hosting status, file count, timestamp, view/details/assets/rollback actions.
   - It only renders for a succeeded run with a live URL.

## Mandatory Phase 14 cases

`tests/mandatory-repair-cases.test.ts` contains 20 named cases:

1. Normal Chat cannot execute Agent work.
2. Coding Assistance renders code blocks with Copy/Download.
3. Agent execution writes workspace files, not chat source dumps.
4. Project files persist across reload.
5. Conversation context carries active project.
6. Empty builds rejected with `NO_FILES`.
7. Build errors captured on run.
8. Repairs change stored files and produce diffs.
9. Build artifacts generated from contents.
10. Preview sandboxed and mobile-capable.
11. Public URLs canonical.
12. Localhost/private URLs not exposed.
13. Published sites serve real uploaded content.
14. Failed deployments report failure without live link.
15. Ownership enforced.
16. Editor persists via RPC, not localStorage.
17. ZIP export contains actual files.
18. Rollback restores snapshot and re-verifies.
19. Secret-looking public env keys refused.
20. Deployment success requires HTTP verification before live.

These are supplemented by the existing 623 tests (71 files total).

## Security verification

Verified by tests/smoke:

- Cross-origin session deletion returns HTTP 403.
- Unauthenticated protected APIs return HTTP 401.
- Project ownership rejects foreign reads/writes.
- Public static env rejects secret-looking keys (`API_SECRET`, `STRIPE_TOKEN`, etc.).
- Published/preview HTML uses CSP sandbox to force opaque origin.
- Code answers are escaped; raw HTML is not injected as trusted markup.
- Agent checkpoints/completion cannot be fabricated through browser RPC.

Known remaining security work:

- `ToolRegistry.authorize()` still accepts any non-empty `approvalId`; real approval records are not implemented yet.
- Framework builds requiring npm/bundlers/server runtimes are not executed in an isolated runner. The static host refuses unsupported framework projects instead of pretending to compile them.
- Full authenticated production penetration testing was not performed in this sandbox.

## Architecture after repair

```text
Chat request
  ├─ General/Code -> /api/ai -> conversation only; code blocks rendered safely
  └─ explicit Agent + build intent -> /api/build
        -> agent_tasks (durable task, server-written state/checkpoints)
        -> build_runs (stage machine, logs, validation, cancellation)
        -> projects/{id}/files (transactional, revisioned)
        -> DeploymentProvider
             ├─ matrix-static: stage -> HTTP verify -> published_sites live
             └─ Vercel provider preserved when configured
```

Important collections/routes preserved:

- `projects/{id}/files`, `projects/{id}/versions`
- `agent_tasks/{id}/checkpoints`
- `build_runs/{id}`
- `deployments/{id}/files`
- `published_sites/{slug}`
- `/s/{slug}/{path}` public hosting
- `/api/projects/{id}/preview` sandboxed authenticated preview

## Environment inventory

Public/client:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_APP_URL` (public origin; `siteOrigin()` falls back to `https://matrix.thamjj13.top`)

Server/service:

- `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` or Application Default Credentials
- `OPENROUTER_API_KEY` (coding/Agent routing)
- `GROQ_API_KEY` (general chat)
- `TOGETHER_API_KEY` (image generation, optional)
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `IDENTITY_PEPPER`
- `ADMIN_BOOTSTRAP_KEY`
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN_ENCRYPTION_KEY`, `GITHUB_OAUTH_CALLBACK_URL`
- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_APPS_DOMAIN` (optional hosting integration)
- Automation worker secret / device pairing / runtime AI key encryption settings from prior hardening remain server-side.

No secret values are committed. `.env.example` remains the place for placeholders.

## Deployment verification evidence and limits

Evidence available here:

- Production Next.js build passes.
- Local production server starts and serves the app.
- Browser smoke passes desktop/mobile and honest auth/CSRF/worker states.
- Unit/integration tests prove staging/verification/rollback logic and URL sanitization.

Not claimed:

- No deployment to `matrix.thamjj13.top` was performed from this sandbox.
- No authenticated live AI generation, build, publish, rollback, or custom-domain DNS verification was exercised against production services.
- The sandbox does not have production Firebase/AI/Vercel credentials, so `/api/health` correctly reports unavailable local services.
- Flutter/native compilation and hardware integrations remain unverified backlog.

## Manual setup required for full production operation

1. Provide real Firebase web + Admin credentials.
2. Configure at least one general AI provider and one coding provider.
3. Set `NEXT_PUBLIC_APP_URL=https://matrix.thamjj13.top` (or rely on canonical fallback).
4. Configure Cloudinary if image uploads are required.
5. Configure Vercel token/team/apps domain if using the preserved Vercel hosting integration.
6. Configure GitHub OAuth + token encryption key for repository push.
7. Run automation worker with its secret if scheduled automations are required.
8. Verify custom domains through the existing DNS challenge flow before treating them as active.
9. Perform an authenticated end-to-end publish and confirm the public URL/assets over HTTP from the production network.

## Backlog not completed in this repair

- Real tool-approval records and approval UI.
- Isolated framework build runner (npm/bundler/server runtime) with resource limits.
- Voice, MQTT/ESP32/Home Assistant, Family email/consent, screen sharing, Web Push/Tauri, admin health probes.
- Full production end-to-end verification with real credentials.
