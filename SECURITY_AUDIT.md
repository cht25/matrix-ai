# MATRIX security audit

Date: 2026-11-07. This is a repository-level review, not a penetration test or production security certification.

## Existing protections

Firebase signature/expiry/revocation verification; httpOnly SameSite=Lax session cookie; explicit bearer failures do not fall back to cookies; server-only provider credentials; default-deny Firestore writes; Zod validation on major RPC actions; owner/family/RBAC checks; hashed short-lived invitation tokens; transactional invitation/pairing consumption; GitHub token encryption; sandboxed static project previews; escaped Markdown/HTML boundaries; upload validation; audit/security records.

## Findings

| Severity | Finding | Required remediation |
|---|---|---|
| High | Device unlink does not revoke the underlying Firebase credential; scopes are cosmetic | Bind paired clients to a revocable server-side credential/session and enforce scopes; clearly distinguish registry removal from account logout |
| High | Cookie mutation Origin/CSRF checks are inconsistent | Central same-origin enforcement on all cookie-authenticated unsafe methods; retain bearer authentication for native clients |
| High | Admin-configurable provider URL accepts arbitrary HTTP hosts | Restrict protocol/host policy and redirects; protect cloud metadata/internal targets; validate models against the account catalog |
| High | Agent/builder is not an arbitrary-code isolation boundary | Keep static sandbox restrictions; require a real isolated worker before executing generated backend code |
| Medium | Saved AI provider key is plaintext in server-only Firestore | Encrypt with a managed server key and preserve/decrypt existing records during migration |
| Medium | `ensureUserDocuments` resets security/privacy preferences to defaults on every mint | Preserve existing settings; initialize only missing fields |
| Medium | Session rows are not bound to credentials; session deletion only clears local cookie | Bind/revoke actual session records and describe local sign-out accurately |
| Medium | Several development/deployment guards are permissive | Restrict dev origins; do not expose development mock transports in production; add frame/content security policy compatible with intentional previews |
| Medium | Microphone policy contradicts the voice UI | Permit self microphone access, request only after a user gesture, handle denial and stop tracks/recognition reliably |
| Medium | Public content/family rules need tighter publication/active-membership checks | Review and emulator-test rules before deployment |
| Medium | Limits are often process-local | Use durable/shared limits for expensive endpoints and workers; do not claim global rate limiting across instances |

## Explicit non-goals / safety boundaries

No covert screen capture, hidden browser-history collection, OS permission bypass, permanent tokens in QR codes, credentials requested in chat, or client-exposed service-role secrets. Screen sharing must be initiated and visibly controlled on the shared device. Child safety requires transparent consent and OS-supported APIs. Device location and usage access must be independently revocable.

No live exploitation, production privilege testing, OAuth delivery, native permission testing or hardware assessment was performed. Security acceptance remains open until those checks run in staging with authorized test accounts.
