// =============================================================================
// Build validation before publish (§14, §15)
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  blockingIssues,
  bracketBalance,
  buildFixPrompt,
  formatIssues,
  lineAt,
  neutralizeCode,
  validateProject,
} from "@/lib/deploy/validate";
import type { ProjectFile } from "@/lib/projects/paths";

function file(path: string, content: string): ProjectFile {
  return { path, content, language: path.split(".").pop() ?? "text" } as ProjectFile;
}

const GOOD_SITE = [
  file("index.html", "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main><img src=\"logo.svg\" alt=\"Logo\"></main><script src=\"app.js\"></script></body></html>"),
  file("styles.css", "body { color: #111; background: url(bg.png); }"),
  file("app.js", "const items = [1, 2, 3];\nitems.forEach((n) => console.log(n));"),
  file("logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"></svg>"),
  file("bg.png", "binary"),
];

describe("validateProject — a sound static site", () => {
  it("passes every supported check and is not blocking", () => {
    const report = validateProject(GOOD_SITE, { bundle: { ran: true, ok: true, outFileCount: 4 } });
    expect(report.blocking).toBe(false);
    expect(report.errors).toBe(0);
    expect(report.checks.map((check) => check.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(report.summary).toMatch(/passed/i);
  });

  it("reports a missing asset as a blocking failure", () => {
    const broken = GOOD_SITE.filter((item) => item.path !== "bg.png");
    const report = validateProject(broken, { bundle: { ran: true, ok: true } });
    const assets = report.checks.find((check) => check.id === "assets");
    expect(assets?.status).toBe("failed");
    expect(assets?.issues[0]?.message).toMatch(/bg\.png/);
    expect(report.blocking).toBe(true);
  });

  it("points at the file and line of the problem", () => {
    const report = validateProject([
      file("index.html", "<!doctype html><html><body><a href=\"missing.html\">go</a><img src=\"hero.png\"></body></html>"),
      file("styles.css", "a { color: red }"),
    ]);
    const routes = report.checks.find((check) => check.id === "routes");
    expect(routes?.status).toBe("failed");
    expect(routes?.issues[0]?.path).toBe("index.html");
    expect(formatIssues(blockingIssues(report), 5)).toMatch(/index\.html:1/);
    expect(formatIssues(blockingIssues(report))).toContain("missing.html");
  });
});

describe("validateProject — syntax problems are real failures", () => {
  it("flags unbalanced braces with a line number", () => {
    const report = validateProject([file("index.html", "<!doctype html><html><body></html>"), file("app.js", "function broken() {\n  if (a) {\n}")]);
    const syntax = report.checks.find((check) => check.id === "syntax");
    expect(syntax?.status).toBe("failed");
    expect(syntax?.issues.some((issue) => issue.path === "app.js")).toBe(true);
    expect(report.blocking).toBe(true);
  });

  it("flags invalid JSON manifests", () => {
    const report = validateProject([file("index.html", "<!doctype html><html><body></body></html>"), file("data.json", "{ \"a\": 1,}")]);
    expect(report.checks.find((check) => check.id === "syntax")?.status).toBe("failed");
  });

  it("flags HTML tags that are never closed", () => {
    const report = validateProject([file("index.html", "<!doctype html><html><body><div><section></body></html>")]);
    expect(report.checks.find((check) => check.id === "syntax")?.issues.length).toBeGreaterThan(0);
  });

  it("does not confuse strings and comments with unbalanced code", () => {
    expect(bracketBalance(neutralizeCode("const s = ')}{'; // comment )")).unbalanced).toEqual([]);
  });
});

describe("validateProject — skipped is never presented as a pass", () => {
  it("does not verify TSX/JSX and says so", () => {
    const report = validateProject([file("src/App.jsx", "export default () => <div>hi</div>"), file("index.html", "<!doctype html><html><body></body></html>")], {
      bundle: { ran: false, reason: "No bundler is installed on this host." },
    });
    const syntax = report.checks.find((check) => check.id === "syntax");
    expect(syntax?.status).toBe("skipped");
    expect(syntax?.message).toMatch(/not verified/i);
    expect(report.checks.find((check) => check.id === "build")?.status).toBe("skipped");
  });

  it("refuses to publish a framework project this host cannot build", () => {
    const report = validateProject([file("package.json", "{\n  \"dependencies\": { \"react\": \"^18.2.0\", \"vite\": \"^5.0.0\" }\n}"), file("src/main.jsx", "ReactDOM.render(<App/>)")]);
    const dependencies = report.checks.find((check) => check.id === "dependencies");
    expect(dependencies?.status).toBe("failed");
    expect(dependencies?.message).toMatch(/bundler/i);
    expect(report.blocking).toBe(true);
  });

  it("still publishes a framework manifest that ships a static entry page", () => {
    const report = validateProject([file("package.json", "{\"dependencies\":{\"react\":\"^18.2.0\"}}"), file("index.html", "<!doctype html><html><body></body></html>")]);
    const dependencies = report.checks.find((check) => check.id === "dependencies");
    expect(dependencies?.status).toBe("skipped");
    expect(dependencies?.message).toMatch(/CDN/i);
    expect(report.blocking).toBe(false);
  });

  it("skips the build check when no bundle was attempted", () => {
    const report = validateProject([file("index.html", "<!doctype html><html><body></body></html>")]);
    expect(report.checks.find((check) => check.id === "build")?.status).toBe("skipped");
    expect(report.blocking).toBe(false);
  });

  it("requires an entry page for a publishable site", () => {
    const report = validateProject([file("about.html", "<!doctype html><html><body></body></html>")]);
    expect(report.checks.find((check) => check.id === "build")?.status).toBe("failed");
    expect(report.blocking).toBe(true);
  });
});

describe("fix loop helpers", () => {
  it("lineAt counts newlines up to an offset", () => {
    const text = "one\ntwo\nthree";
    expect(lineAt(text, 0)).toBe(1);
    expect(lineAt(text, text.indexOf("three"))).toBe(3);
    expect(lineAt(text, 9999)).toBe(3);
  });

  it("buildFixPrompt quotes only the failing files", () => {
    const failing = [file("index.html", "<!doctype html><html><body><img src=\"gone.png\"></body></html>")];
    const report = validateProject(failing);
    const prompt = buildFixPrompt(report, failing.length);
    expect(prompt).toContain("index.html");
    expect(prompt).toContain("gone.png");
    expect(prompt).toContain("MATRIX_FILE");
  });
});
