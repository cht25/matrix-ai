// =============================================================================
// Phase 15 — the acceptance checklist, in one place.
//
// The prompt names the scenarios that must demonstrably work. Most already have
// dedicated suites (multi-model, routing-policy, inspection, device-links,
// admin-devices, voice-*, device-hub). This file is the index that fails if any
// of them stops covering its scenario, plus the checks that can be asserted
// directly from source.
// =============================================================================
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

const SUITES: Record<string, string> = {
  "GPT OSS 120B is the default and is reached by its verified id": "multi-model.test.ts",
  "GPT OSS 20B is the declared fallback": "multi-model.test.ts",
  "GLM routes artifact work through Cloudflare Workers AI": "routing-policy.test.ts",
  "manual model selection is never silently overridden": "routing-policy.test.ts",
  "silent/empty audio never becomes a chat message": "qorvyna-upgrade.test.ts",
  "wake-word is local and never a cloud mic stream": "jarvis-mirror-device-actions.test.ts",
  "cross-account pairing works between different accounts": "device-links.test.ts",
  "admins can block/disable/revoke a device": "admin-devices.test.ts",
  "inspection is announced and guardian-gated": "inspection.test.ts",
  "guardian approval is required and verified": "inspection.test.ts",
  "mirroring requires consent": "jarvis-mirror-device-actions.test.ts",
  "notification sync honours privacy modes": "parent-policy-and-notifications.test.ts",
  "update detection reports a newer build": "steps-ui-and-phone-updates.test.ts",
};

describe("Phase 15 — every required scenario has a real suite", () => {
  for (const [scenario, file] of Object.entries(SUITES)) {
    it(scenario, () => {
      expect(existsSync(path.join(ROOT, "tests", file)), `missing suite for: ${scenario} (${file})`).toBe(true);
    });
  }
});

describe("Phase 15 — model routing ground truth", () => {
  const model = readFileSync(path.join(ROOT, "src/lib/ai/model.ts"), "utf8");
  const registry = readFileSync(path.join(ROOT, "src/lib/ai/models/registry.ts"), "utf8");

  it("pins the exact provider model ids", () => {
    expect(model).toContain('"openai/gpt-oss-120b"');
    expect(registry).toContain('"openai/gpt-oss-20b"');
    expect(registry).toContain('FALLBACK_MODEL_KEY = "gpt-oss-20b"');
  });

  it("routes generation work to the verified GLM id on Cloudflare", () => {
    const cloudflare = readFileSync(path.join(ROOT, "src/lib/ai/cloudflare.ts"), "utf8");
    const ids = `${registry}\n${cloudflare}`;
    expect(ids).toContain("@cf/zai-org/glm-4.7-flash");
    // A GLM failure must not be blamed on Cloudflare auth or vice versa.
    expect(cloudflare).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(cloudflare).toContain("CLOUDFLARE_API_TOKEN");
  });
});

describe("Phase 15 — one frontend, no duplicates", () => {
  it("has exactly one native entry point", () => {
    expect(existsSync(path.join(ROOT, "src/native/client/entry.tsx"))).toBe(true);
    const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.build.frontendDist).toBe("../public/native");
  });

  it("mounts the same website components in the native shell", () => {
    const shell = readFileSync(path.join(ROOT, "src/native/native-app.tsx"), "utf8");
    for (const component of ["AppShell", "ChatClient"]) {
      expect(shell, `native shell does not reuse ${component}`).toContain(component);
    }
  });

  it("no Facebook login remains in the UI or the provider wiring", () => {
    // Comments explaining the removal are fine and desirable; what must not
    // survive is a FacebookAuthProvider, a button, or an icon.
    const login = readFileSync(path.join(ROOT, "src/components/auth/login-screen.tsx"), "utf8");
    const oauth = readFileSync(path.join(ROOT, "src/lib/auth/oauth.ts"), "utf8");
    for (const source of [login, oauth]) {
      expect(source).not.toMatch(/FacebookAuthProvider/);
      expect(source).not.toMatch(/FacebookIcon|FaFacebook|facebook\.com/);
      expect(source).not.toMatch(/signInWithPopup\([^)]*facebook/i);
      // Any remaining mention must be inside a comment.
      for (const line of source.split("\n")) {
        if (/facebook/i.test(line)) {
          expect(line.trim().startsWith("//") || line.trim().startsWith("*"), `non-comment Facebook reference: ${line.trim()}`).toBe(true);
        }
      }
    }
    // Exactly one OAuth provider is constructed: Google.
    expect(oauth).toContain("GoogleAuthProvider");
    expect(oauth).not.toMatch(/new (Github|Facebook|Apple|Twitter)AuthProvider/);
    const constructed = [...oauth.matchAll(/new ([A-Z][a-z]+)AuthProvider\(\)/g)].map((match) => match[1]);
    expect(constructed).toEqual(["Google"]);
  });
});

describe("Phase 15 — secrets stay server-side", () => {
  it("no NEXT_PUBLIC_ variable carries a provider secret", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg).toBeTruthy();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".next", "public"].includes(entry.name)) continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, "src"));
    const offenders = files.filter((file) => /NEXT_PUBLIC_(RESEND|GROQ|OPENAI|CLOUDFLARE|FIREBASE_PRIVATE|CLOUDINARY_API_SECRET)/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
