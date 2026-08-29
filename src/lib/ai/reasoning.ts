// Reasoning / chain-of-thought scrubbing.
//
// Some reasoning models (DeepSeek, Qwen3, GPT-OSS, NVIDIA Nemotron, and a few
// OpenAI-compatible mirrors of those models) return their "thinking" either in
// a separate `reasoning_content` / `reasoning` field or — for endpoints that do
// not separate it — inline inside `content`. MATRIX is an education assistant,
// so the raw chain-of-thought is never meant to be shown to the user. We scrub
// it server-side (never as a fallback that depends on the client) and let the
// client render a calm animated "thinking" indicator instead.
//
// Complete messages are scrubbed with stripReasoningContent(). STREAMED deltas
// must instead be fed through ReasoningStreamScrubber: markers such as
// <think> arrive split across deltas, and trimming each delta in isolation
// deletes the leading space tokenizers attach to the next word.

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
 * markers used by common reasoning models (including Qwen3's <think>), plus a
 * leading "Thinking/Reasoning" preamble when it is clearly separated from the
 * actual answer. Kept conservative: ordinary prose is never touched.
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

  // A reasoning block that opened but never closed means the generation was
  // truncated inside the chain-of-thought — everything from the marker on is
  // reasoning, so drop the tail. Only applies when the marker leads the text,
  // which is how reasoning models emit it; prose mentioning a tag mid-answer
  // is untouched.
  out = out.replace(
    /^\s*(?:<<<thinking>>>|<think(?:ing)?>|<(?:reasoning|analysis|Thought)>|\[(?:thinking|reasoning)\])[\s\S]*$/i,
    "",
  );

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

// -----------------------------------------------------------------------------
// Streaming-safe scrubbing.
//
// Per-delta scrubbing cannot work: markers such as <think> arrive split across
// deltas ("<th" + "ink>"), so a regex run on each delta alone never matches —
// and running stripReasoningContent() per delta trims away the leading space
// that tokenizers attach to the next token, gluing words together. Instead the
// providers feed every delta through this stateful scrubber, which buffers
// only the small tail that could still become a marker and emits everything
// else verbatim.
// -----------------------------------------------------------------------------

/** Opening/closing marker pairs recognised inside streamed assistant text. */
const STREAM_MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["<think>", "</think>"],
  ["<thinking>", "</thinking>"],
  ["<Thought>", "</Thought>"],
  ["<reasoning>", "</reasoning>"],
  ["<analysis>", "</analysis>"],
  ["[thinking]", "[/thinking]"],
  ["[reasoning]", "[/reasoning]"],
  ["<<<thinking>>>", "<<<end_thinking>>>"],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STREAM_OPEN_RE = new RegExp(STREAM_MARKER_PAIRS.map(([open]) => escapeRegExp(open)).join("|"), "i");
const STREAM_CLOSE_RE = STREAM_MARKER_PAIRS.map(([, close]) => new RegExp(escapeRegExp(close), "i"));
const STREAM_MARKERS = STREAM_MARKER_PAIRS.flatMap(([open, close]) => [open, close]).map((m) => m.toLowerCase());
const STREAM_MAX_MARKER_LEN = Math.max(...STREAM_MARKERS.map((m) => m.length));

/** Length of the longest suffix of `text` that could still grow into a marker. */
function partialMarkerSuffixLength(text: string): number {
  const lower = text.toLowerCase();
  const max = Math.min(text.length, STREAM_MAX_MARKER_LEN - 1);
  for (let len = max; len > 0; len -= 1) {
    const suffix = lower.slice(lower.length - len);
    if (STREAM_MARKERS.some((marker) => marker.startsWith(suffix))) return len;
  }
  return 0;
}

/**
 * Incremental reasoning scrubber for streamed assistant text. Feed it each
 * provider delta with push() and emit what it returns verbatim; call flush()
 * once the stream ends. Whitespace inside the answer is preserved exactly.
 */
export class ReasoningStreamScrubber {
  private pending = "";
  private closeRe: RegExp | null = null; // non-null => inside a reasoning block
  private started = false; // leading answer whitespace trimmed exactly once

  /** Feed one provider delta; returns the text that is safe to show now. */
  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    let out = "";

    // Consume complete markers (opening markers enter reasoning mode, closing
    // markers leave it; text between them is dropped, never emitted).
    for (;;) {
      const re = this.closeRe ?? STREAM_OPEN_RE;
      const match = re.exec(this.pending);
      if (!match || match.index === undefined) break;
      if (!this.closeRe) out += this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (this.closeRe) {
        this.closeRe = null;
      } else {
        const matched = match[0].toLowerCase();
        const pairIndex = STREAM_MARKER_PAIRS.findIndex(([open]) => open.toLowerCase() === matched);
        this.closeRe = STREAM_CLOSE_RE[pairIndex] ?? null;
      }
    }

    if (this.closeRe) {
      // Inside reasoning: drop everything except a tail that could still grow
      // into the closing marker.
      const hold = partialMarkerSuffixLength(this.pending);
      this.pending = hold ? this.pending.slice(this.pending.length - hold) : "";
    } else {
      // Outside reasoning: emit everything except a tail that could still grow
      // into an opening marker (e.g. the buffer ends in "<thi").
      const hold = partialMarkerSuffixLength(this.pending);
      const safeLength = this.pending.length - hold;
      if (safeLength > 0) {
        out += this.pending.slice(0, safeLength);
        this.pending = this.pending.slice(safeLength);
      }
    }

    if (!this.started && out) {
      const trimmed = out.replace(/^\s+/, "");
      if (trimmed) {
        this.started = true;
        out = trimmed;
      } else {
        out = "";
      }
    }
    return out;
  }

  /** End of stream: release held-back text. Must be called once, after push(). */
  flush(): string {
    const rest = this.pending;
    this.pending = "";
    if (this.closeRe) {
      // The reasoning block never closed: what follows the opening marker is
      // all chain-of-thought, so drop it instead of leaking it.
      this.closeRe = null;
      return "";
    }
    if (!this.started) {
      const trimmed = rest.replace(/^\s+/, "");
      if (!trimmed) return "";
      this.started = true;
      return trimmed;
    }
    return rest;
  }
}

/**
 * Extract the raw `content` text of a streaming delta — WITHOUT any scrubbing
 * or trimming. Streamed deltas must keep their whitespace intact (tokenizers
 * attach the leading space of the next word to the following delta) and are
 * scrubbed with ReasoningStreamScrubber instead, which is marker-split safe.
 */
export function deltaContentOnly(delta: unknown): string {
  if (!delta || typeof delta !== "object") return "";
  const raw = delta as Record<string, unknown>;
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
