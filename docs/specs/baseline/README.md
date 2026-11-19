# As-built baseline specifications

These documents describe **what the repository actually contains** on
2026-11-19. They are reference baselines for the Spec-Driven Development
workflow, not feature specs produced by `/speckit.specify` and not a claim of
production acceptance. New features get their own artifacts under `specs/`
when `/speckit.specify` runs.

## Status vocabulary

| Label | Meaning |
|---|---|
| **Implemented (source)** | Code and behavior exist in this checkout and are covered by local tests where noted. It does not prove live credentials, hosting, devices, or third-party delivery. |
| **Partial** | A bounded subset is implemented; explicit limitations are listed. |
| **Planned** | Roadmap/design intent only. Never treat as a production capability. |
| **Deprecated / legacy** | Retained for compatibility or historical reasons; not the preferred path for new work. |

Every section names its evidence (source path or document). When a document in
the repository disagrees with source code, source code wins and the discrepancy
is called out.

## Baseline areas

1. [Core architecture](01-core-architecture.md) — Next.js App Router, Firebase, API boundaries.
2. [Multi-model AI routing](02-multi-model-routing.md) — registry, catalogs, pool, fallbacks.
3. [In-house agent orchestration](03-agent-orchestration.md) — planning, execution, checkpoints.
4. [Tool Gateway and permissions](04-tool-gateway-permissions.md) — registry, risk tiers, approvals, audit.
5. [Retrieval-augmented generation](05-rag.md) — token-overlap retrieval and trusted sources.
6. [Authentication and sessions](06-auth-sessions.md) — Firebase identity, cookies, RBAC, device session.
7. [Cross-platform desktop and Android](07-cross-platform.md) — Tauri 2 shell, Flutter apps, native limits.
8. [Voice input and assistant](08-voice-assistant.md) — dictation, hands-free mode, TTS, wake word.
9. [Workspace and project management](09-workspace-projects.md) — files, revisions, preview, publish, export.
10. [Deployment, testing, and release](10-deployment-testing-release.md) — hosts, scripts, test gates, open work.

## How to use these baselines

- Read the relevant baseline before writing a new spec so the new requirement
  states what changes instead of re-describing the system.
- Copy behavior statements into a new feature spec only when the behavior is
  intended to remain unchanged; express it as a compatibility constraint.
- Update a baseline when source behavior changes in the same pull request.
- Keep planned capabilities in the "Planned" subsection. Do not promote them
  without implementation and verification evidence.
