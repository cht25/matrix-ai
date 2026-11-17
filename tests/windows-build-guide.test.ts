// =============================================================================
// WINDOWS_BUILD_GUIDE.md and the PowerShell scripts must describe THIS repo.
//
// Same discipline as tests/build-guide.test.ts: a manual build guide that drifts
// from package.json / tauri.conf.json / Cargo.toml is worse than no guide,
// because it makes a failed build look like a broken machine.
//
//   • every `npm run <script>` it names exists in package.json;
//   • every artifact name it promises matches tauri.conf.json + Cargo.toml;
//   • every file it points at exists;
//   • the three scripts keep their failure contract (stop on error, print the
//     command, non-zero exit, no silently skipped step).
// =============================================================================

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const guide = readFileSync(path.join(ROOT, "WINDOWS_BUILD_GUIDE.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const tauri = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as {
  productName: string;
  version: string;
  identifier: string;
  build: { frontendDist: string; beforeBuildCommand: string; devUrl: string };
  bundle: { android?: { minSdkVersion?: number } };
};
const cargo = readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8");
const scripts = ["build-windows.ps1", "build-android-apk.ps1", "build-android-aab.ps1"];

function read(name: string): string {
  return readFileSync(path.join(ROOT, name), "utf8");
}

describe("WINDOWS_BUILD_GUIDE.md matches the repository", () => {
  it("only names npm scripts that exist", () => {
    const referenced = new Set<string>();
    for (const match of guide.matchAll(/npm run ([a-z:0-9-]+)/g)) referenced.add(match[1]);
    expect(referenced.size).toBeGreaterThan(4);
    for (const name of referenced) {
      expect(pkg.scripts[name], `guide references missing script: npm run ${name}`).toBeTruthy();
    }
  });

  it("names the real bundle hook, dist folder and dev URL", () => {
    expect(guide).toContain(tauri.build.beforeBuildCommand);
    expect(guide).toContain(tauri.build.frontendDist.replace("../", ""));
    expect(guide).toContain(tauri.build.devUrl);
  });

  it("uses the real product name, version, identifier and minSdkVersion", () => {
    expect(guide).toContain(tauri.productName);
    expect(guide).toContain(tauri.version);
    expect(guide).toContain(tauri.identifier);
    expect(guide).toContain(String(tauri.bundle.android?.minSdkVersion));
    // Windows installers are named from productName + version.
    expect(guide).toContain(`${tauri.productName}_${tauri.version}_x64-setup.exe`);
    expect(guide).toContain(`${tauri.productName}_${tauri.version}_x64_en-US.msi`);
    // The executable name comes from the Cargo package, not from the product name.
    const cargoName = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? "";
    expect(cargoName).toBe("matrix-ai-desktop");
    expect(guide).toContain(`${cargoName}.exe`);
    // No invented binary name.
    expect(guide).not.toContain("qorvyna.exe");
  });

  it("documents the real Rust and package-manager pins", () => {
    expect(guide).toContain("1.77.2");
    expect(guide).toContain("package-lock.json");
    expect(guide).toContain("npm ci");
    // The lockfile is the contract; `npm install` is never the instruction.
    expect(guide).not.toMatch(/^\s*npm install\s*$/m);
    expect(pkg.devDependencies["@tauri-apps/cli"]).toBeTruthy();
  });

  it("points only at files that exist", () => {
    for (const candidate of [
      "package.json",
      "package-lock.json",
      "next.config.ts",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/capabilities/default.json",
      "scripts/native/build-native-frontend.mjs",
      "scripts/native/patch-android-manifest.mjs",
      ".env.example",
    ]) {
      expect(statSync(path.join(ROOT, candidate)).isFile(), `missing: ${candidate}`).toBe(true);
    }
  });

  it("keeps the bundled-frontend architecture explicit", () => {
    // The WebView loads bundled files, never the live website.
    expect(guide).toMatch(/inside\*\* the app|inside the app/i);
    expect(guide).toMatch(/instead of loading a URL/i);
    expect(guide).toContain("public/native/");
    expect(guide).not.toContain("frontendDist: \"https://");
  });

  it("covers every required build section", () => {
    for (const heading of [
      "## 1. Prerequisites and installation",
      "## 2. Environment variables",
      "## 3. Install dependencies",
      "## 4. Frontend production build",
      "## 5. Tauri Windows development run",
      "## 6. Tauri Windows release build",
      "## 7. Android APK build",
      "## 8. Android AAB build and signing",
      "## 9. Output artifact locations",
      "## 10. Clean rebuild",
      "## 11. Common errors and fixes",
    ]) {
      expect(guide).toContain(heading);
    }
  });

  it("is honest about what could not be executed here", () => {
    expect(guide).toContain("NOT verified by execution");
    expect(guide).toContain("no Windows");
  });
});

describe("the PowerShell scripts keep their failure contract", () => {
  it("all three exist", () => {
    for (const name of scripts) expect(statSync(path.join(ROOT, name)).isFile()).toBe(true);
  });

  it("stop on errors and exit non-zero on failure", () => {
    for (const name of scripts) {
      const text = read(name);
      expect(text, `${name}: missing $ErrorActionPreference`).toContain('$ErrorActionPreference = "Stop"');
      expect(text, `${name}: no failure exit`).toMatch(/exit 1/);
      expect(text, `${name}: no success exit`).toMatch(/exit 0/);
      // A failing native command must be detected and not just logged.
      expect(text, `${name}: does not inspect $LASTEXITCODE`).toContain("$LASTEXITCODE");
      expect(text, `${name}: does not stop after a failed command`).toMatch(/if \(\$code -ne 0\)/);
    }
  });

  it("print each command and its result", () => {
    for (const name of scripts) {
      const text = read(name);
      expect(text, `${name}: does not echo the command`).toMatch(/Write-Host "  > \$pretty"/);
      expect(text, `${name}: does not print the exit code`).toMatch(/exited with code/);
    }
  });

  it("never silently skip a build step", () => {
    for (const name of scripts) {
      const text = read(name);
      // The only permitted skip is the explicit, user-requested one, and it
      // still verifies that the thing it skips is actually present.
      const skips = [...text.matchAll(/\$SkipInstall/g)].length;
      expect(skips).toBeGreaterThan(0);
      expect(text).toContain("-SkipInstall was given but node_modules does not exist");
      // A skip must never be reported as a build result.
      expect(text).not.toMatch(/Write-Ok\s+"Skipped/);
    }
  });

  it("verify the bundle step really produced the native frontend", () => {
    for (const name of scripts) {
      const text = read(name);
      expect(text).toContain("scripts/native/build-native-frontend.mjs");
      expect(text).toContain("public\\native\\app.js");
    }
  });

  it("build Windows through the repository's own script contract", () => {
    const text = read("build-windows.ps1");
    expect(text).toContain('"tauri", "build"');
    expect(text).toContain("bundle\\nsis");
    expect(text).toContain("bundle\\msi");
    // The artifact is verified on disk, so a bundling failure cannot pass.
    expect(text).toContain("No installer (.exe / .msi) was produced");
  });

  it("build Android with the right Tauri flags and verify the artifact", () => {
    const apk = read("build-android-apk.ps1");
    expect(apk).toContain('"tauri", "android", "build", "--apk"');
    expect(apk).toContain("tauri\", \"android\", \"init\"");
    expect(apk).toContain("scripts/native/patch-android-manifest.mjs");
    expect(apk).toContain("No .apk was produced");
    expect(apk).toContain("apksigner");

    const aab = read("build-android-aab.ps1");
    expect(aab).toContain('"tauri", "android", "build", "--aab"');
    expect(aab).toContain("No .aab was produced");
    expect(aab).toContain("jarsigner");
  });

  it("validate the Android toolchain the generated Gradle project needs", () => {
    for (const name of ["build-android-apk.ps1", "build-android-aab.ps1"]) {
      const text = read(name);
      expect(text).toContain("JAVA_HOME");
      expect(text).toContain("ANDROID_HOME");
      expect(text).toContain("NDK");
      expect(text).toContain("aarch64-linux-android");
      expect(text).toContain("rustup");
    }
  });

  it("validate Windows prerequisites the MSVC target needs", () => {
    const text = read("build-windows.ps1");
    expect(text).toContain("windows-msvc");
    expect(text).toContain("WebView2");
    expect(text).toContain("vswhere");
    expect(text).toContain("1.77.2");
  });
});
