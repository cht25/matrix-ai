// =============================================================================
// Safe authentication diagnostics.
//
// Google/Facebook sign-in failures used to surface as one opaque sentence,
// which is how a domain-migration problem stayed invisible for days. This
// module records the facts an engineer needs — Firebase error code, message,
// provider, method, hostname, redirect status — while structurally refusing to
// carry anything sensitive: only an explicit allowlist of fields is read from
// an error object, so tokens, passwords, client secrets and ID tokens can
// never end up in a log line even if they are attached to the error.
//
// Nothing here is shown to end users: user-facing copy comes from
// auth-errors.ts / oauth.ts. Development builds additionally log the raw
// console group so `next dev` shows the full story.
// =============================================================================

import { firebaseAuthDomain, firebaseAuthUsesSameOriginHandler, firebaseProjectId } from "@/lib/env-public";

export type AuthMethod = "google" | "facebook" | "password" | "redirect" | "link" | "session";
export type AuthStage =
  | "start"
  | "redirect-start"
  | "redirect-result"
  | "link-start"
  | "link-result"
  | "session-mint"
  | "sign-out";

/** Structured, redacted view of anything a caller might hand us. */
export type SafeAuthError = {
  name: string;
  code: string;
  message: string;
  status?: number;
  /** Identity Toolkit's own detail string, e.g. CONFIGURATION_NOT_FOUND. */
  providerMessage?: string;
  /**
   * Which keys were present on `customData` — never their values. Enough to
   * tell "the provider sent an email hint" without copying PII into logs.
   */
  customDataKeys?: string[];
};

const MAX_MESSAGE = 400;

function truncate(value: string): string {
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE)}…` : value;
}

/**
 * Extract a redacted error description. Reads named fields only — the object is
 * never spread, serialised wholesale, or stringified, so an error carrying
 * `credential`, `idToken`, `accessToken` or `password` cannot leak.
 */
export function safeAuthError(err: unknown): SafeAuthError {
  if (err === null || err === undefined) return { name: "Error", code: "", message: "" };
  if (typeof err !== "object") return { name: "Error", code: "", message: truncate(String(err)) };

  const e = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    status?: unknown;
    customData?: Record<string, unknown> | undefined;
  };
  const customData = e.customData && typeof e.customData === "object" ? e.customData : undefined;
  const providerMessage =
    customData && typeof customData.errorMessage === "string" ? customData.errorMessage : undefined;

  return {
    name: typeof e.name === "string" ? e.name : "Error",
    code: typeof e.code === "string" ? e.code : "",
    message: truncate(typeof e.message === "string" ? e.message : ""),
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(providerMessage ? { providerMessage: truncate(providerMessage) } : {}),
    ...(customData ? { customDataKeys: Object.keys(customData).sort() } : {}),
  };
}

/** Non-secret context: where the attempt happened and which handler it used. */
export type AuthEnvironment = {
  hostname: string;
  origin: string;
  authDomain: string;
  authDomainSource: "firebase-host" | "same-origin-proxy";
  projectId: string;
  secureContext: boolean;
};

export function authEnvironment(): AuthEnvironment {
  const hasWindow = typeof window !== "undefined";
  return {
    hostname: hasWindow ? window.location.hostname : "",
    origin: hasWindow ? window.location.origin : "",
    authDomain: firebaseAuthDomain,
    authDomainSource: firebaseAuthUsesSameOriginHandler ? "same-origin-proxy" : "firebase-host",
    projectId: firebaseProjectId,
    secureContext: hasWindow ? window.isSecureContext : false,
  };
}

export type AuthDiagnostic = {
  stage: AuthStage;
  method: AuthMethod;
  provider?: "google" | "facebook";
  error?: unknown;
  /** Extra non-secret facts (redirect consumed, destination, etc.). */
  detail?: Record<string, string | number | boolean | undefined>;
};

/** True for `next dev` / test builds, where verbose diagnostics are helpful. */
export function isVerboseAuthDiagnostics(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Record one authentication event. Always safe to call: every field is either
 * an enum, a hostname, or a redacted error summary.
 */
export function logAuthDiagnostic(event: AuthDiagnostic): void {
  const payload = {
    stage: event.stage,
    method: event.method,
    provider: event.provider,
    ...authEnvironment(),
    ...(event.error === undefined ? {} : { error: safeAuthError(event.error) }),
    ...(event.detail ?? {}),
  };
  const label = `[QORVYNA auth] ${event.stage} (${event.method})`;
  if (isVerboseAuthDiagnostics()) {
    console.warn(label, payload);
  } else {
    // Production keeps one compact line: enough to diagnose a report from a
    // user without dumping objects into the console.
    const error = payload.error;
    console.warn(
      `${label} code=${error?.code ?? "none"} status=${error?.status ?? "none"} host=${payload.hostname} ` +
        `authDomain=${payload.authDomain} (${payload.authDomainSource}) redirect=${String(event.detail?.redirect ?? "n/a")}`,
    );
  }
}

/** Development-only detail; silent in production builds. */
export function logAuthDetail(message: string, detail?: Record<string, unknown>): void {
  if (!isVerboseAuthDiagnostics()) return;
  console.warn(`[QORVYNA auth] ${message}`, detail ?? {});
}
