# Baseline 06 — Authentication and session management

**Status:** Implemented (source) for Firebase email/password, OAuth UI and
session exchange, server verification, and RBAC primitives. Partial for live
email delivery, Google provider configuration, and admin OTP, which require
operator credentials and staging verification.

**Evidence:** `src/lib/firebase/{client.ts,admin.ts,session.ts,session-shared.ts,device-session.ts,web-config.ts,auth-errors.ts}`,
`src/lib/{auth/oauth.ts,auth/lifecycle.ts,auth/diagnostics.ts,admin-rbac.ts,roles.ts}`,
`src/app/api/auth/session/route.ts`,
`src/app/api/auth/firebase-handler/[[...path]]/route.ts`,
`src/app/api/auth/clear-session/route.ts`,
`src/lib/server/request-security.ts`, `src/middleware.ts`, `firestore.rules`,
`tests/{auth-session-origin.test.ts,auth-lifecycle.test.ts,auth-errors.test.ts,admin-permissions.test.ts}`.

## Implemented behavior

- Firebase Auth is the identity provider; the Firebase UID is canonical.
  Email display strings are labels, not authorization keys.
- `POST /api/auth/session` verifies a fresh Firebase ID token with the Admin
  SDK, creates a signed httpOnly session cookie, and idempotently provisions
  profile/settings documents. `DELETE` clears the cookie. Responses are
  no-store. `GET`/other Firebase handler paths support the auth emulator and
  framework auth flows.
- Server components and route handlers call `getSessionUser` /
  `getApiSessionUser`; each privileged API independently verifies the cookie
  or bearer token. Native clients use the device-session path with scoped
  credentials and revocation checks; they remain subject to route-level
  authorization.
- `POST`, `PUT`, and `PATCH` requests from browsers go through the shared
  Origin/Fetch-Metadata guard (`mutationCsrfResponse`) with a narrow exemption
  for native bearer clients.
- Admin RBAC: `admin-rbac.ts` and `roles.ts` define role checks; the admin
  layout and admin RPC methods verify server-side. Family roles are a separate
  concept from administrative RBAC.
- Firestore rules default-deny browser writes and generally allow owner reads;
  privileged writes use the Admin SDK after ownership/family/RBAC checks.
- Account/device pairing creates expiring QR/typed-code challenges, same-account
  checks, and hashed, revocable scoped credentials (`src/lib/server/pairing.ts`,
  `src/lib/firebase/device-session.ts`).

## Boundaries and non-goals

- Middleware is routing UX only; it is never the API authorization boundary.
- Session cookies are not sent to third parties; auth domains are configured
  from validated public environment values.
- Pairing a phone never grants physical-device or actuator control.

## Partial / planned / deprecated

- **Partial:** live email verification, Google OAuth, password reset, and admin
  OTP delivery were not exercised in this checkout.
- **Partial:** device-bound revocation enforcement is implemented for the
  documented paths, but a full multi-account staging pass remains outstanding.
- **Planned:** WebAuthn/passkey sign-in is not implemented.
