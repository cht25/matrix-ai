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

/**
 * Extract ONLY the visible `content` field of a streaming delta object,
 * dropping any separate `reasoning` / `reasoning_content` field.
 *
 * CRITICAL: this must never trim or rewrite the text. Streaming deltas are
 * small fragments whose leading/trailing spaces and newlines are the ONLY
 * separation between tokens — scrubbing them per-delta used to glue every
 * word together into unreadable output. Delimited reasoning blocks that span
 * many deltas are removed by `createReasoningStreamFilter` instead.
 */
export function assistantDeltaContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const raw = message as Record<string, unknown>;
  if (typeof raw.content === "string") return raw.content;
  if (Array.isArray(raw.content)) {
    return raw.content
      .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "")
      .join("");
  }
  return "";
}

// Delimited reasoning blocks, as (opening, closing) literal tags. Matched
// case-insensitively. <think> is Qwen3's tag and is by far the most common
// one seen inline inside `content` on OpenAI-compatible endpoints.
const REASONING_DELIMITERS: Array<[open: string, close: string]> = [
  ["<think>", "</think>"],
  ["<thinking>", "</thinking>"],
  ["<thought>", "</thought>"],
  ["<analysis>", "</analysis>"],
  ["<reasoning>", "</reasoning>"],
  ["[thinking]", "[/thinking]"],
  ["[reasoning]", "[/reasoning]"],
  ["<<<thinking>>>", "<<<end_thinking>>>"],
  ["```thinking", "```"],
  ["```reasoning", "```"],
];

const OPEN_TAGS = REASONING_DELIMITERS.map(([open]) => open);
const CLOSE_TAGS = REASONING_DELIMITERS.map(([, close]) => close);

/** Case-insensitive indexOf that stays index-safe for exotic casings. */
function indexOfCI(haystack: string, needle: string): number {
  const lower = haystack.toLowerCase();
  if (lower.length === haystack.length) return lower.indexOf(needle);
  return haystack.indexOf(needle);
}

function findFirstTag(haystack: string, tags: string[]): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const tag of tags) {
    const index = indexOfCI(haystack, tag);
    if (index !== -1 && (best === null || index < best.index)) best = { index, length: tag.length };
  }
  return best;
}

/**
 * Length of the longest suffix of `text` that is a strict prefix of one of the
 * tags. That suffix must be held back because the tag may be completed by the
 * next streaming delta (e.g. a delta ending in "<th" could become "<think>").
 * Everything before it is safe to release untouched — spaces included.
 */
function splitTagSuffix(text: string, tags: string[]): number {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return 0;
  const maxLook = Math.max(...tags.map((tag) => tag.length)) - 1;
  const start = Math.max(0, text.length - maxLook);
  for (let i = start; i < text.length; i += 1) {
    if (tags.some((tag) => tag.startsWith(lower.slice(i)))) return text.length - i;
  }
  return 0;
}

export type ReasoningStreamFilter = {
  /** Feed one provider delta; returns the visible text safe to emit now. */
  push(delta: string): string;
  /** Release any text still held back at the end of the stream. */
  flush(): string;
};

/**
 * Stateful reasoning scrubber for STREAMING responses.
 *
 * Unlike `stripReasoningContent` (which works on one complete message), this
 * filter carries state across deltas so it can remove `<think>...</think>`
 * style blocks whose opening and closing tags arrive in different chunks —
 * while preserving every legitimate space and newline exactly as sent.
 */
export function createReasoningStreamFilter(): ReasoningStreamFilter {
  let insideReasoning = false;
  let pending = "";

  const push = (delta: string): string => {
    pending += delta;
    let visible = "";
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (insideReasoning) {
        const close = findFirstTag(pending, CLOSE_TAGS);
        if (close) {
          pending = pending.slice(close.index + close.length);
          insideReasoning = false;
          progressed = true; // re-scan the remainder as visible text
        } else {
          // Inside chain-of-thought: drop everything except a tail that might
          // be a closing tag split across the next delta boundary.
          const hold = splitTagSuffix(pending, CLOSE_TAGS);
          pending = hold ? pending.slice(pending.length - hold) : "";
        }
      } else {
        const open = findFirstTag(pending, OPEN_TAGS);
        if (open) {
          visible += pending.slice(0, open.index);
          pending = pending.slice(open.index + open.length);
          insideReasoning = true;
          progressed = true;
        } else {
          // Visible text: release everything except a possible partial opener.
          const hold = splitTagSuffix(pending, OPEN_TAGS);
          if (hold) {
            visible += pending.slice(0, pending.length - hold);
            pending = pending.slice(pending.length - hold);
          } else {
            visible += pending;
            pending = "";
          }
        }
      }
    }
    return visible;
  };

  const flush = (): string => {
    if (insideReasoning) {
      // The stream ended inside an unterminated thinking block. The raw chain
      // of thought must never reach the user, so drop it.
      pending = "";
      return "";
    }
    const out = pending;
    pending = "";
    return out;
  };

  return { push, flush };
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
    [/<think>[\s\S]*?<\/think>/gi, ""],
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
