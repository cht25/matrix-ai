/** Reveal only content received from the SSE reader, never imagined tokens. */
export type RevealMode = "adaptive" | "word" | "natural" | "reduced";
export function revealReceived(received: string, visible: string, mode: RevealMode): string {
  if (mode === "reduced" || !received.startsWith(visible)) return received;
  const pending = received.slice(visible.length);
  if (!pending) return visible;
  if (mode === "natural") return received;
  if (mode === "word") {
    const match = pending.match(/^\S+\s*/u);
    return visible + (match?.[0] ?? pending.slice(0, 1));
  }
  // Adaptive character-level: at high upstream rates catch up rather than
  // leaving a long, artificial post-completion typing animation.
  const count = pending.length > 600 ? pending.length : pending.length > 100 ? 24 : pending.length > 40 ? 8 : 2;
  return visible + pending.slice(0, count);
}
