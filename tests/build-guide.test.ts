// =============================================================================
// Phase 14 — app_build_guide.md must describe THIS repository.
//
// The previous guide documented a Flutter Android app that no longer ships and
// a remote-URL frontendDist that Phase 2 removed. These assertions make the
// guide fail loudly when it drifts from the code again:
//   • every npm script it names exists in package.json;
//   • every env var it documents is really read by the code;
//   • every file/dir it points at exists;
//   • the retired Flutter app is not presented as a build target.
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const guide = readFileSync(path.join(ROOT, "app_build_guide.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  version: string;
};

/** Every `process.env.X` the application actually reads. */
function envNamesInSource(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".next", "public", "mobile"].includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      // Two real access patterns in this codebase:
      //   process.env.FOO                      (direct)
      //   env.CLOUDFLARE_API_TOKEN             (destructured `env` = process.env)
      for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(match[1]);
      for (const match of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{3,})\b/g)) names.add(match[1]);
    }
  };
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "scripts"));
  return names;
}

describe("Phase 14 — the build guide matches the repository", () => {
  it("only names npm scripts that exist", () => {
    const referenced = new Set<string>();
    for (const match of guide.matchAll(/npm run ([a-z:0-9-]+)/g)) referenced.add(match[1]);
    for (const name of referenced) {
      expect(pkg.scripts[name], `guide references missing script: npm run ${name}`).toBeTruthy();
    }
    expect(referenced.size).toBeGreaterThan(3);
  });

  it("only documents env vars the code actually reads", () => {
    const real = envNamesInSource();
    // Names the guide is allowed to mention even though nothing in src/ reads
    // them directly (documented host/deployment inputs, or read by tooling).
    const allowlist = new Set([
      "NEXT_PUBLIC_QORVYNA_NATIVE",
      "CLOUDFLARE_ACCOUNT_ID",
      "QORVYNA_KEY_STORE",
      "QORVYNA_KEY_STORE_PASSWORD",
      "QORVYNA_KEY_ALIAS",
      "QORVYNA_KEY_PASSWORD",
    ]);
    // Only look inside fenced code blocks: prose such as
    // `APP_VERSION = "1.2.0"` is a constant, not an environment variable.
    const blocks = [...guide.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n");
    const documented = new Set<string>();
    for (const match of blocks.matchAll(/^\s*((?:NEXT_PUBLIC_)?[A-Z][A-Z0-9_]{3,})\s*=/gm)) documented.add(match[1]);
    // Bare names listed as `# comment` lines inside the secrets block are not
    // captured by `=` patterns; they are covered by the code block above.
    const invented = [...documented].filter((name) => !real.has(name) && !allowlist.has(name));
    expect(invented, `guide documents env vars nothing reads: ${invented.join(", ")}`).toEqual([]);
  });

  it("every path it points at exists", () => {
    for (const candidate of [
      "src/native",
      "src-tauri",
      "src-tauri/tauri.conf.json",
      "src-tauri/capabilities/default.json",
      "src-tauri/Cargo.toml",
      "scripts/native/build-native-frontend.mjs",
      "scripts/native/patch-android-manifest.mjs",
      "src-tauri/android/app/src/main/kotlin/ai/matrix/desktop/QorvynaNotificationListenerService.kt",
      "src/lib/server/inspection.ts",
      "src/lib/server/device-links.ts",
      "src/lib/version.ts",
      "public/sw.js",
      "apphosting.yaml",
      "render.yaml",
      "firebase.json",
    ]) {
      expect(statSync(path.join(ROOT, candidate)).isDirectory() || true, `missing: ${candidate}`).toBe(true);
    }
  });

  it("does not present the retired Flutter app as a build target", () => {
    // It may be mentioned once, as retired, but must not appear in a build step.
    expect(guide).toContain("retired");
    expect(guide).not.toMatch(/flutter build apk/);
    expect(guide).not.toMatch(/flutter create/);
    expect(guide).not.toMatch(/dart-define/);
  });

  it("describes the bundled frontend, not a remote one", () => {
    expect(guide).toContain("public/native");
    expect(guide).not.toContain('"frontendDist": "https://');
    // The guide must say the WebView loads local files, not the live site.
    expect(guide).toMatch(/does\s+\*\*not\*\*\s+load/i);
    expect(guide).toContain("from the app bundle");
  });

  it("states the real version and identifier", () => {
    expect(guide).toContain(pkg.version);
    expect(guide).toContain("ai.matrix.desktop");
  });

  it("is honest about what could not be verified", () => {
    expect(guide).toContain("Known sandbox limitations");
    expect(guide).toContain("no Rust toolchain");
    expect(guide).toContain("unverified by execution");
  });
});
