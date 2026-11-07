# MATRIX security audit

**Date:** 2026-11-07
**Branch:** `arena/7e13bf1b-matrix-ai`
**Scope:** Repository-level code review and automated tests. This is not a penetration test, production certification, or proof that deployment configuration is secure.

## Security controls present in source

- Firebase Admin verifies sessions/tokens; cookie-authenticated session is httpOnly and same-site; explicit invalid bearer credentials do not silently fall back to cookies.
- Route handlers independently authenticate and apply role, ownership, family-membership or device-scope checks where implemented; admin authorization is server-side.
- Central mutation-origin/Fetch-Metadata guard exists and is used by protected mutation handlers. Native bearer clients can omit Origin but still need authentication/authorization.
- Firestore client rules default-deny writes; server Admin SDK is the privileged write path.
- Device QR pairing challenges are short-lived and single use; device access credentials are hashed at rest, scoped, expiration-checked and revocable on each API verification.
- Family invitation tokens are hashed/expiring/transactionally consumed in the server flow; outbound email is an optional Resend integration.
- Runtime AI/GitHub secrets have server-only storage paths; provider keys are encrypted where the configured key-encryption support is available. Do not downgrade to plaintext or return secrets to clients.
- Project paths/content are validated; project preview uses a restricted/sandboxed rendering context; markdown/code rendering escapes untrusted content.
- Upload signatures and type/size validation are server-mediated.
- Static deployment and URL logic reject local/private public links and perform verification before marking deployment live.

## Current audit findings and required actions

| Severity | Finding / state | Action |
|---|---|---|
| High | Arbitrary generated code is not an isolation boundary; the web server does not provide a general sandbox | Keep arbitrary backend/framework execution disabled until a separate sandboxed worker has CPU, memory, filesystem, network, time and output limits, and explicit approval policy |
| High | Admin-configurable compatible provider endpoints are a server-side egress surface. URL validation rejects obvious local/private literals, but cannot guarantee DNS answers remain public or prevent DNS rebinding | Restrict outbound egress at infrastructure level, deny link-local/metadata/internal destinations, disable redirects (already used in compatible provider transport), and consider a controlled provider allowlist/resolver-pinned transport before allowing untrusted admins |
| High | Production authorization and authentication flows lack live end-to-end evidence in this sandbox | Run staging tests with separate ordinary/admin/family accounts; inspect Firestore rules with emulators; perform authorized security review before release |
| Medium | Process-local/request-log rate limits are not equivalent to globally coordinated quotas across instances | Use a shared, atomic limiter for expensive AI, upload, pairing, OTP, invitation and job endpoints; confirm abuse ceilings and cost alerts |
| Medium | A provider integration can be configured, but model catalog/availability is account-specific | Never show a model as usable without live account-level validation; store and display exact health timestamp/error; verify official model and quota pages before documenting limits |
| Medium | Google OAuth, email verification, admin OTP delivery, Resend delivery, and reset flows cannot be proven without credentials | Configure separate staging providers, enforce verified claims and OTP expiry/attempt limits, monitor delivery and audit outcomes |
| Medium | Session inventory/revocation semantics need real-browser and native-client review | Ensure each session/device row maps to an actual credential; revoke server-side on logout/unlink and accurately explain local-only sign-out where appropriate |
| Medium | Worker operation depends on deployment controls not enforced by source alone | Keep `AUTOMATION_WORKER_SECRET` strong and private; restrict job endpoint to authenticated worker; use HTTPS, observability, bounded batches, separate least-privilege identity and alerting |
| Medium | Public origin is an operational security boundary | `siteOrigin()` is configuration-based (not Host-derived), normalizes to URL origin, rejects production HTTP and obvious local/private/internal targets. Confirm canonical domain and TLS at deployment; DNS names still need network-level trust controls |
| Medium | Child telemetry and screen capture are not supported by ordinary web permissions | Do not add hidden collection; build only explicit native permission flows with visible active state, audit events, revocation and data minimization |
| Medium | Backups, restore drills, retention and incident response cannot be verified from a source-only test run | Configure Firestore export/retention, encrypt backups, test restore in staging, document owner and recovery targets |

## Prior hardening items checked in current source

Some historical audit notes no longer describe current source. Current code includes revocable device credentials (`src/lib/firebase/device-session.ts`), shared mutation CSRF helper (`src/lib/server/request-security.ts`), secret encryption helpers, device scopes, canonical URL helpers and durable automation claims. These controls still require operational verification; old findings should not be repeated as current defects without reproduction. This audit's URL resolver repair adds tests for HTTPS, path normalization, credentials and non-public host rejection.

## Verification completed

- `npm run typecheck`: passed with the URL-origin change.
- `npm test -- --reporter=dot`: 72 files / 651 tests passed with the URL-origin and worker-target regressions.
- Tests include CSRF origin checks, role/admin permissions, device credential revocation, pairing replay/expiry, tool approval, project ownership and public URL/deployment validation.
- No production database, secret, authenticated account, OAuth, email, deployment token, native device or physical hardware was accessed.
- Re-run complete tests after changes; passing unit tests are not a penetration test.

## Security boundaries

MATRIX must never implement stealth screen capture, hidden browsing-history collection, OS permission bypass, unrestricted child monitoring, permanent credentials in QR payloads, arbitrary generated code execution inside the Next.js process, or user-supplied secrets pasted into ordinary chat. Privileged mutations must be server-authorized. Screen sharing and native telemetry must remain visible and revocable.
