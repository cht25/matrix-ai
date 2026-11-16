import { describe, expect, it } from "vitest";
import {
  firebaseAuthProxyUrl,
  firebaseHandlerOrigin,
  isFirebaseHostedAuthDomain,
  normalizeAuthDomainHost,
  resolveFirebaseWebConfig,
} from "@/lib/firebase/web-config";

const API_KEY = "AIzaSyD-EXAMPLE-0123456789abcdefghijklm";
const PROJECT = "matrix-ai-prod";

describe("authDomain resolution", () => {
  it("derives PROJECT_ID.firebaseapp.com when authDomain is not set", () => {
    const resolved = resolveFirebaseWebConfig({ apiKey: API_KEY, projectId: PROJECT });
    expect(resolved.config.authDomain).toBe("matrix-ai-prod.firebaseapp.com");
    expect(resolved.authDomainSource).toBe("derived");
    expect(resolved.sameOriginAuthHandler).toBe(false);
    expect(resolved.configured).toBe(true);
  });

  it("keeps a Firebase-hosted authDomain verbatim", () => {
    const resolved = resolveFirebaseWebConfig({
      apiKey: API_KEY,
      projectId: PROJECT,
      authDomain: "matrix-ai-prod.firebaseapp.com",
    });
    expect(resolved.config.authDomain).toBe("matrix-ai-prod.firebaseapp.com");
    expect(resolved.authDomainSource).toBe("env-firebase-host");
    expect(resolved.sameOriginAuthHandler).toBe(false);
    expect(resolved.warnings).toEqual([]);
  });

  it("accepts the project's .web.app domain too", () => {
    const resolved = resolveFirebaseWebConfig({
      apiKey: API_KEY,
      projectId: PROJECT,
      authDomain: "matrix-ai-prod.web.app",
    });
    expect(resolved.config.authDomain).toBe("matrix-ai-prod.web.app");
    expect(resolved.sameOriginAuthHandler).toBe(false);
  });

  it("strips a pasted scheme/port/path instead of silently replacing the value", () => {
    for (const value of [
      "https://matrix-ai-prod.firebaseapp.com",
      "https://matrix-ai-prod.firebaseapp.com/",
      "matrix-ai-prod.firebaseapp.com:443",
    ]) {
      const resolved = resolveFirebaseWebConfig({ apiKey: API_KEY, projectId: PROJECT, authDomain: value });
      expect(resolved.config.authDomain, value).toBe("matrix-ai-prod.firebaseapp.com");
      expect(resolved.warnings.some((w) => w.includes("bare hostname")), value).toBe(true);
    }
  });

  it("does NOT replace a custom authDomain blindly — it enables the same-origin handler", () => {
    const resolved = resolveFirebaseWebConfig({
      apiKey: API_KEY,
      projectId: PROJECT,
      authDomain: "qorvyna.thamjj13.top",
      appOrigin: "https://qorvyna.thamjj13.top",
    });
    expect(resolved.config.authDomain).toBe("qorvyna.thamjj13.top");
    expect(resolved.authDomainSource).toBe("env-custom-host");
    // The /__/auth reverse proxy must serve Firebase's handler at that host.
    expect(resolved.sameOriginAuthHandler).toBe(true);
    expect(resolved.warnings).toEqual([]);
  });

  it("warns when a custom authDomain is not the site's own origin", () => {
    const resolved = resolveFirebaseWebConfig({
      apiKey: API_KEY,
      projectId: PROJECT,
      authDomain: "auth.somewhere-else.top",
      appOrigin: "https://qorvyna.thamjj13.top",
    });
    expect(resolved.config.authDomain).toBe("auth.somewhere-else.top");
    expect(resolved.warnings.some((w) => w.includes("does not match the site origin"))).toBe(true);
  });

  it("warns when a custom authDomain has no configured site origin to compare with", () => {
    const resolved = resolveFirebaseWebConfig({
      apiKey: API_KEY,
      projectId: PROJECT,
      authDomain: "qorvyna.thamjj13.top",
    });
    expect(resolved.sameOriginAuthHandler).toBe(true);
    expect(resolved.warnings.some((w) => w.includes("NEXT_PUBLIC_APP_URL is not set"))).toBe(true);
  });

  it("falls back to the Firebase handler for an unusable authDomain", () => {
    const resolved = resolveFirebaseWebConfig({ apiKey: API_KEY, projectId: PROJECT, authDomain: "not a host" });
    expect(resolved.config.authDomain).toBe("matrix-ai-prod.firebaseapp.com");
    expect(resolved.authDomainSource).toBe("derived");
    expect(resolved.sameOriginAuthHandler).toBe(false);
    expect(resolved.warnings.some((w) => w.includes("not a usable hostname"))).toBe(true);
  });

  it("refuses to derive anything from a placeholder project id", () => {
    const resolved = resolveFirebaseWebConfig({ apiKey: "AIzaPlaceholderNotUsed", projectId: "your-project-id" });
    expect(resolved.configured).toBe(false);
    expect(resolved.config.authDomain).toBe("");
  });

  it("treats .env.example placeholders as unconfigured but keeps a real-looking key", () => {
    expect(resolveFirebaseWebConfig({ apiKey: "YOUR-API-KEY", projectId: PROJECT }).configured).toBe(false);
    expect(resolveFirebaseWebConfig({ apiKey: API_KEY, projectId: "your-project-id" }).configured).toBe(false);
    const odd = resolveFirebaseWebConfig({ apiKey: "not-a-google-key", projectId: PROJECT }) satisfies {
      configured: boolean;
      warnings: string[];
    };
    expect(odd.configured).toBe(true);
    expect(odd.warnings.some((w) => w.includes("does not look like a Google API key"))).toBe(true);
  });

  it("strips quotes and whitespace the way host dashboards store values", () => {
    const resolved = resolveFirebaseWebConfig({
      apiKey: ` "${API_KEY}" `,
      projectId: `"${PROJECT}"`,
      authDomain: '"matrix-ai-prod.firebaseapp.com"',
    });
    expect(resolved.configured).toBe(true);
    expect(resolved.config.projectId).toBe(PROJECT);
    expect(resolved.config.authDomain).toBe("matrix-ai-prod.firebaseapp.com");
  });

  it("never includes any secret material in the web config", () => {
    const resolved = resolveFirebaseWebConfig({ apiKey: API_KEY, projectId: PROJECT });
    expect(Object.keys(resolved.config).sort()).toEqual([
      "apiKey",
      "appId",
      "authDomain",
      "messagingSenderId",
      "projectId",
    ]);
  });
});

