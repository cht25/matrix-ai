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
  | "sign-out"
  // Centralised post-redirect lifecycle (src/lib/auth/lifecycle.ts). Each
  // stage of the return trip is named so a stuck login can be located from the
  // console without guessing. Tokens are never part of any of these records.
  | "auth-init"
  | "persistence"
  | "auth-state"
  | "id-token"
  | "session-check"
  | "profile"
  | "navigation"
  | "chat-load";

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

export type AuthLifecycleEvent =
  | "FIREBASE_INITIALIZED"
  | "REDIRECT_RESULT_STARTED"
  | "REDIRECT_RESULT_COMPLETED"
  | "AUTH_STATE_CHANGED"
  | "AUTH_USER_DETECTED"
  | "PROFILE_LOADING"
  | "BACKEND_AUTH_CHECK"
  | "CHAT_INITIALIZATION"
  | "AUTH_REDIRECT_ERROR";

export type AuthDiagnostic = {
  event?: AuthLifecycleEvent;
  stage: AuthStage;
  method: AuthMethod;
  provider?: "google" | "facebook";
  error?: unknown;
  /** Extra non-secret facts (redirect consumed, destination, etc.). */
  detail?: Record<string, string | number | boolean | undefined>;
};

const SENSITIVE_DETAIL_KEY = /token|password|secret|credential|cookie|authorization/i;

function sanitizeDetail(
  detail: Record<string, string | number | boolean | undefined> | undefined,
): Record<string, string | number | boolean | undefined> {
  if (!detail) return {};
  const clean: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    clean[key] = typeof value === "string" ? truncate(value) : value;
  }
  return clean;
}

/** True for `next dev` / test builds, where verbose diagnostics are helpful. */
export function isVerboseAuthDiagnostics(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Record one authentication event. Always safe to call: every field is either
 * an enum, a hostname, or a redacted error summary.
 */
export function logAuthDiagnostic(diagnostic: AuthDiagnostic): void {
  const safeDetail = sanitizeDetail(diagnostic.detail);
  const payload = {
    ...(diagnostic.event ? { event: diagnostic.event } : {}),
    stage: diagnostic.stage,
    method: diagnostic.method,
    provider: diagnostic.provider,
    ...authEnvironment(),
    ...(diagnostic.error === undefined ? {} : { error: safeAuthError(diagnostic.error) }),
    ...safeDetail,
  };
  const label = diagnostic.event
    ? `[QORVYNA auth] ${diagnostic.event} (${diagnostic.stage}/${diagnostic.method})`
    : `[QORVYNA auth] ${diagnostic.stage} (${diagnostic.method})`;
  if (isVerboseAuthDiagnostics()) {
    console.warn(label, payload);
  } else {
    // Production keeps one compact redacted line: enough to trace each stage
    // and diagnose redirect/session issues without dumping secrets.
    const error = payload.error;
    const summaryPairs = Object.entries(safeDetail)
      .filter(([, value]) => value !== undefined)
      .slice(0, 8)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    console.warn(
      `${label} code=${error?.code ?? "none"} status=${error?.status ?? "none"} host=${payload.hostname} ` +
        `authDomain=${payload.authDomain} (${payload.authDomainSource}) redirect=${String(safeDetail.redirect ?? "n/a")}` +
        (summaryPairs ? ` ${summaryPairs}` : ""),
    );
  }
}

/** Convenience helper for the named lifecycle events (always redacted). */
export function logAuthEvent(
  event: AuthLifecycleEvent,
  options: {
    stage?: AuthStage;
    method?: AuthMethod;
    provider?: "google" | "facebook";
    error?: unknown;
    detail?: Record<string, string | number | boolean | undefined>;
  } = {},
): void {
  const stageByEvent: Record<AuthLifecycleEvent, AuthStage> = {
    FIREBASE_INITIALIZED: "auth-init",
    REDIRECT_RESULT_STARTED: "redirect-result",
    REDIRECT_RESULT_COMPLETED: "redirect-result",
    AUTH_STATE_CHANGED: "auth-state",
    AUTH_USER_DETECTED: "auth-state",
    PROFILE_LOADING: "profile",
    BACKEND_AUTH_CHECK: "session-check",
    CHAT_INITIALIZATION: "chat-load",
    AUTH_REDIRECT_ERROR: "redirect-result",
  };
  logAuthDiagnostic({
    event,
    stage: options.stage ?? stageByEvent[event],
    method: options.method ?? "session",
    provider: options.provider,
    error: options.error,
    detail: options.detail,
  });
}

/** Development-only detail; silent in production builds. */
export function logAuthDetail(message: string, detail?: Record<string, unknown>): void {
  if (!isVerboseAuthDiagnostics()) return;
  console.warn(`[QORVYNA auth] ${message}`, detail ?? {});
}
