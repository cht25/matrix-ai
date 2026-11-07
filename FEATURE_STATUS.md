# MATRIX feature status

Baseline: 2026-11-07, commit `f65ad24`. **Source present** does not mean production verified. Unit tests passed at baseline (587); authenticated live workflows were not accessible.

| Module | Frontend | Backend / persistence | Actual baseline status |
|---|---|---|---|
| Authentication | Email, Google, Facebook, MFA UI | Firebase Auth, cookie/bearer verification | Implemented; live login and passkey support not verified; no WebAuthn implementation found |
| Navigation | Desktop sidebar / mobile bottom bar | Route guards | Working routes, hierarchy does not match requested order; duplicate Workspace labels |
| Chat/history | Streaming chat, history, temporary chat, attachments | AI gateway / Firestore conversations/messages | Implemented; live provider/account workflow not verified here |
| Providers/models | Admin compatible endpoint; lane selector | Groq/OpenRouter/compatible adapters | Partial: no complete model catalog, no user model-ID selector, agent test can probe wrong model |
| Voice | Speech recognition/TTS controls | Browser APIs | Partial; site Permissions-Policy blocks microphone; no wake-word/tool execution |
| Agent | Workspace/tools/checkpoints | Tool registry/gateway/task records | Partial: tools mostly reads, no general isolated code worker/durable queue |
| Website builder | Project editor/preview/deploy UI | Generated files, static validation/build, GitHub/Vercel | Partial: not full-stack app execution or database provisioning; deployment needs credentials |
| Canvas | Project-file wrapper | Canonical projects/files | Not the requested visual canvas; underlying project persistence exists |
| Automations | Single-tool form/run/pause | Firestore/tool execution | Partial: manual execution only; no scheduler, event dispatch, visual workflow or production side-effect tools |
| Home Assistant/ESP32 | Absent | Absent | Not implemented; broker/hardware required for acceptance |
| Family | Create/invite/QR/roles | Firestore transactions / Resend submission | Implemented in source; delivery/live joining unverified; supervision features absent |
| Connect devices | Web/Flutter registry and pairing | Signed challenges / Firestore devices | Partial: account mismatch already guarded; credentials/scopes/revocation not enforced |
| Screen sharing | Absent | Absent | Not implemented; no fake control should be added |
| Notifications | Bell/read state | Firestore notifications | Partial: in-app only, no push transport/delivery tracking |
| Files | Cloudinary images, text attachments | Signed uploads/validation | Implemented in source; live storage not exercised |
| Learning/safety/admin | Courses/quizzes/certificates/scams/reports/admin | Firestore/RBAC/PDF | Extensive existing implementation; preserve, no claim of exhaustive live verification |
| Desktop | Absent | Website reusable | No Tauri shell |
| Deployment | Hosting manifests/CI templates | Firebase/Render/Node options | Production public page reachable; exact commit/private config unknown; CI templates not active workflows |

## Baseline acceptance gaps

No physical device acknowledgement, real email delivery, screen stream, native build, production deployment/rollback or authenticated account synchronization has been demonstrated in this workspace. Full production acceptance remains open. Changes in this branch are tracked with explicit test evidence rather than converting this table to green based on UI presence.
