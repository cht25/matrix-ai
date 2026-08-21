import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// User-content surfaces (published sites, project previews) are served from
// the app's own origin. Unless the HTML responses carry a CSP sandbox
// directive, their scripts could issue credentialed same-origin calls to
// /api/rpc (stored-XSS → account actions). These assertions lock the fix in.
describe("user-content sandboxing", () => {
  it("/s/[slug] published-site responses sandbox HTML to an opaque origin", () => {
    const src = readFileSync(join(__dirname, "../src/app/s/[slug]/[[...path]]/route.ts"), "utf8");
    expect(src).toContain("sandbox");
    expect(src).toMatch(new RegExp("text\\\\/html", "i"));
    expect(src).toContain("object-src 'none'");
    expect(src).toContain("X-Frame-Options");
  });

  it("/api/projects preview responses sandbox HTML to an opaque origin", () => {
    const src = readFileSync(join(__dirname, "../src/app/api/projects/[id]/preview/[[...path]]/route.ts"), "utf8");
    expect(src).toContain("sandbox");
    expect(src).toMatch(new RegExp("text\\\\/html", "i"));
    expect(src).toContain("object-src 'none'");
    expect(src).toContain("private, no-store");
  });

  it("/api/rpc rejects cross-origin browser requests", () => {
    const src = readFileSync(join(__dirname, "../src/app/api/rpc/route.ts"), "utf8");
    expect(src).toContain("BAD_ORIGIN");
    expect(src).toContain("x-forwarded-host");
  });

  it("/api/rpc never leaks internal error details to the client", () => {
    const src = readFileSync(join(__dirname, "../src/app/api/rpc/route.ts"), "utf8");
    expect(src).not.toMatch(/INTERNAL[^}]*detail:\s*(err|error|msg)/);
  });
});
