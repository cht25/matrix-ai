// =============================================================================
// Project URL management (§19, §20, §36): real validation, honest DNS state.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  isValidHostname,
  openableUrlOf,
  prepareNewUrl,
  primaryUrlOf,
  urlErrorCopy,
  urlLabel,
  validateGeneratedSlug,
  validateProjectUrl,
  type ProjectUrl,
} from "@/lib/deploy/urls";

const ORIGIN = "https://matrix.app";

function url(overrides: Partial<ProjectUrl> = {}): ProjectUrl {
  return {
    id: "u1",
    kind: "generated",
    url: `${ORIGIN}/s/my-site`,
    slug: "my-site",
    hostname: "",
    primary: true,
    status: "active",
    detail: "",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("generated addresses", () => {
  it("accepts a clean slug and builds the real URL", () => {
    const result = validateGeneratedSlug("My Site", { origin: ORIGIN });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe(`${ORIGIN}/s/my-site`);
  });

  it("rejects a slug that is too short or full of punctuation", () => {
    expect(validateGeneratedSlug("a", { origin: ORIGIN }).ok).toBe(false);
    expect(validateGeneratedSlug("///", { origin: ORIGIN }).ok).toBe(false);
  });

  it("reports a taken slug from the live host, not a guess", () => {
    const result = validateGeneratedSlug("taken-one", { origin: ORIGIN, taken: (slug) => slug === "taken-one" });
    expect(!result.ok && result.code).toBe("SLUG_TAKEN");
  });

  it("accepts a full URL pasted by the user and extracts the slug", () => {
    const result = validateProjectUrl(`${ORIGIN}/s/my-site`, { kind: "generated", origin: ORIGIN, existing: [] });
    expect(result.ok).toBe(true);
  });

  it("refuses to add the same address twice", () => {
    const result = validateProjectUrl("my-site", { kind: "generated", origin: ORIGIN, existing: [url()] });
    expect(!result.ok && result.code).toBe("URL_DUPLICATE");
  });
});

describe("custom domains", () => {
  it("normalises to a bare https hostname", () => {
    const result = validateProjectUrl("http://www.Example.com/", { kind: "custom", origin: ORIGIN, existing: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("https://example.com");
      expect(result.hostname).toBe("example.com");
    }
  });

  it("rejects non-http protocols", () => {
    const ftp = validateProjectUrl("ftp://example.com", { kind: "custom", origin: ORIGIN, existing: [] });
    expect(ftp.ok).toBe(false);
    expect(!ftp.ok && ftp.code).toBe("URL_PROTOCOL");
    expect(urlErrorCopy("URL_PROTOCOL").title).toMatch(/https?/i);
    const js = validateProjectUrl("javascript:alert(1)", { kind: "custom", origin: ORIGIN, existing: [] });
    expect(js.ok).toBe(false);
  });

  it("rejects malformed input", () => {
    const result = validateProjectUrl("not a url at all", { kind: "custom", origin: ORIGIN, existing: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects paths, ports, credentials and query strings", () => {
    for (const raw of ["example.com/app", "example.com:8443", "https://user:pw@example.com", "example.com?next=1"]) {
      const result = validateProjectUrl(raw, { kind: "custom", origin: ORIGIN, existing: [] });
      expect(result.ok, raw).toBe(false);
    }
  });

  it("rejects hostnames the platform owns", () => {
    expect(urlErrorCopy("URL_HOST_INVALID").title).toBeTruthy();
    expect(isValidHostname("localhost")).toBe(false);
    expect(isValidHostname("127.0.0.1")).toBe(false);
    expect(isValidHostname("no-dot")).toBe(false);
    expect(isValidHostname("example.com")).toBe(true);
    expect(isValidHostname("deep.sub.example.co.uk")).toBe(true);
    const reserved = validateProjectUrl(ORIGIN, { kind: "custom", origin: ORIGIN, existing: [] });
    expect(!reserved.ok && reserved.code).toBe("URL_RESERVED");
  });

  it("never presents an unverified domain as openable", () => {
    const pending = url({ kind: "custom", url: "https://example.com", hostname: "example.com", status: "pending_dns", slug: null });
    expect(openableUrlOf(pending, ORIGIN)).toBe("");
    expect(openableUrlOf(url({ status: "active" }), ORIGIN)).toBe(`${ORIGIN}/s/my-site`);
    expect(openableUrlOf(url({ kind: "preview", url: "/api/projects/p1/preview", slug: null }), ORIGIN)).toBe("/api/projects/p1/preview");
  });
});

describe("preview addresses", () => {
  it("are derived from the project id, never typed by the user", () => {
    const result = prepareNewUrl({ raw: "anything", kind: "preview", origin: ORIGIN, projectId: "p1", existing: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("/api/projects/p1/preview");
  });

  it("need a real project", () => {
    const result = prepareNewUrl({ raw: "anything", kind: "preview", origin: ORIGIN, projectId: "", existing: [] });
    expect(result.ok).toBe(false);
  });
});

describe("URL lists", () => {
  it("prefers the primary active entry and never an unverified one", () => {
    const list = [
      url({ id: "a", primary: false, status: "pending_dns", kind: "custom", url: "https://new.com", hostname: "new.com" }),
      url({ id: "b", primary: false, status: "active", url: `${ORIGIN}/s/second`, slug: "second" }),
      url({ id: "c", primary: true, status: "revoked", url: `${ORIGIN}/s/old`, slug: "old" }),
    ];
    expect(primaryUrlOf(list)?.id).toBe("b");
  });

  it("returns null when nothing is reachable", () => {
    expect(primaryUrlOf([url({ status: "failed" })])).toBeNull();
    expect(primaryUrlOf([])).toBeNull();
  });

  it("labels each kind for the UI", () => {
    expect(urlLabel("generated")).toBe("Generated");
    expect(urlLabel("preview")).toBe("Preview");
    expect(urlLabel("custom")).toBe("Custom");
  });

  it("always has human copy for a failure code", () => {
    for (const code of ["URL_MISSING", "URL_INVALID", "URL_PATH_NOT_SUPPORTED", "URL_DUPLICATE", "SLUG_INVALID", "DOMAIN_NOT_SUPPORTED", "WHATEVER"]) {
      const copy = urlErrorCopy(code);
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.detail.length).toBeGreaterThan(8);
    }
  });
});
