// =============================================================================
// MATRIX → QORVYNA: nothing that existed before the rename may stop working.
//
// The rename changed what the product is CALLED. It must not change what
// existing data, installs and deployments DO. These tests pin the bridges:
//   • the agent file protocol still reads blocks written with the old tag;
//   • published sites still see their public env under the old global name;
//   • deployment settings are still read under their old variable names;
//   • identifiers that live in users' browsers, devices and signed payloads
//     were deliberately NOT renamed.
// =============================================================================
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentGenerationIncomplete, hasFileProtocol, parseAgentResponse } from "../src/lib/ai/agent";
import { classifyAgentOutput } from "../src/lib/ai/agent-execution";
import { isAgentSourceReply } from "../src/lib/ai/execution-policy";
import { AGENT_SYSTEM_PROMPT } from "../src/lib/ai/prompts";
import { buildPublishedFiles } from "../src/lib/projects/bundle";
import { brandEnv, brandEnvSource } from "../src/lib/brand-env";
import { BRAND } from "../src/lib/brand";

const block = (tag: string, path: string, body: string) => `<<<${tag} path="${path}">>>\n${body}\n<<<END_${tag}>>>`;

describe("agent file protocol — the pre-rename tag is still read", () => {
  it("parses a MATRIX_FILE block exactly like a QORVYNA_FILE block", () => {
    const legacy = parseAgentResponse(`Here is the page.\n\n${block("MATRIX_FILE", "index.html", "<h1>Hello</h1>")}`);
    const current = parseAgentResponse(`Here is the page.\n\n${block("QORVYNA_FILE", "index.html", "<h1>Hello</h1>")}`);
    expect(legacy.files).toEqual(current.files);
    expect(legacy.files).toEqual([expect.objectContaining({ path: "index.html", content: "<h1>Hello</h1>" })]);
    expect(legacy.reply).toBe("Here is the page.");
  });

  it("never shows either protocol tag to the user", () => {
    for (const tag of ["MATRIX_FILE", "QORVYNA_FILE"]) {
      const complete = parseAgentResponse(`Done.\n\n${block(tag, "a.css", "body{}")}`).reply;
      const dangling = parseAgentResponse(`Done.\n\n<<<${tag} path="a.css">>>\nbody{}`).reply;
      for (const reply of [complete, dangling]) {
        expect(reply).not.toContain("_FILE");
        expect(reply).not.toContain("<<<");
      }
    }
  });

  it("a reply that mixes both spellings yields every file", () => {
    const parsed = parseAgentResponse(`${block("MATRIX_FILE", "index.html", "<p>a</p>")}\n${block("QORVYNA_FILE", "styles.css", "p{}")}`);
    expect(parsed.files.map((file) => file.path).sort()).toEqual(["index.html", "styles.css"]);
  });

  it("detects truncation, file output and Agent source replies with the old tag too", () => {
    expect(agentGenerationIncomplete('<<<MATRIX_FILE path="index.html">>>\n<html>')).toBe(true);
    expect(agentGenerationIncomplete(block("MATRIX_FILE", "index.html", "<html></html>"))).toBe(false);
    expect(hasFileProtocol(block("MATRIX_FILE", "x.js", "1"))).toBe(true);
    expect(hasFileProtocol("no files here")).toBe(false);
    expect(classifyAgentOutput(block("MATRIX_FILE", "index.html", "<h1>Ready</h1>")).state).toBe("FILE_GENERATION");
    expect(isAgentSourceReply("agent", block("MATRIX_FILE", "index.html", "<h1>x</h1>"))).toBe(true);
  });

  it("new output is only ever asked for under the new tag", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain('<<<QORVYNA_FILE path="relative/path/to/file.ext">>>');
    expect(AGENT_SYSTEM_PROMPT).not.toContain("MATRIX_FILE");
  });
});

