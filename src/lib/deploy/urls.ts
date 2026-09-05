// =============================================================================
// MATRIX project URLs (§7, §8, §19, §20)
//
// A project has one primary URL plus aliases. Every entry here maps to
// something MATRIX hosting can really serve:
//
//   generated  →  https://<app origin>/s/<slug>          (real, live route)
//   preview    →  /api/projects/<id>/preview              (in-app sandbox)
//   custom     →  external hostname, only *usable* once the DNS challenge and
//                 the hosting platform's domain binding both verified — until
//                 then its status stays pending_dns and the UI says so (§7)
//
// Validation is strict but the messages stay friendly: raw exceptions never
// reach the browser. This module is pure and unit tested.
// =============================================================================

import { isValidDeploySlug, slugify } from "@/lib/projects/paths";

export type UrlKind = "generated" | "custom" | "preview";

export type UrlStatus = "active" | "pending_dns" | "verifying" | "failed" | "revoked";

export type ProjectUrl = {
  id: string;
  kind: UrlKind;
  /** Absolute URL (or same-origin path for preview) the user can open. */
  url: string;
  /** Hosting slug for generated URLs and their aliases. */
  slug: string | null;
  hostname: string;
  primary: boolean;
  status: UrlStatus;
  /** Verification detail for custom domains (never a raw exception). */
  detail: string;
  created_at: string;
};

export type UrlErrorCode =
  | "URL_MISSING"
  | "URL_INVALID"
  | "URL_PROTOCOL"
  | "URL_HOST_INVALID"
  | "URL_PATH_NOT_SUPPORTED"
  | "URL_DUPLICATE"
  | "URL_RESERVED"
  | "SLUG_INVALID"
  | "SLUG_TAKEN"
  | "DOMAIN_NOT_SUPPORTED";

export type UrlValidation =
  | { ok: true; url: string; kind: UrlKind; slug: string | null; hostname: string }
  | { ok: false; code: UrlErrorCode };

export const URL_ERROR_MESSAGES: Record<UrlErrorCode, { title: string; detail: string }> = {
  URL_MISSING: { title: "Enter a URL", detail: "Type the address you want to add, for example myproject.example.com." },
  URL_INVALID: { title: "Invalid URL", detail: "Please enter a valid domain, for example myproject.example.com." },
  URL_PROTOCOL: { title: "Use http or https", detail: "Only http:// and https:// addresses can be added." },
  URL_HOST_INVALID: { title: "That hostname is not valid", detail: "Use a domain such as example.com or shop.example.com." },
  URL_PATH_NOT_SUPPORTED: { title: "Enter the domain only", detail: "Custom addresses cannot include a path, query or port. Remove everything after the domain name." },
  URL_DUPLICATE: { title: "Already added", detail: "This project already has that address." },
  URL_RESERVED: { title: "That address is reserved", detail: "MATRIX cannot attach the platform's own hostname to a project." },
  SLUG_INVALID: { title: "That address is not allowed", detail: "Use 3-40 lowercase letters, numbers or dashes, without spaces." },
  SLUG_TAKEN: { title: "Address already in use", detail: "Someone else publishes at that address. Choose another one." },
  DOMAIN_NOT_SUPPORTED: { title: "Custom domain not connected", detail: "Add the DNS record, then MATRIX verifies the challenge file before calling it live." },
};

/** Hostnames the platform itself owns — never attachable to a project. */
const RESERVED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "example.invalid"]);

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUPPORTED_ROOTS = new Set([
  "com", "net", "org", "io", "co", "dev", "app", "ai", "site", "online", "cloud", "tech", "studio", "design",
  "xyz", "info", "me", "tv", "shop", "store", "live", "space", "website", "world", "link", "page", "codes",
  "education", "ac.uk", "gov.in", "edu.bd", "com.bd", "co.uk", "co.in", "com.au", "ca", "de", "fr", "jp", "in", "eu", "nz", "sg", "br",
]);

function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export function isValidHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host || host.length > 253) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // no bare IPs
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  const root = labels.slice(-2).join(".");
  const tld = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,24}$/.test(tld)) return false;
  // Second-level shapes like "ac.uk" are fine, but a garbage root is rejected
  // only when the TLD itself is unknown to public suffix heuristics — keep it
  // permissive here and let the DNS challenge decide the real truth.
  void root;
  return true;
}

/**
 * Validate a generated-address slug. `taken` is supplied by the server from a
 * real read of the `published_sites` collection, so "available" always means
 * "actually free at this moment".
 */
export function validateGeneratedSlug(
  input: string,
  options: { origin?: string; taken?: (slug: string) => boolean } = {},
): UrlValidation {
  const slug = slugify(String(input ?? "")).slice(0, 40);
  if (!slug) return { ok: false, code: "URL_INVALID" };
  if (!isValidDeploySlug(slug)) return { ok: false, code: "SLUG_INVALID" };
  if (options.taken?.(slug)) return { ok: false, code: "SLUG_TAKEN" };
  const origin = (options.origin ?? "").trim();
  return { ok: true, url: `${origin || ""}/s/${slug}`, kind: "generated", slug, hostname: "" };
}

