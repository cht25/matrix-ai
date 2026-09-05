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
  // --- build & deployment (§4, §7, §14, §18, §20, §32) ----------------------
  BUILD_FAILED: {
    title: "Build failed",
    detail: "MATRIX stopped before publishing because the project did not pass its checks. Open the error details, or ask Matrix to fix it automatically.",
    retryable: false,
  },
  BUILD_EMPTY: {
    title: "Nothing to publish",
    detail: "The build produced no publishable page, so the project was left untouched.",
    retryable: true,
  },
  BUILD_RATE_LIMITED: {
    title: "Too many builds at once",
    detail: "MATRIX is already building your other projects. Wait for one to finish and try again.",
    retryable: true,
  },
  BUILD_RUN_STALE: {
    title: "Build progress stopped",
    detail: "MATRIX stopped receiving updates for this build, so it is shown as failed. Nothing was marked published.",
    retryable: true,
  },
  BUILD_RUN_FAILED: {
    title: "Build stopped",
    detail: "The build ended unexpectedly before publishing. Check the logs and try again.",
    retryable: true,
  },
  BUILD_INCOMPLETE: {
    title: "Build did not finish cleanly",
    detail: "Some steps could not be confirmed, so MATRIX will not report a successful publish.",
    retryable: true,
  },
  DEPLOY_FAILED: {
    title: "Publishing failed",
    detail: "The hosting backend refused or interrupted the upload. Your files are safe — retry or read the logs.",
    retryable: true,
  },
  DEPLOY_INCOMPLETE: {
    title: "Publishing unconfirmed",
    detail: "The host did not report a live deployment, so MATRIX shows no live link.",
    retryable: true,
  },
  NO_FILES: {
    title: "No project files",
    detail: "Add or generate at least one file before building.",
    retryable: false,
  },
  PROJECT_REQUIRED: {
    title: "No project selected",
    detail: "Describe what to build and MATRIX will create the project first.",
    retryable: false,
  },
  NO_BUILD_REQUESTED: {
    title: "Nothing to build",
    detail: "Say what to create (or open a project) and Matrix will build it.",
    retryable: false,
  },
  AI_NOT_CONFIGURED: {
    title: "Coding model unavailable",
    detail: "This deployment has no AI provider configured, so files cannot be generated. Existing files can still be published.",
    retryable: false,
  },
  AI_PROVIDER_FAILED: {
    title: "Coding model error",
    detail: "The provider did not return a usable answer, so nothing was written.",
    retryable: true,
  },
  AI_NO_FILES: {
    title: "No files returned",
    detail: "The model answered without producing project files. Try rephrasing what to build.",
    retryable: true,
  },
  HOSTING_NOT_CONFIGURED: {
    title: "Hosting not configured",
    detail: "This deployment of MATRIX has no hosting provider connected, so nothing can be published yet.",
    retryable: false,
  },
  INDEX_REQUIRED: {
    title: "Entry page missing",
    detail: "A publishable site needs an index.html entry page.",
    retryable: false,
  },
  NO_LIVE_SITE: {
    title: "Publish first",
    detail: "Extra addresses mirror a live deployment, so publish the project before adding one.",
    retryable: false,
  },
  PUBLISH_RATE_LIMITED: {
    title: "Publishing limit reached",
    detail: "Too many publishes in the last hour. Wait a moment and try again.",
    retryable: true,
  },
  ROLLBACK_NOT_SUPPORTED: {
    title: "Rollback unavailable",
    detail: "This hosting backend or release has no retained snapshot to roll back to.",
    retryable: false,
  },
  ROLLBACK_FAILED: {
    title: "Rollback failed",
    detail: "The previous release could not be re-activated. The live site is unchanged.",
    retryable: true,
  },
  SLUG_INVALID: {
    title: "Address not allowed",
    detail: "Use 3-40 lowercase letters, numbers or dashes.",
    retryable: false,
  },
  SLUG_TAKEN: {
    title: "Address already in use",
    detail: "Someone publishes there already. Pick another address.",
    retryable: false,
  },
  URL_MISSING: { title: "Enter a URL", detail: "Type the address you want to add, for example myproject.example.com.", retryable: false },
  URL_INVALID: { title: "Invalid URL", detail: "Please enter a valid domain, for example myproject.example.com.", retryable: false },
  URL_PROTOCOL: { title: "Use http or https", detail: "Only http:// and https:// addresses can be added.", retryable: false },
  URL_HOST_INVALID: { title: "That hostname is not valid", detail: "Use a domain such as shop.example.com.", retryable: false },
  URL_PATH_NOT_SUPPORTED: { title: "Enter the domain only", detail: "Remove the path, query and port — MATRIX attaches the hostname itself.", retryable: false },
  URL_DUPLICATE: { title: "Already added", detail: "This project already has that address.", retryable: false },
  URL_RESERVED: { title: "That address is reserved", detail: "MATRIX cannot attach the platform's own hostname to a project.", retryable: false },
  URL_PRIMARY_REQUIRED: { title: "Keep one primary URL", detail: "Set another address as primary before removing this one.", retryable: false },
  URL_NOT_PRIMARY: { title: "Preview cannot be primary", detail: "Preview addresses stay secondary.", retryable: false },
  DOMAIN_INVALID: { title: "Invalid domain", detail: "Please enter a valid domain, for example app.mycompany.com.", retryable: false },
  DOMAIN_NOT_SET: { title: "No domain to verify", detail: "Add a custom domain first.", retryable: false },
  DOMAIN_NOT_VERIFIED: { title: "Domain not verified", detail: "MATRIX cannot point the primary URL at a domain that has not verified.", retryable: false },
  DOMAIN_NOT_SUPPORTED: { title: "Custom domain not connected", detail: "Finish the DNS challenge before treating this domain as live.", retryable: false },
  CUSTOM_DOMAIN_NOT_SUPPORTED: { title: "Custom domains unavailable", detail: "The connected hosting provider does not accept custom domains.", retryable: false },
  ALIASES_NOT_SUPPORTED: { title: "Multiple URLs unavailable", detail: "The connected hosting provider only serves one address per project.", retryable: false },
  PATH_EXISTS: { title: "Name already used", detail: "A file or folder with that name already exists.", retryable: false },
  TOO_MANY_FILES: { title: "File limit reached", detail: "This project has as many files as the host allows.", retryable: false },
  IMAGE_BUDGET: { title: "Asset budget reached", detail: "Remove or shrink an image before adding another one.", retryable: false },
  FILE_TOO_LARGE: { title: "File too large", detail: "This file exceeds the size the host stores per file.", retryable: false },
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
