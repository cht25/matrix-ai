import { describe, expect, it } from "vitest";
import { assistantContentOnly, hasSeparateReasoning, stripReasoningContent } from "../src/lib/ai/reasoning";

describe("stripReasoningContent", () => {
  it("removes <thinking> blocks from content", () => {
    expect(stripReasoningContent("ok")).toBe("ok");
    const stripped = stripReasoningContent("<thinking>let me plan this carefully</thinking>Here is the answer.");
    expect(stripped).toBe("Here is the answer.");
  });

  it("removes OpenRouter <analysis> and <reasoning> blocks", () => {
    expect(stripReasoningContent("<analysis>step one\nstep two</analysis>\nThe result is X.")).toBe("The result is X.");
    expect(stripReasoningContent("<reasoning>hidden</reasoning>Final answer")).toBe("Final answer");
  });

  it("removes [thinking] / [reasoning] / triple-backtick blocks", () => {
    expect(stripReasoningContent("[thinking]draft[/thinking]Answer")).toBe("Answer");
    expect(stripReasoningContent("```thinking\nx\n```\nAnswer")).toBe("Answer");
    expect(stripReasoningContent("```reasoning\nx\n```\nAnswer")).toBe("Answer");
  });

  it("removes a leading Thinking/Reasoning preamble followed by a clear answer", () => {
    const out = stripReasoningContent("Thinking:\n\nLet me work out the steps\n\n## Answer\nThe sky is blue.");
    expect(out).toContain("The sky is blue");
    expect(out).not.toContain("Thinking:");
  });

  it("never strips ordinary prose that merely mentions thinking", () => {
    const out = stripReasoningContent("I have been thinking about this and the answer is simple.");
    expect(out).toContain("I have been thinking about this and the answer is simple.");
  });

  it("leaves plain answers untouched", () => {
    const out = stripReasoningContent("Hello! Here is some help.\n\n- point one\n- point two");
    expect(out).toContain("Hello!");
    expect(out).toContain("point two");
  });
});

describe("assistantContentOnly / hasSeparateReasoning", () => {
  it("returns only content when a reasoning field is present", () => {
    const message = {
      content: "The final answer.",
      reasoning_content: "my private chain of thought",
    };
    expect(hasSeparateReasoning(message)).toBe(true);
    expect(assistantContentOnly(message)).toBe("The final answer.");
  });

  it("handles array content parts", () => {
    const message = { content: [{ type: "text", text: "part one" }, { type: "text", text: " part two" }], reasoning: "x" };
    expect(assistantContentOnly(message)).toBe("part one part two");
  });

  it("strips thinking that was inlined into content", () => {
    const message = { content: "<thinking>private</thinking>visible answer" };
    expect(assistantContentOnly(message)).toBe("visible answer");
  });

  it("returns empty for reasoning-only deltas", () => {
    expect(assistantContentOnly({ content: null, reasoning_content: "still thinking" })).toBe("");
    expect(assistantContentOnly({ content: undefined })).toBe("");
  });
});
