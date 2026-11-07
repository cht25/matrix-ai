# MATRIX architecture

## Source-of-truth architecture (audited baseline)

```text
Responsive Next.js website ── Firebase client Auth ── POST /api/auth/session
          │                                                │
          │ httpOnly __session cookie                      ▼
          ├── Server components ─────────────────── Firebase Admin Auth
          ├── /api/rpc ── Zod + ownership/RBAC ───── Firestore (canonical)
          ├── /api/ai ── safety/context/routing ─── Groq / OpenRouter / compatible API
          ├── /api/agent/tools ── tool gateway ──── registered server tools
          ├── projects/build/deploy ─────────────── project files / static preview
          └── upload signature ─────────────────── private Cloudinary assets

Legacy Flutter clients ── Firebase ID token bearer ── same Next.js API
GitHub OAuth / Vercel token ── server integrations ── external services
```

The website, not Flutter, is the primary product. The edge middleware performs routing-only cookie checks; every privileged API must verify authentication independently. Firestore rules default to deny and generally permit owner reads, not browser writes. `/api/rpc` preserves a `{success,data,error}` envelope. SSE is the existing chat transport.

## Principal boundaries

1. **Identity:** Firebase UID is canonical. Email display labels are not authorization keys. Family role is separate from administrative RBAC.
2. **Persistence:** Firestore documents/subcollections, server writes, timestamps at storage and ISO timestamps at API boundaries. Optimistic concurrency/transactions protect competing mutations.
3. **AI:** Provider adapters implement a common transport. Model selection must resolve against a server-known, account-verified catalog; credentials never enter client bundles. Provider fallback must be explicit and must not turn a failed action into a successful answer.
4. **Execution:** Model output is data, not authority. Tools revalidate arguments and authorization. Side effects require explicit approval/consent. Generated untrusted code must not run in the Next.js server process.
5. **Devices:** MATRIX Connect account devices and physical MQTT actuators are different entities. A paired phone is not an ESP32. Hardware state becomes confirmed only after an authenticated device acknowledgement.
6. **Workers:** Browser timers are not a production scheduler. Durable due records and leased claims belong in Firestore; a separately deployed authenticated worker executes them. Scale-to-zero web hosting alone cannot guarantee scheduled execution.

## Target extensions (not claims of baseline completion)

- A provider/model registry with live catalog verification and authenticated user-facing model descriptors.
- Durable automation leases, execution history and notification/device actions; an independently deployed worker.
- Visual canvas documents and version snapshots in Firestore, with revision checks and import/export.
- Device-bound credentials with revocation checked on every authenticated request; existing Firebase login remains the account identity provider.
- MQTT TLS adapter, per-device credentials/ACLs, command acknowledgements and ESP32 provisioning firmware.
- Explicit-consent WebRTC sharing with short-lived signaling and native MediaProjection producer; no hidden capture.
- Tauri shell around the responsive website, with native capabilities added only where permissions and APIs permit.

Architectural slots are not represented as functional navigation destinations until implemented. Detailed release order and external prerequisites are in `IMPLEMENTATION_ROADMAP.md`.
