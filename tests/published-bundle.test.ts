import { describe, expect, it } from "vitest";
import { buildPublishedFiles, inlineHtmlDocument, resolveFile } from "../src/lib/projects/bundle";
import type { ProjectFile } from "../src/lib/projects/paths";

const project: ProjectFile[] = [
  {
    path: "index.html",
    language: "html",
    content:
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/styles.css"><script src="js/app.js"></script></head><body><h1>Hello</h1><img src="img/logo.svg"><link rel="icon" href="favicon.png"></body></html>',
  },
  { path: "css/styles.css", language: "css", content: "body{background:#000} h1{color:red}" },
  { path: "js/app.js", language: "javascript", content: 'console.log("works");' },
  { path: "img/logo.svg", language: "xml", content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>' },
  { path: "favicon.png", language: "image", content: "FAVICON==", encoding: "base64" },
  {
    path: "about.html",
    language: "html",
    content:
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/styles.css"></head><body><a href="index.html">home</a></body></html>',
  },
];

describe("buildPublishedFiles", () => {
  it("inlines all local CSS/JS/assets into a self-contained index page", () => {
    const { outFiles, standalone } = buildPublishedFiles(project, { API_KEY: "x" });
    expect(standalone?.path).toBe("index.html");
    const idx = outFiles.find((f) => f.path === "index.html")!;
    expect(idx.content).toContain("<style");
    expect(idx.content).toContain("h1{color:red}");
    expect(idx.content).toContain('console.log("works")');
    expect(idx.content).toContain("data:image/svg+xml");
    expect(idx.content).toContain("window.MATRIX_ENV");
    expect(idx.content).not.toContain('src="js/app.js"');
    expect(idx.content).not.toContain('href="css/styles.css"');
    // Sibling pages and source files are still published for deeper links.
    expect(outFiles.some((f) => f.path === "about.html")).toBe(true);
    expect(outFiles.some((f) => f.path === "js/app.js")).toBe(true);
  });

  it("leaves remote CDN references untouched", () => {
    const files: ProjectFile[] = [
      {
        path: "index.html",
        language: "html",
        content:
          '<html><head><script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css"></head><body></body></html>',
      },
    ];
    const { outFiles } = buildPublishedFiles(files);
    const idx = outFiles.find((f) => f.path === "index.html")!;
    expect(idx.content).toContain("https://cdn.example.com/x.js");
    expect(idx.content).toContain("https://fonts.googleapis.com/css");
  });

  it("returns no standalone page when there is no HTML", () => {
    const { standalone } = buildPublishedFiles([{ path: "a.txt", language: "text", content: "hi" }]);
    expect(standalone).toBeNull();
  });

  it("resolves references with ./ and base-relative paths", () => {
    const css = resolveFile(project, "./css/styles.css");
    expect(css?.path).toBe("css/styles.css");
    const js = resolveFile(project, "app.js", "js/other.js");
    expect(js?.path).toBe("js/app.js");
  });

  it("inlines url() resources inside CSS", () => {
    const html =
      '<html><head><style>.bg{background:url("img/logo.svg")}</style></head><body></body></html>';
    const { html: out } = inlineHtmlDocument(html, project, "index.html");
    expect(out).toContain("data:image/svg+xml");
  });
});
