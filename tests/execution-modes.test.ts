import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { detectBuildIntent } from "@/lib/ai/build-intent";
import { mayExecuteAgent, requestChatMode, shouldCreateCodeWorkspace } from "@/lib/ai/execution-policy";
import { effectiveMode, selectCapability, detectIntent } from "@/lib/ai/intent";
import { Markdown, parseBlocks } from "@/components/markdown";
import { looksLikeRawMarkup, parseFenceInfo } from "@/lib/code-blocks";
import { readFileSync } from "node:fs";

describe("strict Chat / Coding / Agent separation", () => {
  it("keeps general chat passive and distinguishes Code workspace requests from questions", () => {
    const intent = detectBuildIntent("Build me a responsive website", { projectFileCount: 0 });
    expect(intent.build).toBe(true);
    expect(mayExecuteAgent("general", intent)).toBe(false);
    expect(mayExecuteAgent("code", intent)).toBe(true);
    expect(mayExecuteAgent("agent", intent)).toBe(true);
    expect(shouldCreateCodeWorkspace("Create a Python function that sorts a list")).toBe(true);
    expect(shouldCreateCodeWorkspace("Write code for this task")).toBe(true);
    expect(shouldCreateCodeWorkspace("Create a recipe for lentil soup")).toBe(false);
    expect(shouldCreateCodeWorkspace("Explain how Python list sorting works")).toBe(false);
    expect(shouldCreateCodeWorkspace("Can you explain how to create a React component?")).toBe(false);
    expect(shouldCreateCodeWorkspace("What does this TypeScript function do?", [{ name: "main.ts", content: "const x = 1" }])).toBe(false);
    expect(selectCapability(detectIntent("Inspect the repo and run tests"), "general")).toBe("chat");
    expect(effectiveMode(detectIntent("Build a website"), "code")).toBe("code");
  });
  it("does not inherit execution authority from a stored Agent conversation", () => {
    expect(requestChatMode(undefined)).toBe("general");
    expect(requestChatMode("general")).toBe("general");
    expect(requestChatMode("agent")).toBe("agent");
    expect(requestChatMode("agent", true)).toBe("general");
  });
  it("the conversation gateway cannot write project files or fake tool execution", () => {
    const source = readFileSync("src/app/api/ai/route.ts", "utf8");
    expect(source).toContain("AGENT_RUNTIME_REQUIRED");
    expect(source).not.toContain("applyProjectFiles(");
    expect(source).not.toContain("ensureProject(");
    expect(source).not.toContain("toolsExecuted: mode === \"agent\" ? 1");
    const client = readFileSync("src/components/chat-client.tsx", "utf8");
    expect(client).toContain("mayExecuteAgent(mode, buildIntent)");
    expect(client).not.toContain("artifacts: artifacts.length ? artifacts : undefined");
  });
});

describe("coding assistance rendering", () => {
  it("preserves multiple filenames, indentation and language indicators", () => {
    const blocks = parseBlocks("**index.html**\n```html\n<div>\n  <p>Hello</p>\n</div>\n```\n```css:src/styles.css\np {\n  color: green;\n}\n```");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "code", lang: "html", filename: "index.html", code: "<div>\n  <p>Hello</p>\n</div>" });
    expect(blocks[1]).toMatchObject({ lang: "css", filename: "src/styles.css", code: "p {\n  color: green;\n}" });
    expect(parseFenceInfo("tsx src/App.tsx").filename).toBe("src/App.tsx");
  });
  it("detects unfenced HTML fragments after a short sentence and styles/scripts", () => {
    const reply = "Here is the page you asked for.\n\n<style>body{color:green}</style><article><h1>Hello</h1></article>";
    expect(looksLikeRawMarkup(reply)).toBe(true);
    const rendered = renderToStaticMarkup(createElement(Markdown, { text: reply }));
    expect(rendered).toContain("Copy code");
    expect(rendered).toContain("Download");
    expect(rendered).toContain("&lt;style");
    expect(rendered).toContain("&lt;/style");
    expect(rendered).not.toContain("<style>body");
    expect(looksLikeRawMarkup("There are < 3 items.")).toBe(false);
  });

  it("renders raw HTML as escaped highlighted code with Copy and Download, never trusted markup", () => {
    const raw = '<div class="feature-card"><svg viewBox="0 0 24 24"></svg><li>Card</li></div>';
    expect(looksLikeRawMarkup(raw)).toBe(true);
    const html = renderToStaticMarkup(createElement(Markdown, { text: raw }));
    expect(html).toContain("&lt;div");
    expect(html).toContain("Copy code");
    expect(html).toContain("Download");
    expect(html).toContain("index.html");
    expect(html).not.toContain('<div class="feature-card">');
    expect(html).not.toContain("Make public");
  });
});
