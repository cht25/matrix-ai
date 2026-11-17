// =============================================================================
// Phase 2/9/13 — the native build must actually run from a clean checkout.
//
// `package.json` shipped `tauri` scripts long before `@tauri-apps/cli` was a
// dependency, so `npm run tauri:build` failed with "tauri: not found". These
// tests pin the wiring that makes the documented commands real.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};
const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const manifest = readFileSync(path.join(ROOT, "src-tauri/Cargo.toml"), "utf8");

describe("Phase 13 — build tooling resolves", () => {
  it("declares the Tauri CLI so `tauri` scripts work on a clean install", () => {
    const versions = { ...pkg.devDependencies, ...pkg.dependencies };
    expect(versions["@tauri-apps/cli"]).toBeTruthy();
    expect(versions["@tauri-apps/cli"]).toMatch(/^\^?2/);
  });

  it("every documented native script exists and points at a real command", () => {
    for (const name of ["tauri:dev", "tauri:build", "android:init", "android:manifest", "android:build", "windows:build", "native:check"]) {
      expect(pkg.scripts[name], `missing script ${name}`).toBeTruthy();
    }
    // Native builds must regenerate the bundle first, otherwise they ship a
    // stale frontend. `tauri dev` uses devUrl and must not.
    expect(pkg.scripts["android:build"]).toContain("build-native-frontend.mjs");
    expect(pkg.scripts["windows:build"]).toContain("build-native-frontend.mjs");
    expect(pkg.scripts["android:init"]).toContain("patch-android-manifest");
  });
});

describe("Phase 2 — the app bundles the real frontend", () => {
  it("ships the local bundle, never a remote URL", () => {
    expect(conf.build.frontendDist).toBe("../public/native");
    expect(conf.build.frontendDist).not.toMatch(/^https?:/);
    expect(conf.app.windows[0].url).toBe("index.html");
  });

  it("runs the bundler before building", () => {
    expect(conf.build.beforeBuildCommand).toContain("scripts/native/build-native-frontend.mjs");
  });

  it("keeps a non-null CSP that still allows the real API origin", () => {
    const csp = conf.app.security.csp;
    expect(csp).toBeTruthy();
    // Tauri 2 accepts an object of directives; serialise to assert on the text.
    const text = typeof csp === "string" ? csp : JSON.stringify(csp);
    expect(text).toContain("qorvyna.thamjj13.top");
    expect(text).toContain("object-src");
    expect(JSON.parse(text).default ?? JSON.parse(text)["default-src"]).toContain("'self'");
  });

  it("targets every desktop platform with the documented identifier", () => {
    expect(conf.identifier).toBe("ai.matrix.desktop");
    // "all" covers linux deb/appimage, macOS dmg and Windows nsis/msi.
    expect(conf.bundle.targets).toBe("all");
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.icon.length).toBeGreaterThan(0);
  });
});

describe("Phase 9 — Android service wiring", () => {
  it("ships the listener source inside the Tauri package (not the retired Flutter tree)", () => {
    const kotlin = readFileSync(
      path.join(ROOT, "src-tauri/android/app/src/main/kotlin/ai/matrix/desktop/QorvynaNotificationListenerService.kt"),
      "utf8",
    );
    expect(kotlin).toContain("package ai.matrix.desktop");
    expect(kotlin).toContain("NotificationListenerService()");
  });

  it("declares the notification plugin the Rust side depends on", () => {
    expect(manifest).toContain("tauri-plugin-notification");
    expect(manifest).toContain("tauri-plugin-global-shortcut");
  });
});
