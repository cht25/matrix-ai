# Self-healing build, continuation and deployment

## Validation
Files are checked with real parsers, not pattern matching: an HTML tokenizer
(`src/lib/deploy/analyze/html.ts`), acorn for JavaScript and postcss for CSS
(`analyze/code.ts`). Project-level checks cover missing scripts, stylesheets,
assets and broken internal links (`validate.ts`). TypeScript/JSX is reported as
*not verified* because no compiler runs in the build.

## Repair
`runRepairLoop` (`src/lib/deploy/repair.ts`):
1. Deterministic repairs first (unclosed tags, missing closing brackets,
   leftover Markdown fences). No model call.
2. Model repairs receive only the files that have a problem, with
   `path:line — message` for each.
3. Every candidate is validated before it is applied and kept only if the
   number of errors goes down. A rejected attempt is described to the model in
   the next request.
4. Stops when clean, after the attempt limit (4 per session, up to 8 with
   `max_fix_attempts`), after two attempts without progress, at the time limit,
   or when the provider is unavailable.

A restore point ("Before automatic repair") is saved before files are changed.

## Publish decision
`deployVerdict` (`classify.ts`) separates blockers from known issues. A site
with only non-critical problems (a broken internal link, a missing image) is
published and the issues are recorded on the deployment
(`validation_status: passed_with_issues`). A site with a blocker is not
published and the blocker is shown.

## Continuation
A run that reaches its time limit or loses the provider becomes `paused`; its
files, repair history and chat message are kept on `build_runs/{id}`. It is
continued by `POST /api/build {"resume_run_id": "…"}` — automatically by the
open page, by the Continue / Retry publish button, or by the maintenance job.
A run can be continued at most 6 times (`CONTINUATION_LIMIT`), and only one
continuation can hold the run at a time (`ALREADY_RESUMING`).

## Deployment verification
Staged release → HTTP check with a verification token → activation → HTTP
check of the public address without credentials (entry page, up to 30 further
pages, up to 60 assets). If the public check fails, the previous release is
restored and the deployment is marked `DEPLOY_VERIFY_FAILED`; with no previous
release the address stays offline.

## Execution sessions
Each build segment records a session in `execution_sessions`, compares a digest
of the files it produced with project storage, and releases the session.
`POST /api/jobs/maintenance` releases sessions silent for 10 minutes.
The only gateway is the in-process one (`matrix-inline`): builds run inside the
web server. `setExecutionGateway` is the integration point for an external
sandbox service; none is integrated.

## Groq accounts
See `.env.example`. Status per account is visible in Admin → AI → Provider
accounts. Rotation stays within each account's own limits.

## Tests
`tests/self-healing.test.ts` runs the workflows end to end against a simulated
Groq API and the real public-site route handler. No test calls a live provider.
