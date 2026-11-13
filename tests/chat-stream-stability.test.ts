import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { distanceFromBottom, nearChatBottom, restoredPrependTop } from "@/lib/chat-scroll";
import { messageKey } from "@/lib/chat-messages";
import { Markdown, parseBlocks } from "@/components/markdown";

describe("chat scrolling and streaming stability", () => {
  it("follows only near the bottom and restores the exact viewport after older messages are prepended", () => {
    expect(nearChatBottom(2000, 500, 1410)).toBe(true);
    expect(nearChatBottom(2000, 500, 900)).toBe(false);
    expect(distanceFromBottom(2000, 500, 1410)).toBe(90);
    expect(restoredPrependTop(250, 2000, 2450)).toBe(700);
    expect(restoredPrependTop(0, 0, 0)).toBe(0);
  });

  it("keeps user and assistant keys distinct even when they share one turn ID", () => {
    expect(messageKey({ role: "user", content: "question", metadata: { turn_id: "same" } }, 1)).toBe("u:t:same");
    expect(messageKey({ role: "assistant", content: "answer", metadata: { turn_id: "same" } }, 2)).toBe("t:same");
    expect(messageKey({ role: "assistant", content: "history", id: "saved-id" }, 50)).toBe("id:saved-id");
  });

  it("preserves unfinished fenced code, lists, quotes, tables and LaTeX while chunks arrive", () => {
    const partial = "# Heading\n\n- first\n- second\n\n> a note\n\n```ts\nconst result = 1 +";
    const html = renderToStaticMarkup(createElement(Markdown, { text: partial, streaming: true }));
    expect(html).toContain("Heading");
    expect(html).toContain("first");
    expect(html).toContain("a note");
    expect(html).toContain("const result = 1 +");
    expect(html).not.toContain("code-token-");
    const finished = `${partial} 2;\n\`\`\`\n\n| Item | Value |\n| --- | --- |\n| X | 2 |\n\n$$\nx^2 + y^2\n$$`;
    expect(parseBlocks(finished).map((block) => block.type)).toEqual(["h", "ul", "quote", "code", "table", "math"]);
    expect(renderToStaticMarkup(createElement(Markdown, { text: finished }))).toContain("x^2 + y^2");
  });

  it("does not auto-fetch external images embedded in AI Markdown", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "![diagram](https://example.com/diagram.png)" }));
    expect(html).toContain("Load image: diagram");
    expect(html).not.toContain("src=\"https://example.com/diagram.png\"");
  });
});
