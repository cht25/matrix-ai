import { describe, expect, it } from "vitest";
import { buildPreviewHtml } from "../src/lib/projects/preview";
import { contentTypeForPath } from "../src/lib/projects/paths";
import { GroqProvider } from "../src/lib/ai/groq";
import { OpenRouterProvider } from "../src/lib/ai/openrouter";

describe("buildPreviewHtml", () => {
  it("inlines local CSS and JS files into HTML", () => {
    const files = [
      {
        path: "index.html",
        content: `<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body><h1>Test</h1></body></html>`,
        language: "html",
      },
      {
        path: "style.css",
        content: `body { background: red; }`,
        language: "css",
      },
      {
        path: "app.js",
        content: `console.log("hello");`,
        language: "javascript",
      },
    ];

    const preview = buildPreviewHtml(files);
    expect(preview.available).toBe(true);
    expect(preview.html).toContain("<style");
    expect(preview.html).toContain("body { background: red; }");
    expect(preview.html).toContain("<script");
    expect(preview.html).toContain('console.log("hello");');
    expect(preview.html).toContain('<meta name="viewport"');
  });

  it("handles relative links with ./ or /", () => {
    const files = [
      {
        path: "index.html",
        content: `<!DOCTYPE html><html><head><link rel="stylesheet" href="./css/main.css"><script src="/js/index.js"></script></head><body></body></html>`,
        language: "html",
      },
      {
        path: "css/main.css",
        content: `.box { color: blue; }`,
        language: "css",
      },
      {
        path: "js/index.js",
        content: `alert(1);`,
        language: "javascript",
      },
    ];

    const preview = buildPreviewHtml(files);
    expect(preview.available).toBe(true);
    expect(preview.html).toContain(".box { color: blue; }");
    expect(preview.html).toContain("alert(1);");
  });

  it("preserves external CDNs and remote scripts", () => {
    const files = [
      {
        path: "index.html",
        content: `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter"></head><body></body></html>`,
        language: "html",
      },
    ];

    const preview = buildPreviewHtml(files);
    expect(preview.available).toBe(true);
    expect(preview.html).toContain('src="https://cdn.tailwindcss.com"');
    expect(preview.html).toContain('href="https://fonts.googleapis.com/css?family=Inter"');
  });
});

describe("contentTypeForPath", () => {
  it("returns correct MIME types for web assets", () => {
    expect(contentTypeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeForPath("style.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeForPath("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("app.cjs")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("data.json")).toBe("application/json; charset=utf-8");
    expect(contentTypeForPath("image.png")).toBe("image/png");
    expect(contentTypeForPath("image.svg")).toBe("image/svg+xml");
    expect(contentTypeForPath("font.woff2")).toBe("font/woff2");
    expect(contentTypeForPath("audio.mp3")).toBe("audio/mpeg");
  });
});

describe("AI provider token safety", () => {
  it("caps maxTokens on Groq so large Agent requests do not trigger 400 Bad Request", () => {
    const groq = new GroqProvider("gsk_test_key");
    // Access private buildBody to verify payload construction
    const body = (groq as unknown as { buildBody: (req: { model: string; messages: []; maxTokens: number }, stream: boolean) => Record<string, unknown> }).buildBody(
      { model: "openai/gpt-oss-120b", messages: [], maxTokens: 16384 },
      false,
    );
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
    expect(body.max_completion_tokens).toBeLessThanOrEqual(8192);
  });

  it("sets safe maxTokens on OpenRouter", () => {
    const or = new OpenRouterProvider("sk-or-test");
    const body = (or as unknown as { buildBody: (req: { model: string; messages: []; maxTokens: number }, stream: boolean) => Record<string, unknown> }).buildBody(
      { model: "nvidia/nemotron-3-ultra-550b-a55b:free", messages: [], maxTokens: 16384 },
      false,
    );
    expect(body.max_tokens).toBe(16384);
    expect(body.max_completion_tokens).toBe(16384);
  });
});
