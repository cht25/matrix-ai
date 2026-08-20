// Safe, actionable messages for Firebase client Auth errors.
//
// The Firebase JS SDK surfaces raw Identity Toolkit failures as opaque
// errors — most importantly a 400 CONFIGURATION_NOT_FOUND, which means the
// deployed API key doesn't belong to any active Firebase project (typo,
// deleted key/project, or config copied from another app). Without this
// mapper every such failure renders as "We couldn't sign you in" and the
// real cause only shows in the browser console. Here we recognise
// deployment-configuration failures and say so, in user-safe language.

export type AuthErrorKind =
  | "config" // wrong/deleted API key or project — operator must fix env + redeploy
  | "domain" // host not in Authentication → Settings → Authorized domains
  | "provider" // sign-in method not enabled in the Firebase console
  | "account-exists"
  | "session"
  | "invalid-credential"
  | "network"
  | "rate-limit"
  | "unknown";

function errorText(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as {
    code?: unknown;
    message?: unknown;
    customData?: { errorMessage?: unknown } | undefined;
  };
  return [String(e.code ?? ""), String(e.message ?? ""), String(e.customData?.errorMessage ?? "")]
    .join(" ")
    .toLowerCase();
}

export function authErrorKind(err: unknown): AuthErrorKind {
  const raw = errorText(err);
  // Wrong/deleted API key or a key from a different Firebase project. The REST
  // API answers 400 CONFIGURATION_NOT_FOUND / API_KEY_INVALID; the SDK's code
  // string varies by version (auth/configuration-not-found,
  // auth/api-key-not-valid…), so match generously across spellings.
  if (/configuration[_-]?not[_-]?found|api[_-]?key[_-]?not[_-]?valid|invalid[_-]?api[_-]?key/.test(raw)) {
    return "config";
  }
  if (raw.includes("unauthorized-domain") || raw.includes("unauthorized_continue_uri")) return "domain";
  if (raw.includes("operation-not-allowed")) return "provider";
  if (raw.includes("account-exists-with-different-credential") || raw.includes("credential-already-in-use")) {
    return "account-exists";
  }
  if (raw.includes("session_mint_failed") || raw.includes("session mint")) return "session";
  if (raw.includes("network-request-failed")) return "network";
  if (raw.includes("too-many-requests") || raw.includes("too_many_attempts")) return "rate-limit";
  if (/(invalid-credential|invalid_login_credentials|wrong-password|user-not-found|user_not_found)/.test(raw)) {
    return "invalid-credential";
  }
  return "unknown";
}

/** True when the error means the deployment's Firebase configuration itself is
 *  broken — nothing the user did, and retrying won't help. */
export function isFirebaseConfigError(err: unknown): boolean {
  const kind = authErrorKind(err);
  return kind === "config" || kind === "domain" || kind === "provider";
}

const COPY: Record<AuthErrorKind, string> = {
  config:
    "Server setup problem — this deployment's Firebase configuration is invalid (wrong or deleted API key/project). Signing in cannot work until the administrator fixes NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_PROJECT_ID and redeploys.",
  domain:
    "Server setup problem — this site's domain isn't approved in Firebase yet (console → Authentication → Settings → Authorized domains). The administrator needs to add it.",
  provider:
    "Server setup problem — this sign-in method isn't enabled in Firebase (console → Authentication → Sign-in method).",
  "account-exists":
    "An account with this email already exists. Sign in with email and password, then link Google or Facebook in Settings.",
  session:
    "Signed in with your account, but the server could not create your session. Tap Retry session — you will not create a second account.",
  "invalid-credential": "Incorrect email or password.",
  network: "Network problem — check your connection and try again.",
  "rate-limit": "Too many attempts. Please wait a moment and try again.",
  unknown: "",
};

/** Map a Firebase Auth error to a user-safe message. `fallback` is returned
 *  for ordinary failures the caller already has copy for. */
export function describeAuthError(err: unknown, fallback: string): string {
  const kind = authErrorKind(err);
  return COPY[kind] || fallback;
}
