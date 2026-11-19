# Baseline 09 — Workspace and project management

**Status:** Partial — persisted file-based projects, revisions, preview,
publishing, ZIP export, canvas, and GitHub/Vercel adapters exist. General
backend hosting and database provisioning are not implemented.

**Evidence:** `src/lib/server/{projects.ts,build.ts,agent-tasks.ts,canvas.ts,deploy.ts,github.ts,vercel.ts}`,
`src/lib/projects/{paths.ts,bundle.ts,preview.ts,zip.ts}`,
`src/lib/deploy/`, `src/app/(app)/{projects,workspace,canvas,design}/`,
`src/app/api/projects/[id]/preview/[[...path]]/route.ts`,
`src/app/api/projects/[id]/zip/route.ts`, `src/app/s/[slug]/`,
`tests/{project-workspace-persistence.test.ts,project-paths.test.ts,project-preview-route.test.ts,canvas-persistence.test.ts,deploy-*.test.ts}`.

## Implemented behavior

- Projects are Firestore documents under `projects` with owner checks; text
  files live in project file subcollections with revisions. Paths are
  constrained by `assertSafeProjectPath` and project limits, and names are
  slugified per language.
- `POST /api/build` starts bounded build runs with stored stages and results.
  Static sites are validated, previewed through an authenticated route, and
  can be published at `/s/<slug>` from Firestore-backed assets.
- `siteOrigin()` uses only validated `NEXT_PUBLIC_APP_URL` configuration,
  reduced to a parsed origin; request Host/forwarded headers are never used to
  construct public URLs. Unsafe or missing configuration falls back to a
  documented production origin.
- ZIP export bundles project files; `src/lib/deploy/` contains validation,
  classification, repair, status, verification, and provider adapters including
  GitHub and Vercel. Publishing/pushing requires operator credentials and
  approval.
- Canvas is a persisted workspace/project file interface with autosave and
  revision checks. It is not a full visual editor with independent document
  versioning lifecycle.
- GitHub OAuth connection, repository listing, review-before-push commits, and
  Vercel deployment status are server integrations with real credential
  requirements; missing credentials yield honest configuration errors.

## Boundaries and non-goals

- Generated backend code is not executed in the web process. There is no
  general persistent database provisioning or universal backend runtime.
- Preview is authenticated; `/s/<slug>` is the public static publish path.
- A configured origin alone does not prove DNS or hosting readiness.

## Partial / planned / deprecated

- **Partial:** canvas, design, and deploy adapters are source-complete subsets
  of the larger product vision; see `FEATURE_IMPLEMENTATION_STATUS.md`.
- **Planned:** full-stack generation with real migrations, rollback, and
  self-healing patches is roadmap work.
