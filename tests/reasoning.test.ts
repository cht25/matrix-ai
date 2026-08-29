import { describe, expect, it } from "vitest";
import {
  assistantContentOnly,
  deltaContentOnly,
  hasSeparateReasoning,
  ReasoningStreamScrubber,
  stripReasoningContent,
} from "../src/lib/ai/reasoning";

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

describe("stripReasoningContent — Qwen <think> markers", () => {
  it("removes <think> blocks from content", () => {
    expect(stripReasoningContent("<think>private reasoning here</think>Public answer.")).toBe("Public answer.");
    expect(stripReasoningContent("Before.<think>x</think>After.")).toBe("Before.After.");
  });

  it("drops an unterminated leading <think> block (truncated generation)", () => {
    expect(stripReasoningContent("<think>the model never closed this")).toBe("");
    expect(stripReasoningContent("<thinking>never closed")).toBe("");
  });

  it("does not touch a tag mentioned mid-answer", () => {
    const out = stripReasoningContent("Qwen emits <think> tags; your answer is fine.");
    expect(out).toContain("your answer is fine.");
  });
});

describe("ReasoningStreamScrubber", () => {
  it("preserves the leading spaces that tokenizers attach to the next delta", () => {
    const scrubber = new ReasoningStreamScrubber();
    const deltas = ["Here's", " a", " lean", ",", " repeatable", " framework", " you", " can", " use", "."];
    let out = "";
    for (const d of deltas) out += scrubber.push(d);
    out += scrubber.flush();
    expect(out).toBe("Here's a lean, repeatable framework you can use.");
  });

  it("drops a <think> block that is split across deltas (regression: screenshot bug)", () => {
    const scrubber = new ReasoningStreamScrubber();
    const deltas = [
      "<th", "ink>Here's a thin", "king", " process", ".</th", "ink>",
      "\n\nHere's", " a", " lean", " framework", " you", " can", " use", ".",
    ];
    let out = "";
    for (const d of deltas) out += scrubber.push(d);
    out += scrubber.flush();
    expect(out).toBe("Here's a lean framework you can use.");
    expect(out).not.toContain("think");
    expect(out).not.toContain("process");
  });

  it("drops every known reasoning marker pair across chunk boundaries", () => {
    for (const [open, close] of [
      ["<thinking>", "</thinking>"],
      ["<reasoning>", "</reasoning>"],
      ["<analysis>", "</analysis>"],
      ["[thinking]", "[/thinking]"],
    ] as const) {
      const scrubber = new ReasoningStreamScrubber();
      let out = "";
      for (const d of [open.slice(0, 3), open.slice(3) + "hidden ", close.slice(0, 2), close.slice(2) + " visible"]) {
        out += scrubber.push(d);
      }
      out += scrubber.flush();
      expect(out).toBe("visible");
    }
  });

  it("releases text held back as a possible partial marker on flush", () => {
    const scrubber = new ReasoningStreamScrubber();
    let out = scrubber.push("Compare a < b and c > d. Ends with <thi");
    expect(out).toBe("Compare a < b and c > d. Ends with ");
    out += scrubber.flush();
    expect(out).toBe("Compare a < b and c > d. Ends with <thi");
  });

  it("drops an unterminated reasoning block on flush instead of leaking it", () => {
    const scrubber = new ReasoningStreamScrubber();
    scrubber.push("<think>secret reasoning that never ends");
    expect(scrubber.flush()).toBe("");
  });

  it("trims leading answer whitespace exactly once and keeps inner whitespace", () => {
    const scrubber = new ReasoningStreamScrubber();
    let out = scrubber.push("<think>x</think>\n\n  Here is line one.  ");
    out += scrubber.push("\n\nLine two. ");
    out += scrubber.flush();
    expect(out).toBe("Here is line one.  \n\nLine two. ");
  });

  it("emits ordinary prose containing '<' without corrupting it", () => {
    const scrubber = new ReasoningStreamScrubber();
    let out = "";
    for (const d of ["for (let i = 0; i ", "< n; i++) ", "sum += i;"]) out += scrubber.push(d);
    out += scrubber.flush();
    expect(out).toBe("for (let i = 0; i < n; i++) sum += i;");
  });
});

describe("deltaContentOnly", () => {
  it("returns raw delta content verbatim, including leading spaces", () => {
    expect(deltaContentOnly({ content: " framework" })).toBe(" framework");
    expect(deltaContentOnly({ content: null, reasoning_content: "hidden" })).toBe("");
    expect(deltaContentOnly({ content: [{ type: "text", text: "a" }, { type: "text", text: " b" }] })).toBe("a b");
    expect(deltaContentOnly(undefined)).toBe("");
  });
});
