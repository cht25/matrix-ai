import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { closeOpenInline, parseBlocks } from "@/components/markdown";
import { createStreamStore } from "@/lib/stream-store";

describe("stable streaming render", () => {
  it("closes inline markers that the stream has not finished yet", () => {
    expect(closeOpenInline("This is **bol")).toBe("This is **bol**");
    expect(closeOpenInline("Run `npm inst")).toBe("Run `npm inst`");
    expect(closeOpenInline("See [the docs](https://exa")).toBe("See the docs");
    expect(closeOpenInline("See [the do")).toBe("See the do");
    expect(closeOpenInline("Half **")).toBe("Half ");
    expect(closeOpenInline("Trailing *")).toBe("Trailing ");
  });

  it("leaves complete text untouched", () => {
    for (const text of ["Plain text.", "A **bold** word", "Use `code` here", "A [link](https://example.com) done", "2 * 3 = 6"]) {
      expect(closeOpenInline(text)).toBe(text);
    }
  });

  it("marks only an unterminated fence as open", () => {
    const open = parseBlocks("Intro\n\n```ts\nconst a = 1;");
    expect(open.at(-1)).toMatchObject({ type: "code", open: true });
    const closed = parseBlocks("Intro\n\n```ts\nconst a = 1;\n```\n\nDone");
    expect(closed.find((block) => block.type === "code")).not.toHaveProperty("open", true);
  });

  it("keeps earlier blocks identical as text is appended", () => {
    const first = parseBlocks("Para one.\n\n- a\n- b\n\nPara thr");
    const second = parseBlocks("Para one.\n\n- a\n- b\n\nPara three is longer");
    expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(second).toHaveLength(first.length);
  });

  it("notifies stream subscribers only on real changes", () => {
    const store = createStreamStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("a"); store.set("a"); store.set("ab");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toBe("ab");
    unsubscribe();
    store.set("abc");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("streams outside chat-screen state and does not replay the entry animation", () => {
    const source = readFileSync("src/components/chat-client.tsx", "utf8");
    expect(source).not.toMatch(/useState<string \| null>\(null\);\s*\/\/ streamed/);
    expect(source).toContain("<StreamingReply store={streamStore} />");
    expect(source).not.toContain("<Markdown text={streamedText}");
    expect(source).toContain('key !== settledKey && "msg-in"');
  });

  it("voice input is available in Agent mode and never auto-sends", () => {
    const source = readFileSync("src/components/chat-client.tsx", "utf8");
    expect(source).not.toMatch(/mode !== "code" && mode !== "agent" \? <button[^>]*toggleVoiceRecording/);
    expect(source).toContain("<VoiceReviewBar");
    const fn = source.slice(source.indexOf("async function uploadAndTranscribeVoice"), source.indexOf("function finishVoiceCapture"));
    expect(fn).not.toMatch(/\bsend\(/);
    expect(fn).toContain("placeTranscript(");
  });
});
