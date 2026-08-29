import { describe, expect, it } from "vitest";
import {
  assistantContentOnly,
  assistantDeltaContent,
  createReasoningStreamFilter,
  hasSeparateReasoning,
  stripReasoningContent,
} from "../src/lib/ai/reasoning";

describe("stripReasoningContent", () => {
  it("removes <thinking> blocks from content", () => {
    expect(stripReasoningContent("ok")).toBe("ok");
    const stripped = stripReasoningContent("<thinking>let me plan this carefully</thinking>Here is the answer.");
    expect(stripped).toBe("Here is the answer.");
  });

  it("removes Qwen3 <think> blocks from content", () => {
    expect(stripReasoningContent("<think>secret planning</think>The answer is 4.")).toBe("The answer is 4.");
    const bn = stripReasoningContent("<THINK>Internal reasoning</THINK>উত্তর এখানে।");
    expect(bn).toBe("উত্তর এখানে।");
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

describe("assistantDeltaContent (streaming deltas)", () => {
  it("preserves leading and trailing spaces exactly — never trims", () => {
    // Regression: per-delta trimming used to concatenate every token into
    // unreadable text like "Here'salean,repeatableframework".
    const deltas = ["Here's a ", "lean, ", "repeatable ", "framework ", "you can use."];
    const joined = deltas.map((d) => assistantDeltaContent({ content: d })).join("");
    expect(joined).toBe("Here's a lean, repeatable framework you can use.");
  });

  it("keeps newlines and drops separate reasoning fields per delta", () => {
    expect(assistantDeltaContent({ content: "line one\n", reasoning_content: "private " })).toBe("line one\n");
    expect(assistantDeltaContent({ content: null, reasoning: "private" })).toBe("");
    expect(assistantDeltaContent({ content: undefined })).toBe("");
    expect(assistantDeltaContent(null)).toBe("");
  });
});

describe("createReasoningStreamFilter", () => {
  it("removes a <think> block split across many deltas, keeping every space", () => {
    const filter = createReasoningStreamFilter();
    const deltas = [
      "<th", // opening tag split across the delta boundary
      "ink>Here's a think",
      "ing process: 1. analyse 2. plan</th",
      "ink>Here's a lean, ",
      "repeatable framework ",
      "you can use right now.",
    ];
    const visible = deltas.map((d) => filter.push(d)).join("") + filter.flush();
    expect(visible).toBe("Here's a lean, repeatable framework you can use right now.");
  });

  it("passes plain text through byte-for-byte, including newlines", () => {
    const filter = createReasoningStreamFilter();
    const text = "Hello! Here is help.\n\n- point one\n- point two\n\nDone. ";
    const visible = filter.push(text) + filter.flush();
    expect(visible).toBe(text);
  });

  it("handles text before, between and after reasoning blocks", () => {
    const filter = createReasoningStreamFilter();
    const deltas = ["First. ", "<think>hidden</think>", "Second. ", "<analysis>", "more", " hidden</analysis>", "Third."];
    const visible = deltas.map((d) => filter.push(d)).join("") + filter.flush();
    expect(visible).toBe("First. Second. Third.");
  });

  it("drops an unterminated thinking block at the end of the stream", () => {
    const filter = createReasoningStreamFilter();
    filter.push("Visible answer. <think>truncated chain of");
    expect(filter.flush()).toBe("");
  });

  it("does not hold back normal punctuation that precedes a tag boundary", () => {
    const filter = createReasoningStreamFilter();
    const visible = filter.push("Answer: 42. ") + filter.flush();
    expect(visible).toBe("Answer: 42. ");
  });

  it("matches tags case-insensitively across delta boundaries", () => {
    const filter = createReasoningStreamFilter();
    const visible = filter.push("<TH") + filter.push("INK>hidden</THINK>") + filter.push("Visible.") + filter.flush();
    expect(visible).toBe("Visible.");
  });
});
