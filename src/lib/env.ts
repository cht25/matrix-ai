// Centralised env access. Server-only secrets are never exposed to the client.
import { PRODUCTION_ORIGIN } from "@/lib/seo";
import { resolveFirebaseWebConfig } from "@/lib/firebase/web-config";
// Real services only: there is intentionally no demo mode. If the Firebase
// config is missing/invalid the app renders honest configuration errors
// instead of pretending to work.
//
// Firebase split:
//   NEXT_PUBLIC_FIREBASE_*  → client SDK config (public by design)
//   FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY → server-side Admin SDK
//     (service account)
// Images live on Cloudinary (free tier) instead of Firebase Storage (paid):
//   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET —
//   uploads are server-signed and stored as private (authenticated) assets.

// Values that ship in .env.example and mean "not really configured yet".
const PLACEHOLDERS = ["YOUR-", "your-project", "your-api-key", "your-project-id", "example.com", "replace-with", "..."];

function clean(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

// Browser Firebase config, resolved by the SAME module the client bundle uses
// (src/lib/firebase/web-config.ts). Keeping one resolver means the server can
// never disagree with the browser about the project id or the auth handler.
const firebaseWeb = resolveFirebaseWebConfig({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  appOrigin: process.env.NEXT_PUBLIC_APP_URL ?? PRODUCTION_ORIGIN,
});

// A usable Firebase web config needs a real API key and project id. Everything
// else (authDomain, appId…) has sane derived defaults but these two do not.
const configured = firebaseWeb.configured;

// Operator-facing configuration warnings are logged once per process, never in
// tests, and never contain credentials.
if (process.env.NODE_ENV !== "test" && firebaseWeb.warnings.length) {
  for (const warning of firebaseWeb.warnings) console.warn(`[QORVYNA] Firebase config: ${warning}`);
}

// Server-side Admin SDK needs a service account (or Google Application
// Default Credentials, e.g. on Firebase App Hosting / Cloud Run / GCE).
const serviceEmail = clean(process.env.FIREBASE_CLIENT_EMAIL ?? "");
const serviceKeyRaw = clean(process.env.FIREBASE_PRIVATE_KEY ?? "");
const hasServiceAccount = Boolean(serviceEmail) && !PLACEHOLDERS.some((p) => serviceEmail.includes(p)) && serviceKeyRaw.includes("PRIVATE KEY");
const hasAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) || process.env.FIREBASE_AUTH_EMULATOR_HOST != null;

// Popup/redirect OAuth is served by Firebase's own auth handler. That handler
// lives on the value of `authDomain`: either the project's Firebase-hosted
// domain (*.firebaseapp.com / *.web.app), or — when a deployment deliberately
// serves it itself — the site's own origin, reached through the /__/auth
// reverse proxy in this repository. web-config.ts encodes that decision; it is
// no longer a hardcoded rewrite, which used to silently ignore a configured
// custom domain (and silently point the browser at the wrong origin).
export const env = {
  firebasePublic: firebaseWeb.config,
  /** Why authDomain resolved the way it did (safe to log; no secrets). */
  firebaseAuthDomainSource: firebaseWeb.authDomainSource,
  firebaseAuthUsesSameOriginHandler: firebaseWeb.sameOriginAuthHandler,
  firebaseConfigWarnings: firebaseWeb.warnings,
  // Links / emails only. Middleware never redirects here — pointing this at an
  // unbound apex (e.g. https://thamjj13.top) must not bounce the custom domain.
  // NOTE: deploy.ts, sitemap.ts and robots.ts now use siteOrigin() from seo.ts
  // as the single source of truth for public URL generation. This field is
  // retained for backwards compatibility but should not be used for new code.
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? PRODUCTION_ORIGIN,
  cloudinary: {
    get cloudName() { return clean(process.env.CLOUDINARY_CLOUD_NAME ?? ""); },
    get apiKey() { return clean(process.env.CLOUDINARY_API_KEY ?? ""); },
    get apiSecret() { return clean(process.env.CLOUDINARY_API_SECRET ?? ""); },
  },
  serviceEmail,
  serviceKeyRaw,
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  togetherApiKey: process.env.TOGETHER_API_KEY ?? "",
  identityPepper: clean(process.env.IDENTITY_PEPPER ?? ""),
  adminBootstrapKey: clean(process.env.ADMIN_BOOTSTRAP_KEY ?? ""),
  github: {
    clientId: clean(process.env.GITHUB_CLIENT_ID ?? ""),
    clientSecret: clean(process.env.GITHUB_CLIENT_SECRET ?? ""),
    tokenEncryptionKey: clean(process.env.GITHUB_TOKEN_ENCRYPTION_KEY ?? ""),
    callbackUrl: clean(process.env.GITHUB_OAUTH_CALLBACK_URL ?? ""),
  },
} as const;

