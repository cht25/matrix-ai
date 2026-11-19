# Baseline 10 — Deployment, testing, and release management

**Status:** Partial — deployment configuration, local validation scripts, and
a broad Vitest suite exist in source. No production deployment or release
artifact was produced as part of this baseline.

**Evidence:** `package.json`, `vitest.config.ts`, `firebase.json`,
`apphosting.yaml`, `render.yaml`, `DEPLOYMENT_GUIDE.md`,
`docs/ci/{web-verification.yml,android.yml}`, `scripts/`, `tests/`,
`FEATURE_IMPLEMENTATION_STATUS.md`, `IMPLEMENTATION_ROADMAP.md`.

## Implemented behavior

- `package.json` defines `dev`, `build`, `start`, `typecheck`, `test`,
  `test:watch`, `test:browser`, emulators, seed/admin/role scripts, Tauri
  commands, native frontend build/check, and Android init/build scripts.
- Hosting targets: Firebase App Hosting (`apphosting.yaml`), Firebase hosting
  + frameworks backend (`firebase.json`), a Render blueprint (`render.yaml`),
  and Vercel/GitHub adapters for projects. Environment variables are public
  client config or server secrets; no secret values are committed.
- Firestore rules, indexes, and storage rules deploy with
  `npm run deploy`. Emulators run Auth, Firestore, and Storage locally.
- TypeScript strict mode, Vitest, and a production Next.js build are the
  documented local gates. Native frontend changes have `npm run native:check`.
  `docs/ci/web-verification.yml` and `docs/ci/android.yml` are ready CI
  workflows but are not active in `.github/workflows/`.
- Release documentation separates source-level implementation from verified
  live behavior: provider accounts, email/OAuth apps, push keys, devices,
  hardware, and staging deployment remain operator prerequisites.

## Boundaries and non-goals

- A passing unit suite does not prove third-party credentials, production
  hosting, device behavior, or hardware.
- Full Windows/Android release builds are not run for documentation-only
  changes.
- Rollback and recovery drills are release-gate documentation, not automated
  tests.

## Partial / planned / deprecated

- **Partial:** no generated OpenAPI contract, no active CI workflow in this
  repository, and no staging/production deployment performed here.
- **Planned:** documented release gates for staging verification, backup
  restore, penetration review, and device matrix are outstanding.