describe("published sites — the old global still resolves", () => {
  const project = [{ path: "index.html", language: "html", content: "<!DOCTYPE html><html><head></head><body><script>console.log(window.MATRIX_ENV.API)</script></body></html>" }];

  it("window.MATRIX_ENV is an alias of window.QORVYNA_ENV (one object, two names)", () => {
    const html = buildPublishedFiles(project, { API: "https://api.example" }).outFiles.find((file) => file.path === "index.html")!.content;
    expect(html).toContain("window.QORVYNA_ENV=");
    expect(html).toContain("<script data-qorvyna-env-alias>window.MATRIX_ENV=window.QORVYNA_ENV;</script>");
    // The alias is defined after the value, and before the site's own scripts.
    expect(html.indexOf("window.QORVYNA_ENV=")).toBeLessThan(html.indexOf("window.MATRIX_ENV=window.QORVYNA_ENV"));
    expect(html.indexOf("window.MATRIX_ENV=window.QORVYNA_ENV")).toBeLessThan(html.indexOf("console.log(window.MATRIX_ENV.API)"));
  });

  it("the standalone env.js written at publish time defines both names", () => {
    const provider = readFileSync("src/lib/deploy/firestore-provider.ts", "utf8");
    expect(provider).toContain("window.QORVYNA_ENV = ${JSON.stringify(envPublic)};\\nwindow.MATRIX_ENV = window.QORVYNA_ENV;");
  });

  it("nothing is injected when a project has no public env", () => {
    const html = buildPublishedFiles(project).outFiles.find((file) => file.path === "index.html")!.content;
    expect(html).not.toContain("data-qorvyna-env");
  });
});

describe("deployment settings — the old variable names still work", () => {
  it("reads QORVYNA_<NAME>, then MATRIX_<NAME>", () => {
    expect(brandEnv("X", { QORVYNA_X: "new" })).toBe("new");
    expect(brandEnv("X", { MATRIX_X: "old" })).toBe("old");
    expect(brandEnv("X", { QORVYNA_X: "new", MATRIX_X: "old" })).toBe("new");
    expect(brandEnv("X", {})).toBeUndefined();
  });

  it("an empty new variable does not hide a configured old one", () => {
    expect(brandEnv("X", { QORVYNA_X: "", MATRIX_X: "old" })).toBe("old");
    expect(brandEnv("X", { QORVYNA_X: "  ", MATRIX_X: "" })).toBeUndefined();
  });

  it("reports which name supplied the value, never the value", () => {
    expect(brandEnvSource("X", { QORVYNA_X: "secret" })).toBe("QORVYNA");
    expect(brandEnvSource("X", { MATRIX_X: "secret" })).toBe("MATRIX");
    expect(brandEnvSource("X", {})).toBeNull();
  });

  it("every server setting that carried the product name goes through the bridge", () => {
    expect(readFileSync("src/lib/server/request-security.ts", "utf8")).toContain('brandEnv("TRUST_PROXY_HEADERS")');
    const updates = readFileSync("src/lib/server/app-updates.ts", "utf8");
    expect(updates).toContain('brandEnv("ANDROID_APK_URL")');
    expect(updates).toContain('brandEnv("ANDROID_APK_SHA256")');
    expect(readFileSync("src/lib/ai/models/registry.ts", "utf8")).toContain("brandEnv(`MODEL_TPM_");
    const worker = readFileSync("scripts/automation-worker.mjs", "utf8");
    expect(worker).toContain("process.env.QORVYNA_WORKER_TARGET_URL?.trim() || process.env.MATRIX_WORKER_TARGET_URL?.trim()");
    // No server code reads a MATRIX_ variable directly any more.
    for (const file of ["src/lib/server/request-security.ts", "src/lib/server/app-updates.ts", "src/lib/ai/models/registry.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env\.MATRIX_|env\[`MATRIX_/);
    }
  });
});

describe("identifiers that live outside the codebase were NOT renamed", () => {
  // Renaming any of these would sign users out, forget their preferences,
  // break paired devices or orphan installed apps.
  const kept: Array<[string, string]> = [
    ["src/app/layout.tsx", "localStorage.getItem('matrix-theme')"],
    ["src/lib/ambient.ts", "matrix-rain"],
    ["src-tauri/tauri.conf.json", "ai.matrix.desktop"],
    ["mobile/matrix_app/android/app/build.gradle", "top.thamjj13.matrix"],
  ];
  for (const [file, needle] of kept) {
    it(`${file} still contains ${needle}`, () => {
      expect(readFileSync(file, "utf8")).toContain(needle);
    });
  }

  it("the brand config records the former name for migration notes only", () => {
    expect(BRAND.name).toBe("QORVYNA");
    expect(BRAND.formerName).toBe("MATRIX");
  });
});
