# MATRIX implementation roadmap

## Operating rules

Preserve the existing Next.js/Firebase architecture and accounts. Work in tested increments on the session branch. No production deployment without staging verification and explicit approval. No feature marked complete from UI alone. External credentials stay in deployment secret management. Missing integrations report configuration errors, never fabricated success.

## Tranche A — repair foundations (current implementation priority)

1. Central mutation-origin protection and privacy-preserving session initialization.
2. Correct microphone policy; preserve manual voice fallback and document browser limits.
3. Server-verified provider/model catalog, correct agent health probe, remove unverified model defaults, expose a real model selector and `/models` route.
4. Requested desktop/mobile navigation and restrained electric-blue/emerald theme.
5. Visual Canvas backed by Firestore, autosave with revision conflict detection, versions/import/export.
6. Durable automation scheduling primitives, authenticated worker entry point, real notification action, execution history; deploy worker separately.
7. Regression tests, typecheck, production build, API/environment/integration documentation.

## Tranche B — identity and physical devices

- Device-bound credentials and revocation enforcement across web/native/API/tool paths; safe migration for existing paired rows.
- Flutter account identity, lifecycle and synchronization fixes; compile/test with Flutter/Android SDK.
- MQTT TLS backend, device registration/provisioning, command acknowledgement protocol, room/group dashboard and ESP32 firmware.
- Home Assistant integration using operator-configured credentials; test against a real isolated broker/hardware or Home Assistant instance.

## Tranche C — execution and deployment

- Isolated code runner and durable agent queue with cancellation, checkpoints, tool approvals and budgets.
- Full-stack generation with PostgreSQL/Supabase/Turso/SQLite adapters, actual migrations/auth/CRUD/tests.
- Secure GitHub/Vercel/database OAuth, environment management, preview/approval/deploy/verify/rollback workflow.
- Self-healing patches in isolated workspaces; never modify production without approval.

## Tranche D — family, sharing and native clients

- Family device permissions, transparent usage/screen-time summaries and revocable safety policies.
- Explicit WebRTC screen-sharing sessions, signaling/TURN, Android MediaProjection producer and visible stop controls.
- Resend delivery events/retry worker; unified Web Push/Android/desktop notification delivery.
- Tauri desktop shell and verified native permissions; wake-word support only on capable devices, with honest background/power limitations.

## Release gates

Each increment requires reproducible install, unit/contract tests, relevant emulator/integration tests, typecheck/build and documented limitations. Production acceptance additionally needs real provider accounts, email sender, OAuth apps, broker/ESP32 hardware, Android/Windows devices, push keys and staging deployment access. These are manual prerequisites, not reasons to substitute mocks in production.
