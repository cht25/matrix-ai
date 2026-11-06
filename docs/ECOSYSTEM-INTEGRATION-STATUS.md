# MATRIX ecosystem integration — verified scope

Date: 2026-11-06. Baseline: `11e44d4`. This document supersedes assumptions in the historical architecture audit, not its implementation history.

## Scope and preservation

The existing application is Next.js 15 / React 19 with Firebase Auth, Firestore, server-side RPC, Cloudinary uploads, AI provider routing, project files/versioning, agent checkpoints and deployment integrations. The mobile directories contain Flutter; they were **not extended**. There is no Tauri client in this change.

No production database was connected, inspected remotely, reset or migrated. Repository schemas, rules, routes, client code and tests were inspected. Existing Firestore collections remain canonical. No second family, conversation or project store was introduced. No production release was performed.

## Implemented in this increment

### Navigation

- Desktop: Canvas joins the primary AI section; Family is visible directly beneath it, before recent history and the collapsible safety tools. Devices and workspaces are also immediately accessible.
- Mobile: Chat, Agent, Canvas, Family, Devices plus More. Existing safe-area padding and modal focus handling remain. The bottom bar hides when an editable field opens a viewport-obscuring software keyboard. Secondary Workspace and Private Workspace remain in More.
- URL query parameters retain Agent and Canvas project selection and support deep links. Only existing authorized routes or the new implemented Canvas route are linked; no mirroring placeholder is advertised.

### Unified device registry defect

`completePairing` previously accepted a scanner signed in as a different Firebase UID, stored the device under the QR owner's UID, then the scanner queried `/api/devices` for its own UID. This is a deterministic code-level cause of the reported discrepancy; the particular production accounts were not accessible for confirmation.

Pairing now requires the same verified Firebase identity on both clients and validates the stored challenge owner. Rejected pairing does not consume the challenge. The UI explains how to correct the account mismatch and refreshes device records on focus, reconnect and a visible-page 30-second interval.

Existing mismatched registry rows are not reassigned automatically. Revoke and pair again under the same account. This is not a device-bound bearer-token implementation: revoking a registry row does **not** revoke a Firebase account/session. Immediate device-scoped access revocation is still an acceptance gap.

### Authentication

An invalid or malformed explicit Authorization header no longer silently falls back to a different cookie identity. Firebase token revocation checks remain enabled for both native bearer tokens and web session cookies. Cookie-only browser requests remain supported.

### Family invitations

- Existing `family_invitations` and `family_members` are reused.
- New invitations expire in 15 minutes. Previously stored expiry timestamps are unchanged.
- Cryptographically random token; SHA-256 hash only in the invitation document.
- QR and email links place the token in a URL fragment, not a query string. The Family UI reads and removes the fragment without accepting automatically.
- Recipient must sign in using the invited email, verified by Firebase. Review shows the family name and child role; a separate explicit Accept action creates membership.
- Acceptance re-reads and consumes the invitation inside a Firestore transaction, verifies the inviter still has active parent membership and prevents duplicate active membership.
- Parents can revoke a pending invitation; transaction conflict handling protects against concurrent acceptance/revocation.
- QR generation uses the existing `qrcode` package. It contains no password or permanent credential.
- Invitation creation/acceptance/revocation remain audited through the backend.

For QR/email review, sign in to MATRIX before opening the invitation, or paste the displayed one-time code after sign-in. Retention of invitation fragments through every external sign-in redirect is not verified.

### Resend

`src/lib/server/family-email.ts` is server-only. Configure through deployment secret management (never commit values):

```
RESEND_API_KEY=<deployment secret>
RESEND_FROM_EMAIL=MATRIX <verified-sender@your-domain>
```

The sender's domain must be verified in Resend. The repository had no configured sender to reuse. Email HTML escapes interpolated values; the plain text alternative includes the same disclosure. Requests use a stable idempotency key and bounded timeouts/retries for transient failures. The invitation records `email_status` and provider message ID. `accepted_by_provider` is intentionally **not** labelled delivered.

