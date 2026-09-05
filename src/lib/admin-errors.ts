// =============================================================================
// MATRIX AI — admin error mapper.
//
// Internal error code  →  human readable { title, detail, retryable }.
// Raw codes such as ROLE_INVALID / PERMISSION_DENIED must never be the primary
// message shown to an operator; they stay available as `code` for logs and a
// small monospace reference line.
// =============================================================================

export type AdminErrorView = {
  title: string;
  detail: string;
  retryable: boolean;
  /** Internal identifier — for developer logs / support references only. */
  code: string;
};

const MAP: Record<string, { title: string; detail: string; retryable: boolean }> = {
  ROLE_INVALID: {
    title: "Unable to update role",
    detail: "The selected role is not supported by the current system configuration.",
    retryable: true,
  },
  ROLE_SELF_DEMOTION: {
    title: "You cannot change your own role",
    detail: "Ask another super administrator to change your access level.",
    retryable: false,
  },
  PERMISSION_DENIED: {
    title: "You do not have access to this action",
    detail: "This operation requires a higher admin role. Ask a super administrator for help.",
    retryable: false,
  },
  UNAUTHENTICATED: {
    title: "Your session has expired",
    detail: "Sign in again to continue managing the platform.",
    retryable: false,
  },
  BAD_ORIGIN: {
    title: "Request blocked for security",
    detail: "The request did not come from MATRIX. Reload the page and try again.",
    retryable: true,
  },
  NOT_FOUND: {
    title: "That record no longer exists",
    detail: "It may have been removed by another administrator. Refresh the list.",
    retryable: true,
  },
  USER_NOT_FOUND: {
    title: "User not found",
    detail: "This account no longer exists in the authentication directory.",
    retryable: false,
  },
  BAD_REQUEST: {
    title: "Request could not be processed",
    detail: "Some of the submitted information was not valid. Check the form and try again.",
    retryable: true,
  },
  UNKNOWN_ACTION: {
    title: "This feature is unavailable",
    detail: "The server does not recognise this operation. It may need to be redeployed.",
    retryable: false,
  },
  LOAD_FAILED: {
    title: "Unable to load data",
    detail: "MATRIX could not reach the database. Nothing is wrong on your side.",
    retryable: true,
  },
  BOOTSTRAP_NOT_CONFIGURED: {
    title: "Admin setup is not configured",
    detail: "The one-time setup key is missing from the server environment.",
    retryable: false,
  },
  INVALID_BOOTSTRAP_KEY: {
    title: "Setup key rejected",
    detail: "That setup key does not match the one configured on the server.",
    retryable: true,
  },
  BOOTSTRAP_CLOSED: {
    title: "Setup already completed",
    detail: "An administrator already exists, so one-time setup is closed.",
    retryable: false,
  },
};

const NETWORKISH = /^(HTTP_5\d\d|FETCH_FAILED|NETWORK_ERROR)$/;

export function mapAdminError(code: unknown): AdminErrorView {
  const raw = typeof code === "string" && code.trim() ? code.trim() : "UNKNOWN_ERROR";
  const hit = MAP[raw];
  if (hit) return { ...hit, code: raw };
  if (NETWORKISH.test(raw) || raw.startsWith("HTTP_5")) {
    return {
      title: "MATRIX is having a problem",
      detail: "The server could not complete this request. It has been logged — please try again shortly.",
      retryable: true,
      code: raw,
    };
  }
  if (raw.startsWith("HTTP_4")) {
    return {
      title: "Request rejected",
      detail: "The server refused this request. Refresh the page and try again.",
      retryable: true,
      code: raw,
    };
  }
  return {
    title: "Something went wrong",
    detail: "MATRIX could not complete this action. Please try again in a moment.",
    retryable: true,
    code: raw,
  };
}

/** Pull the internal code out of whatever the client threw. */
export function errorCodeOf(err: unknown, fallback = "UNKNOWN_ERROR"): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
