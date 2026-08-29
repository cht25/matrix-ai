// Reasoning / chain-of-thought scrubbing.
//
// Some reasoning models (DeepSeek, Qwen3, GPT-OSS, NVIDIA Nemotron, and a few
// OpenAI-compatible mirrors of those models) return their "thinking" either in
// a separate `reasoning_content` / `reasoning` field or — for endpoints that do
// not separate it — inline inside `content`. MATRIX is an education assistant,
// so the raw chain-of-thought is never meant to be shown to the user. We scrub
// it server-side (never as a fallback that depends on the client) and let the
// client render a calm animated "thinking" indicator instead.

/** True when a non-streaming chat message object carries a separate reasoning field. */
export function hasSeparateReasoning(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const raw = message as Record<string, unknown>;
  return typeof raw.reasoning_content === "string" || typeof raw.reasoning === "string";
}

/** Extract only the user-facing assistant text, dropping any separate reasoning field. */
export function assistantContentOnly(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const raw = message as Record<string, unknown>;
  if (typeof raw.content === "string") return stripReasoningContent(raw.content);
  if (Array.isArray(raw.content)) {
    return stripReasoningContent(
      raw.content
        .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "")
        .join(""),
    );
  }
  return "";
}

/**
 * Remove reasoning/thinking blocks from assistant text. Handles the delimited
 * markers used by common reasoning models, plus a leading "Thinking/Reasoning"
 * preamble when it is clearly separated from the actual answer. Kept
 * conservative: ordinary prose is never touched.
 */
export function stripReasoningContent(input: string): string {
  if (!input) return input;
  let out = input;

  // Delimited blocks (safe to remove wherever they appear).
  const delimited: Array<[RegExp, string]> = [
    [/<thinking>[\s\S]*?<\/thinking>/gi, ""],
    [/<Thought>[\s\S]*?<\/Thought>/gi, ""],
    [/<analysis>[\s\S]*?<\/analysis>/gi, ""],
    [/<reasoning>[\s\S]*?<\/reasoning>/gi, ""],
    [/\[thinking\]\s*[\s\S]*?\[\/thinking\]/gi, ""],
    [/\[reasoning\]\s*[\s\S]*?\[\/reasoning\]/gi, ""],
    [/<<<thinking>>>[\s\S]*?<<<end_thinking>>>/gi, ""],
    [/```thinking\s*[\s\S]*?```/gi, ""],
    [/```reasoning\s*[\s\S]*?```/gi, ""],
  ];
  for (const [pattern, replacement] of delimited) out = out.replace(pattern, replacement);

  // Leading reasoning preamble headed by an explicit marker, followed by a
  // clear answer boundary (a heading, MATRIX_FILE protocol, or a blank line
  // then content). Only strips when the marker is on its own line so we never
  // eat ordinary sentences that merely mention "thinking".
  out = out.replace(
    /^\s*(?:#{1,4}\s*|\*\*|\*|>)?\s*(?:thinking|reasoning|analysis)\s*:?\*{0,2}\s*\n+\s*[\s\S]*?\n\n(?=(?:#{1,4}\s|\*\*|<<<MATRIX_FILE|[A-Za-z0-9]))/im,
    "",
  );

  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