This increment implements invitation submission only, not a durable retry worker, delivery webhook or the remaining family notification templates. Missing configuration or rejected submission leaves a usable QR/code and displays the real status. Live delivery could not be tested: provider credentials are absent and this environment's network allowlist does not include Resend. There is no new secure admin credential-configuration UI.

### Canvas code/document surface

`/canvas` creates/open documents in the **existing** Firestore-backed `projects` store and uses `ProjectWorkspace` for multi-file editing, sandboxed previews, explicit version snapshots/restoration, export and existing deployment controls. Creation is an explicit button action, not a render side effect. Project ownership checks remain server-side.

This is a code/document canvas, not the requested complete visual canvas. Drag/drop, diagrams, mind maps, a property inspector and selection-aware embedded AI are not implemented. The AI Agent link uses the existing agent workflow; it does not imply direct selection modification.

### Invalid vision model

The invalid `qwen/qwen3.6-27b` default was hardcoded in the Groq vision registry. It has been removed rather than replaced with another guessed ID. Set `GROQ_VISION_MODEL` to an image-capable ID verified against the operator's Groq catalog, or configure the existing admin OpenAI-compatible provider with a verified multimodal model. With neither configured, the scanner has no Groq vision route rather than sending an invented model. No live provider response or catalog availability was verified.

## Product inventory and remaining acceptance gaps

| Area | Repository implementation / current limitation |
|---|---|
| Chat, history | Existing authenticated chat, SSE gateway and Firestore messages preserved; cross-device live verification requires credentials |
| AI Agent / website builder | Existing agent file generation, tasks/checkpoints, project editor, build and deployment modules preserved; not an isolated arbitrary full-stack execution service |
| Agent repair / databases | No new autonomous repair loop, sandbox workers or database provisioning adapters delivered |
| Canvas | Implemented code/document surface above; full visual tools absent |
| Family | Existing create/list/member roles/removal plus hardened QR/email invitation lifecycle; complete supervision dashboard absent |
| Devices | Canonical registry and pairing correction above; device credentials and immediate session revocation absent |
| Screen mirroring | No native MediaProjection producer, consent lifecycle, signaling, TURN or WebRTC viewer implemented |
| Workspace / private workspace | Existing `/workspace`, `/projects`, `/temporary-chat` preserved |
| Courses | Existing courses, lessons, quizzes and certificates preserved |
| Scam library / reporting / images | Existing `/scams`, `/report`, `/scanner` preserved; vision route configuration required |
| Design / comparison | Existing `/design`, `/compare` preserved |
| Profile / settings / security | Existing `/settings`, account/security panels and `/security` preserved |
| Notifications | Existing notification bell preserved; no new full notification center |
| Subscription / usage | Existing usage panel preserved; no new billing/subscription service |
| Integrations / automations | Existing GitHub, Vercel and automation modules preserved; no unified new integration console or new Vercel OAuth flow |
| Tauri desktop / Android | Not implemented. Flutter was not extended. Rust/Cargo, Java and Android device tooling are unavailable in this sandbox |
| Android supervision | UsageStats, foreground services, native secure storage and device-owner restrictions not implemented/tested |
| Production deployment | Next production bundle built locally; native artifacts, live integration delivery, deployment and rollback not verified |

## Verification

- `npm ci --no-audit --no-fund` succeeded.
- `npm run typecheck` passed.
- `npm test`: 587 tests in 61 files passed (including new pairing-account rejection, invitation authorization/expiry/single-use/concurrency/revocation, Resend submission and identity-downgrade regression tests).
- `npm run build` passed; `/canvas` included. Build is repeated before handover after final changes.
- `git diff --check` passed.
- `docs/ci/web-verification.yml` is a CI template for reproducible install, typecheck, tests and build. It is not active: the connected GitHub App rejected workflow creation because it lacks `workflows` permission. An authorized maintainer can install it under `.github/workflows/`.

Invitation transaction tests use a serialized in-memory transaction stub, not the Firestore emulator. These tests do not substitute for emulator contention testing, real email delivery, Android hardware tests or a security audit. No Windows/macOS/Linux desktop or Android builds were run.

**The full ecosystem's 20 acceptance criteria are not met by this PR.** This is an additive, tested web/backend integration increment with explicit limitations, not a production-complete ecosystem or a claim of native functionality.
