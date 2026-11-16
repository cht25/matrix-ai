// =============================================================================
// Single source of truth for the browser Firebase web config.
//
// Imported by BOTH the client SDK bootstrap (src/lib/firebase/client.ts via
// env-public.ts) and the server-side env module, so the browser and the server
// can never disagree about which Firebase project / auth handler is in use.
//
// Only public values live here (apiKey, authDomain, projectId, sender id,
// appId). Provider secrets (Google OAuth client secret, service-account keys)
// are never part of the web config and are never read by this module.
//
// -----------------------------------------------------------------------------
// authDomain rules
// -----------------------------------------------------------------------------
// QORVYNA is a Next.js application served by a Node host (Render / Firebase
// App Hosting / any container). It is NOT served by Firebase Hosting, so
// `authDomain` cannot simply be pointed at the public website: the value names
// the origin that serves Firebase's own `/__/auth/handler` helper page.
//
//  1. unset / unparseable     → `<projectId>.firebaseapp.com`.
//     Always authorized by Firebase ("PROJECT_ID.firebaseapp.com" is listed
//     automatically) and served by Google, so it works regardless of the
//     hosting provider. This is the correct default.
//
//  2. `*.firebaseapp.com` / `*.web.app`
//     → used verbatim (Firebase's own handlers).
//
//  3. any other hostname (a custom domain, e.g. `qorvyna.thamjj13.top`)
//     → used verbatim ONLY because this app ships a reverse proxy for
//       `/__/auth/*` (src/app/__/auth) that forwards to the project's real
//       handler. Setting a custom authDomain without that proxy is exactly the
//       failure mode that produces "We couldn't finish Google sign-in" — the
//       redirect lands on a URL that is not a Firebase auth handler.
//       A warning is recorded when the custom host does not match the app's
//       own origin (`NEXT_PUBLIC_APP_URL`), because then the browser would
//       leave the site and still not reach a handler.
//
//  4. a value with a scheme, port, path or query (`https://x/y`) is not a
//     valid authDomain (the SDK builds URLs from it); the hostname is
//     extracted and rule 2/3 apply, with a warning.
// =============================================================================

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
};

export type AuthDomainSource = "derived" | "env-firebase-host" | "env-custom-host";

export type ResolvedFirebaseWebConfig = {
  config: FirebaseWebConfig;
  /** A browser client can be initialised (apiKey + projectId are real). */
  configured: boolean;
  authDomainSource: AuthDomainSource;
  /**
   * True when `authDomain` is a custom (non-Firebase) hostname, i.e. this
   * deployment must serve Firebase's auth helper itself through the
   * `/__/auth/*` reverse proxy.
   */
  sameOriginAuthHandler: boolean;
  /** Operator-facing (non-secret) configuration warnings. */
  warnings: string[];
};

/** Values that ship in .env.example and mean "not really configured yet". */
export const PLACEHOLDER_VALUES = [
  "YOUR-",
  "your-project",
  "your-api-key",
  "your-project-id",
  "example.com",
  "replace-with",
  "...",
] as const;

/** Trim, strip a single level of matching quotes (host UIs love to add them). */
export function cleanValue(value: string | undefined | null): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

export function isPlaceholderValue(value: string): boolean {
  if (!value) return true;
  return PLACEHOLDER_VALUES.some((placeholder) => value.includes(placeholder));
}

/** A Firestore/Auth project id: lowercase letters, digits, hyphens. */
export function isUsableProjectId(value: string): boolean {
  return Boolean(value) && !isPlaceholderValue(value);
}

/** True when the project id at least looks like a Firebase project id. */
export function looksLikeProjectId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,62}$/.test(value);
}

/**
 * A key the SDK can attempt to use: present and not an .env.example
 * placeholder. Firebase itself is the authority on whether the key belongs to
 * the project — a malformed-looking key only produces a warning, because
 * refusing to boot on a cosmetic mismatch would be worse than the real check.
 */
export function isUsableApiKey(value: string): boolean {
  return Boolean(value) && !isPlaceholderValue(value);
}

/** True when the key at least looks like a Google/Firebase Web API key. */
export function looksLikeGoogleApiKey(value: string): boolean {
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(value);
}

export function isFirebaseHostedAuthDomain(value: string): boolean {
  const host = value.toLowerCase();
  return host.endsWith(".firebaseapp.com") || host.endsWith(".web.app");
}

/**
 * Reduce a configured authDomain to a bare hostname. Returns "" when nothing
 * usable remains. A value that carried a scheme/port/path is reported through
 * `normalizedFrom` so the caller can warn.
 */