describe("hostname helpers", () => {
  it("recognises Firebase-hosted domains", () => {
    expect(isFirebaseHostedAuthDomain("matrix-ai-prod.firebaseapp.com")).toBe(true);
    expect(isFirebaseHostedAuthDomain("matrix-ai-prod.web.app")).toBe(true);
    expect(isFirebaseHostedAuthDomain("qorvyna.thamjj13.top")).toBe(false);
  });

  it("normalizes a hostname and reports whether it was altered", () => {
    expect(normalizeAuthDomainHost(" HTTPS://Example.COM/path ")).toEqual({ host: "example.com", altered: true });
    expect(normalizeAuthDomainHost("example.com")).toEqual({ host: "example.com", altered: false });
    expect(normalizeAuthDomainHost("localhost")).toEqual({ host: "", altered: true });
  });
});

describe("reverse-proxy target", () => {
  it("targets the project's own Firebase auth handler", () => {
    expect(firebaseHandlerOrigin(PROJECT)).toBe("https://matrix-ai-prod.firebaseapp.com");
    expect(firebaseAuthProxyUrl(PROJECT, ["handler"], "?apiKey=x")).toBe(
      "https://matrix-ai-prod.firebaseapp.com/__/auth/handler?apiKey=x",
    );
    expect(firebaseAuthProxyUrl(PROJECT, [])).toBe("https://matrix-ai-prod.firebaseapp.com/__/auth/handler");
  });

  it("cannot be used to escape the /__/auth prefix", () => {
    expect(firebaseAuthProxyUrl(PROJECT, ["..", "admin"])).toBe(
      "https://matrix-ai-prod.firebaseapp.com/__/auth/admin",
    );
    expect(firebaseAuthProxyUrl(PROJECT, ["", "iframe", "."])).toBe(
      "https://matrix-ai-prod.firebaseapp.com/__/auth/iframe",
    );
  });

  it("is inert without a usable project id", () => {
    expect(firebaseHandlerOrigin("")).toBe("");
    expect(firebaseAuthProxyUrl("", ["handler"])).toBe("");
  });
});