// Vercel config is read LIVE (not snapshotted) so tests and runtime env changes
// are honored; the token stays server-side only.
export function vercelConfig(): { token: string; teamId: string; appsDomain: string } {
  return {
    token: clean(process.env.VERCEL_TOKEN ?? ""),
    teamId: clean(process.env.VERCEL_TEAM_ID ?? ""),
    // Approved parent domain for deployed app aliases (e.g. *.apps.thamjj13.top).
    appsDomain: clean(process.env.VERCEL_APPS_DOMAIN ?? "apps.thamjj13.top"),
  };
}

export function isConfigured(): boolean {
  return configured;
}

/** True when the server can reach Firebase with Admin privileges. */
export function isServerConfigured(): boolean {
  return isConfigured() && (hasServiceAccount || hasAdc);
}

/** True when general chat has a real Groq key. */
export function isAiConfigured(): boolean {
  return Boolean(env.groqApiKey) && !PLACEHOLDERS.some((p) => env.groqApiKey.includes(p));
}

/** Agent/coding uses the same model and key as chat. */
export function isCodingAiConfigured(): boolean {
  return isAiConfigured();
}

/** True when the secure GitHub OAuth connection can be used. */
export function isGithubConfigured(): boolean {
  const github = env.github;
  return Boolean(github.clientId && github.clientSecret && github.tokenEncryptionKey.length >= 32) &&
    !PLACEHOLDERS.some((p) => github.clientId.includes(p) || github.clientSecret.includes(p));
}

/** True when birth-certificate numbers can be hashed (never stored plaintext). */
export function isIdentityPepperConfigured(): boolean {
  return env.identityPepper.length >= 32 && !PLACEHOLDERS.some((p) => env.identityPepper.includes(p));
}

/** True when the one-time in-app first-admin bootstrap can run. */
export function isAdminBootstrapConfigured(): boolean {
  return env.adminBootstrapKey.length >= 16 && !PLACEHOLDERS.some((p) => env.adminBootstrapKey.includes(p));
}

/** True when image uploads (Cloudinary) are configured. */
export function isCloudinaryConfigured(): boolean {
  const c = env.cloudinary;
  return Boolean(c.cloudName && c.apiKey && c.apiSecret) && !PLACEHOLDERS.some((p) => c.cloudName.includes(p) || c.apiSecret.includes(p));
}

/** True when the server-side Vercel deployment engine has a real API token. */
export function isVercelConfigured(): boolean {
  const v = vercelConfig();
  return Boolean(v.token) && !PLACEHOLDERS.some((p) => v.token.includes(p));
}

export function serviceAccount(): { projectId: string; clientEmail: string; privateKey: string } | undefined {
  if (!hasServiceAccount) return undefined;
  return {
    projectId: firebaseWeb.config.projectId,
    clientEmail: serviceEmail,
    // Vercel/Render-style escaped newlines → real newlines.
    privateKey: serviceKeyRaw.replace(/\\n/g, "\n"),
  };
}

// Log exactly once per process/bundle when Firebase credentials are missing,
// pointing operators at the fix. Uses a global flag because per-module state
// is duplicated across Next.js bundles (middleware, server renderer, ...).
const WARN_FLAG = "__matrixMissingFirebaseConfigWarned";

export function logMissingFirebaseConfig(): void {
  if (configured) return;
  const g = globalThis as Record<string, unknown>;
  if (g[WARN_FLAG]) return;
  g[WARN_FLAG] = true;
  console.error(
    "[QORVYNA] NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_PROJECT_ID are missing or invalid —\n" +
      "[QORVYNA] the app cannot authenticate or load data. Add the Firebase web config\n" +
      "[QORVYNA] (Firebase console → Project settings → Your apps) plus the Admin service\n" +
      "[QORVYNA] account vars (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) to your host's\n" +
      "[QORVYNA] environment settings and redeploy. See README.md → “Firebase setup”.",
  );
}