/**
 * Validate a user-supplied URL for the "Add project URL" dialog.
 * `origin` is the deployment's own origin (used to reject reserved hostnames).
 */
export function validateProjectUrl(
  raw: string,
  options: { kind: UrlKind; origin?: string; existing?: ProjectUrl[]; projectId?: string },
): UrlValidation {
  const kind = options.kind;
  const origin = (options.origin ?? "").trim();
  const existing = options.existing ?? [];
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, code: "URL_MISSING" };

  if (kind === "preview") {
    if (!options.projectId) return { ok: false, code: "URL_INVALID" };
    const url = `/api/projects/${options.projectId}/preview`;
    return { ok: true, url, kind: "preview", slug: null, hostname: "" };
  }

  if (kind === "generated") {
    const slugInput = text.replace(/^https?:\/\//i, "").replace(/^[^/]*\/s\//i, "").replace(/\/+$/, "");
    const slug = slugify(slugInput);
    if (!slug) return { ok: false, code: "URL_INVALID" };
    if (!isValidDeploySlug(slug)) return { ok: false, code: "SLUG_INVALID" };
    const url = origin ? `${origin}/s/${slug}` : `/s/${slug}`;
    if (existing.some((item) => normalizeRefForCompare(item.url) === normalizeRefForCompare(url))) return { ok: false, code: "URL_DUPLICATE" };
    return { ok: true, url, kind: "generated", slug, hostname: "" };
  }

  // Custom domain -----------------------------------------------------------
  let candidate = text.toLowerCase();
  if (/^[a-z]+:\/\//i.test(candidate)) {
    const protocol = candidate.split("://")[0];
    if (protocol !== "http" && protocol !== "https") return { ok: false, code: "URL_PROTOCOL" };
  } else {
    candidate = `https://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, code: "URL_INVALID" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, code: "URL_PROTOCOL" };
  if (parsed.username || parsed.password) return { ok: false, code: "URL_INVALID" };
  if (parsed.port) return { ok: false, code: "URL_PATH_NOT_SUPPORTED" };
  if (parsed.search || (parsed.pathname && parsed.pathname !== "/" && !/^\/s\/[a-z0-9-]+\/?$/i.test(parsed.pathname))) {
    return { ok: false, code: "URL_PATH_NOT_SUPPORTED" };
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!isValidHostname(hostname)) return { ok: false, code: "URL_HOST_INVALID" };
  if (RESERVED_HOSTNAMES.has(hostname)) return { ok: false, code: "URL_HOST_INVALID" };
  const tld = hostname.split(".").pop() ?? "";
  const second = hostname.split(".").slice(-2).join(".");
  if (!SUPPORTED_ROOTS.has(tld) && !SUPPORTED_ROOTS.has(second)) return { ok: false, code: "URL_HOST_INVALID" };
  if (origin && normalizeHostname(safeHost(origin)) === hostname) return { ok: false, code: "URL_RESERVED" };
  const url = `https://${hostname}`;
  if (existing.some((item) => normalizeRefForCompare(item.url) === normalizeRefForCompare(url))) return { ok: false, code: "URL_DUPLICATE" };
  return { ok: true, url, kind: "custom", slug: null, hostname };
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//i, "").split("/")[0];
  }
}

function normalizeRefForCompare(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\//, "");
}

/** Friendly copy for a validation code (raw codes never reach the user). */
export function urlErrorCopy(code: unknown): { title: string; detail: string } {
  const key = String(code ?? "") as UrlErrorCode;
  return URL_ERROR_MESSAGES[key] ?? { title: "Could not add that address", detail: "Check the URL and try again." };
}

export type AddUrlInput = {
  raw: string;
  kind: UrlKind;
  origin: string;
  projectId: string;
  existing: ProjectUrl[];
};

/** One-call validation used by both the RPC layer and the client form. */
export function prepareNewUrl(input: AddUrlInput): UrlValidation {
  return validateProjectUrl(input.raw, {
    kind: input.kind,
    origin: input.origin,
    projectId: input.projectId,
    existing: input.existing,
  });
}

/** The URL the chat popup and the deployment panel may honestly render. */
export function primaryUrlOf(urls: ProjectUrl[]): ProjectUrl | null {
  return urls.find((item) => item.primary && item.status === "active") ?? urls.find((item) => item.status === "active") ?? null;
}

export function openableUrlOf(url: ProjectUrl, origin: string): string {
  if (url.kind === "preview") return url.url;
  if (url.kind === "generated") {
    return /^https?:\/\//i.test(url.url) ? url.url : `${origin}${url.url}`;
  }
  // A custom hostname only counts as openable once verified.
  return url.status === "active" ? url.url : "";
}

export function urlLabel(kind: UrlKind): string {
  if (kind === "generated") return "Generated";
  if (kind === "preview") return "Preview";
  return "Custom";
}