export function normalizeAuthDomainHost(raw: string): { host: string; altered: boolean } {
  const value = cleanValue(raw);
  if (!value) return { host: "", altered: false };
  let host = value;
  let altered = false;
  if (/^https?:\/\//i.test(host)) {
    altered = true;
    try {
      host = new URL(host).hostname;
    } catch {
      return { host: "", altered: true };
    }
  }
  // Strip a port and any trailing path/query the operator may have pasted.
  const slash = host.indexOf("/");
  if (slash !== -1) {
    host = host.slice(0, slash);
    altered = true;
  }
  const withoutPort = host.replace(/:\d+$/, "");
  if (withoutPort !== host) {
    host = withoutPort;
    altered = true;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (!host) return { host: "", altered: true };
  // A hostname must look like a hostname (letters, digits, dots, hyphens).
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return { host: "", altered: true };
  return { host, altered };
}

function hostnameOf(origin: string | undefined | null): string {
  const value = cleanValue(origin);
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export type ResolveInput = {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  messagingSenderId?: string;
  appId?: string;
  /** The deployment's own public origin (`NEXT_PUBLIC_APP_URL`), if set. */
  appOrigin?: string;
};

/**
 * Resolve the browser Firebase config from raw environment values.
 * Pure — no process.env access — so it is unit tested directly.
 */
export function resolveFirebaseWebConfig(input: ResolveInput): ResolvedFirebaseWebConfig {
  const apiKey = cleanValue(input.apiKey);
  const projectId = cleanValue(input.projectId);
  const messagingSenderId = cleanValue(input.messagingSenderId);
  const appId = cleanValue(input.appId);
  const rawAuthDomain = cleanValue(input.authDomain);
  const warnings: string[] = [];

  const configured = isUsableApiKey(apiKey) && isUsableProjectId(projectId);

  let authDomain = "";
  let authDomainSource: AuthDomainSource = "derived";
  let sameOriginAuthHandler = false;

  const { host, altered } = normalizeAuthDomainHost(rawAuthDomain);
  if (altered && host) {
    warnings.push(
      `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN must be a bare hostname; "${rawAuthDomain}" was reduced to "${host}".`,
    );
  }

  if (host && isFirebaseHostedAuthDomain(host)) {
    authDomain = host;
    authDomainSource = "env-firebase-host";
  } else if (host) {
    authDomain = host;
    authDomainSource = "env-custom-host";
    sameOriginAuthHandler = true;
    const appHost = hostnameOf(input.appOrigin);
    if (!appHost) {
      warnings.push(
        `authDomain "${host}" is a custom domain and NEXT_PUBLIC_APP_URL is not set. Set NEXT_PUBLIC_APP_URL=https://${host} so the site and its /__/auth handler share one origin.`,
      );
    } else if (appHost !== host) {
      warnings.push(
        `authDomain "${host}" does not match the site origin "${appHost}". Google sign-in will leave the site and fail to reach a Firebase auth handler. Use "${projectId || "PROJECT_ID"}.firebaseapp.com" or set NEXT_PUBLIC_APP_URL=https://${host}.`,
      );
    }
  } else {
    authDomain =
      projectId && looksLikeProjectId(projectId) && isUsableProjectId(projectId)
        ? `${projectId.toLowerCase()}.firebaseapp.com`
        : "";
    authDomainSource = "derived";
    if (rawAuthDomain) {
      warnings.push(
        `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN "${rawAuthDomain}" is not a usable hostname; using "${authDomain || "(none)"}".`,
      );
    }
  }

  if (apiKey && !looksLikeGoogleApiKey(apiKey)) {
    warnings.push(
      "NEXT_PUBLIC_FIREBASE_API_KEY does not look like a Google API key (expected an AIza… value). If sign-in reports configuration-not-found, this key belongs to another project.",
    );
  }
  if (projectId && !looksLikeProjectId(projectId)) {
    warnings.push(
      `NEXT_PUBLIC_FIREBASE_PROJECT_ID "${projectId}" does not look like a Firebase project id; authDomain cannot be derived from it.`,
    );
  }

  if (!configured) {
    warnings.push(
      "Firebase web config is incomplete: NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID must be the real values of the project (Project settings → Your apps).",
    );
  }

  return {
    config: { apiKey, authDomain, projectId, messagingSenderId, appId },
    configured,
    authDomainSource,
    sameOriginAuthHandler,
    warnings,
  };
}

/**
 * Host that actually serves Firebase's `/__/auth/*` helper for this project.
 * Firebase hosts it on `<projectId>.firebaseapp.com` (and on the project's
 * `.web.app` domain) — those are the origins that are always authorized, which
 * is why the reverse proxy forwards there rather than to the custom domain.
 */
export function firebaseHandlerOrigin(projectId: string): string {
  const id = cleanValue(projectId);
  return id ? `https://${id}.firebaseapp.com` : "";
}

/**
 * Absolute upstream URL for a proxied `/__/auth/...` request, or "" when the
 * deployment should not proxy at all (Firebase-hosted authDomain, or an
 * unusable project id).
 */
export function firebaseAuthProxyUrl(projectId: string, path: string[], search = ""): string {
  const origin = firebaseHandlerOrigin(projectId);
  if (!origin) return "";
  const cleanPath = (path ?? [])
    .map((segment) => String(segment))
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  const suffix = cleanPath ? `/${cleanPath}` : "/handler";
  return `${origin}/__/auth${suffix}${search}`;
}
