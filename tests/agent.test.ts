import { afterEach, describe, expect, it, vi } from "vitest";
import { agentGenerationIncomplete, filesFromSnippet, isCodingRequest, parseAgentResponse, safeAgentPath } from "../src/lib/ai/agent";
import { OPENROUTER_MODELS, OpenRouterProvider } from "../src/lib/ai/openrouter";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("coding auto-detection", () => {
  it("routes explicit coding work and source attachments to the coding model", () => {
    expect(isCodingRequest("Build a responsive Next.js dashboard")).toBe(true);
    expect(isCodingRequest("Please fix the bug", [{ name: "src/app.tsx", content: "export default 1" }])).toBe(true);
  });

  it("keeps ordinary all-in-one chat in general mode", () => {
    expect(isCodingRequest("Help me plan a three-day study schedule")).toBe(false);
    expect(isCodingRequest("Rewrite this paragraph to sound friendly")).toBe(false);
  });
});

describe("Agent artifact protocol", () => {
  it("extracts complete reviewable files and removes protocol blocks from the reply", () => {
    const parsed = parseAgentResponse(`I created a small site.\n\n<<<MATRIX_FILE path="index.html">>>\n<h1>Hello</h1>\n<<<END_MATRIX_FILE>>>\n<<<MATRIX_FILE path="styles/app.css">>>\nh1 { color: blue; }\n<<<END_MATRIX_FILE>>>\n\nVerify it in Live Preview.`);
    expect(parsed.reply).toContain("I created a small site");
    expect(parsed.reply).toContain("Verify it in Live Preview");
    expect(parsed.reply).not.toContain("MATRIX_FILE");
    expect(parsed.files.map((file) => file.path)).toEqual(["index.html", "styles/app.css"]);
    expect(parsed.files[0].language).toBe("html");
  });

  it("rejects traversal, absolute and .git paths", () => {
    expect(safeAgentPath("../secret.txt")).toBeNull();
    expect(safeAgentPath("/etc/passwd")).toBeNull();
    expect(safeAgentPath(".git/config")).toBeNull();
    expect(safeAgentPath("src/app/page.tsx")).toBe("src/app/page.tsx");
  });

  it("recovers files from filename-tagged Markdown fences (info string)", () => {
    const parsed = parseAgentResponse(
      "Here is the site.\n\n```html index.html\n<h1>Hello</h1>\n```\n\n```css css/style.css\nh1 { color: blue; }\n```\n",
    );
    expect(parsed.files.map((f) => f.path)).toEqual(["index.html", "css/style.css"]);
    expect(parsed.reply).not.toContain("<h1>Hello</h1>");
    expect(parsed.reply).toContain("Here is the site");
  });

  it("recovers files from bold filename headers above fences", () => {
    const parsed = parseAgentResponse(
      "Done.\n\n**pages/about.html**\n```html\n<p>About</p>\n```\n",
    );
    expect(parsed.files.map((f) => f.path)).toEqual(["pages/about.html"]);
    expect(parsed.reply).not.toContain("<p>About</p>");
  });

  it("leaves bare filename-less code fences in the reply (not files)", () => {
    const parsed = parseAgentResponse("Conceptual answer:\n\n```html\n<span>example</span>\n```\n");
    expect(parsed.files).toEqual([]);
    expect(parsed.reply).toContain("<span>example</span>");
  });

  it("strips dangling protocol markers from the reply", () => {
    const parsed = parseAgentResponse("See below.\n\n<<<MATRIX_FILE path=\"index.html\">>>\n<h1>Hi</h1>\n");
    expect(parsed.reply).not.toContain("MATRIX_FILE");
  });

  it("detects truncated MATRIX_FILE output", () => {
    expect(agentGenerationIncomplete('<<<MATRIX_FILE path="index.html">>>\n<html>')).toBe(true);
    expect(agentGenerationIncomplete('<<<MATRIX_FILE path="index.html">>>\n<html></html>\n<<<END_MATRIX_FILE>>>')).toBe(false);
  });

  it("turns a snippet into publishable files without an upload", () => {
    const html = filesFromSnippet("html", "<h1>Hi</h1>");
    expect(html[0].path).toBe("index.html");
    const css = filesFromSnippet("css", "body{margin:0}");
    expect(css.some((f) => f.path === "index.html")).toBe(true);
  });
});

describe("OpenRouterProvider", () => {
  it("uses OpenRouter and NVIDIA Nemotron 3 Ultra with server-side auth", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "done" } }], model: OPENROUTER_MODELS.coding, usage: { total_tokens: 9 } }),
    }) as unknown as typeof fetch;
    const provider = new OpenRouterProvider("sk-or-test", "https://matrix.example");
    const result = await provider.chat({ model: OPENROUTER_MODELS.coding, messages: [{ role: "user", content: "build" }] });
    expect(result.content).toBe("done");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toContain("nvidia/nemotron-3-ultra");
    expect(body.max_completion_tokens).toBeDefined();
  });
});
