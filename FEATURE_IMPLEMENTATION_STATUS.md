# MATRIX feature implementation status

**Status date:** 2026-11-07. “Implemented” means source exists; it does not imply live production verification. Tests in this checkout are mostly unit/contract tests and do not establish third-party credentials or physical hardware behavior.

| Area | Repository status | Verification / remaining work |
|---|---|---|
| Primary website | Implemented: Next.js App Router; public, auth, app and admin routes | TypeScript + unit suite; no production deployment performed |
| Responsive navigation | Implemented: desktop app shell and mobile navigation | `tests/mobile-navigation.test.ts`; real device/browser matrix still needed |
| Authentication | Partial: Firebase email/password and OAuth UI/session routes; server session verification | No live email, Google provider, reset, or authenticated production workflow verified; mandatory email verification and admin OTP behavior require end-to-end staging review |
| Admin | Partial: separate app admin layout, server role checks and setup/API modules | No live admin account/OTP delivery exercise; confirm `/login/admin` route requirement and OTP integration before acceptance |
| Chat/history | Implemented in source: persistent conversations/messages, streaming gateway, history and attachments | Provider call tested with local HTTP stubs; real configured account and image/document/voice paths not end-to-end verified |
| Chat voice | Partial: browser speech controls/TTS interfaces | Browser recording/transcription/upload and spoken response must be verified end-to-end on supported browsers; wake word/background listening is not implemented |
| AI providers | Partial: Groq, OpenRouter, OpenAI-compatible, Gemini-compatible endpoint, Anthropic Messages API, and Ollama-compatible endpoint; routing, streaming, model catalog/health/error handling | Credentials/model IDs and account entitlements are unverified; Gemini quota depends on project, model and tier; no universal daily quota is claimed |
| Agent | Partial: modes, tool registry/gateway, approvals, durable tasks, project build workspaces and logs | Not a general autonomous isolated coding worker; tool set is constrained; no arbitrary framework/backend execution |
| Website builder | Partial: file-based project creation/editing, static build validation, project persistence, preview/publish/deploy verification | No generated persistent database provisioning or general backend runtime; Vercel/GitHub require credentials and live verification |
| URL/preview repair | Implemented in source: centralized canonical origin, persisted file-based preview, public `/s/<slug>`, deployment verification path | Regression covered by `tests/site-origin.test.ts`, URL/deployment tests; public production URL and external host reachability not verified here |
| Canvas | Partial: persistent workspace/project file interface | Not full visual canvas/diagram editor with independent document versioning/sharing/export lifecycle |
| Family | Partial: family records, roles/invitations/QR/email adapter present | Resend delivery, accepted invite lifecycle and account authorization need staging integration test; no covert monitoring |
| Devices pairing | Implemented for account device pairing: expiring signed challenge, same-account check, hashed/revocable scoped device credentials | Contract tests exist; no physical ESP32 pairing or hardware enrollment |
| Family/child device telemetry | Not implemented | Requires transparent Android companion and explicit OS permission; ordinary web cannot access complete installed apps/usage/history |
| ESP32 smart home | Not implemented | No embedded source/MQTT adapter/physical pairing/IR/OTA. Requires firmware, secure broker and hardware tests |
| Automation | Partial: scheduled records, timezone calculation, leases, history, worker API/script | Worker must be separately deployed and configured; non-schedule event dispatch and device actions not available unless tools are present |
| Screen sharing | Not implemented | Requires consented WebRTC/native capture signaling/session components; no hidden capture |
| Notifications | Partial: in-app notification records/UI | No proven Web Push/Android push transport or delivery worker |
| Tauri desktop | Not implemented | No Tauri shell/native notification/tray/screen-capture integration |
| Mobile companion | Partial: legacy Flutter phone/Wear source | Build/device tests not run; not equivalent to authorized parental-management companion |
| Security | Partial: server auth/RBAC, CSRF helper, input validation, encrypted token/key paths, default-deny Firestore patterns | Repo review and unit tests only; no staging penetration test or real multi-account integration test |
| Deployment | Partial: Firebase/App Hosting/Render configuration, static hosting and Vercel adapter | No production deployment; exact platform secrets, custom DNS and rollback verification are environment-specific |
| API documentation | Partial: route code/comments and repository docs | A single generated OpenAPI contract is not present |
| Automated tests | Implemented broad Vitest suite (72 files, 651 tests passed in this audit) | External-service integration, real accounts, browsers/devices, native builds and hardware remain unverified |

## Test evidence

Commands run for this audit:

- `npm ci --no-audit --no-fund` — passed.
- `npm run typecheck` — passed with the public-origin safety repair.
- `npm test -- --reporter=dot` — 72 files / 651 tests passed with the public-origin and worker-target regression coverage.
- `npm run build` — production Next.js build completed successfully.

A passing unit suite must not upgrade external-credential, platform, production or hardware status to “verified.”

## Release blockers for the full requested ecosystem

1. Configure and run authenticated staging workflows for registration/email verification, Google OAuth, admin OTP, chat providers, Resend invitations and deployment.
2. Implement and security-test any missing provider adapters only against official provider catalog/quota information.
3. Build a resource-limited isolated runner before enabling arbitrary generated builds or backend execution.
4. Implement the required native desktop/mobile and embedded components as separate consented integrations; verify on real devices and hardware.
5. Deploy/monitor the automation worker and validate retries, leases and alerting.
6. Complete staging security review, backup/recovery drill, deployment rollback, and mobile/tablet/browser matrix before production release.
