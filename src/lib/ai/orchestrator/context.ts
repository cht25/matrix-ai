// Context selection for collaborating models.
//
// Every model works from the same conversation and project, but none of them
// is sent the whole history or every file. Each request gets: the instructions,
// the user's latest message in full, the most recent turns that fit, a compact
// digest of older turns, and only the files relevant to its task.

import type { AIMessage } from "@/lib/ai/groq";

/** Conservative token estimate (≈4 characters per token for English/code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
export function estimateMessages(messages: readonly AIMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}

function clip(text: string, maxTokens: number): string {
  const max = Math.max(0, maxTokens) * 4;
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 40);
  return `${text.slice(0, head)}\n…[${text.length - head - tail} characters omitted]…\n${tail ? text.slice(-tail) : ""}`;
}

/** One line per older turn: who said it and how it began. No model call. */
export function digestTurns(turns: readonly AIMessage[], maxTokens: number): string {
  const lines: string[] = [];
  let budget = maxTokens * 4;
  for (const turn of turns) {
    const line = `- ${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.content.replace(/\s+/g, " ").trim().slice(0, 220)}`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length + 1;
  }
  const dropped = turns.length - lines.length;
  return lines.join("\n") + (dropped > 0 ? `\n- (${dropped} earlier message${dropped === 1 ? "" : "s"} not shown)` : "");
}

export type SelectedContext = { messages: AIMessage[]; tokens: number; omittedTurns: number; digested: number };

/**
 * Fit a conversation into `budgetTokens`.
 * Kept in priority order: system instructions → latest user message → newest
 * turns → digest of the rest.
 */
export function selectConversationContext(messages: readonly AIMessage[], budgetTokens: number): SelectedContext {
  const system = messages.filter((message) => message.role === "system");
  const turns = messages.filter((message) => message.role !== "system");
  const lastUserIndex = turns.map((turn) => turn.role).lastIndexOf("user");
  const latest = lastUserIndex >= 0 ? turns[lastUserIndex] : null;
  const earlier = lastUserIndex >= 0 ? turns.slice(0, lastUserIndex) : turns;

  const budget = Math.max(400, budgetTokens);
  const systemBudget = Math.floor(budget * 0.4);
  const perSystem = Math.max(120, Math.floor(systemBudget / Math.max(1, system.length)));
  const keptSystem: AIMessage[] = system.map((message) => ({ ...message, content: clip(message.content, perSystem) }));
  const keptLatest: AIMessage[] = latest ? [{ ...latest, content: clip(latest.content, Math.floor(budget * 0.4)) }] : [];
  let remaining = budget - estimateMessages(keptSystem) - estimateMessages(keptLatest);

  const recent: AIMessage[] = [];
  let index = earlier.length - 1;
  for (; index >= 0; index -= 1) {
    const cost = estimateTokens(earlier[index].content) + 4;
    if (cost > remaining - 120) break; // keep room for the digest line
    recent.unshift(earlier[index]);
    remaining -= cost;
  }
  const older = earlier.slice(0, index + 1);
  const digest = older.length && remaining > 60 ? digestTurns(older.slice(-12), Math.min(remaining - 20, 400)) : "";
  const digestMessage: AIMessage[] = digest ? [{ role: "system", content: `Earlier in this conversation (condensed):\n${digest}` }] : [];
  const selected = [...keptSystem, ...digestMessage, ...recent, ...keptLatest];
  return { messages: selected, tokens: estimateMessages(selected), omittedTurns: older.length, digested: digest ? Math.min(older.length, 12) : 0 };
}

export type ContextFile = { path: string; content: string };

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

/**
 * Pick the files that matter for a task: files named in the request first,
 * then by term overlap with the request, within a token budget. Returns the
 * paths left out so the model is told they exist rather than guessing.
 */
export function selectRelevantFiles(files: readonly ContextFile[], request: string, budgetTokens: number): { files: ContextFile[]; omitted: string[] } {
  const wanted = words(request);
  const lower = request.toLowerCase();
  const scored = files.map((file, order) => {
    const name = file.path.split("/").pop()!.toLowerCase();
    let score = 0;
    if (lower.includes(file.path.toLowerCase()) || lower.includes(name)) score += 100;
    if (/^(index\.html|package\.json|src\/(main|app|index)\.[jt]sx?)$/i.test(file.path)) score += 8; // entry points anchor every task
    const fileWords = words(`${file.path} ${file.content.slice(0, 4000)}`);
    for (const word of wanted) if (fileWords.has(word)) score += 1;
    return { file, score, order };
  }).sort((a, b) => b.score - a.score || a.order - b.order);
  const picked: ContextFile[] = [];
  const omitted: string[] = [];
  let remaining = budgetTokens;
  for (const { file } of scored) {
    const cost = estimateTokens(file.content) + estimateTokens(file.path) + 8;
    if (cost <= remaining) { picked.push(file); remaining -= cost; } else omitted.push(file.path);
  }
  return { files: picked, omitted };
}
