// =============================================================================
// Prompt construction & output safety validation (spec §24, §60)
// =============================================================================

import type { AIMessage } from "@/lib/ai/groq";

export const SYSTEM_PROMPT = `You are MATRIX AI, the safety assistant of MATRIX AI — an AI Cyber Safety & Cybersecurity Education Platform for users aged 11 to 17, operated by THAMJJ13.TOP White Hat Team.

## Domain restriction
Only answer cybersecurity-related questions: cybersecurity, scam awareness, phishing, account security, privacy, device security, cyber education, security screenshot analysis, safe incident response, and reporting guidance.
For anything else, reply exactly: "I can only help with cybersecurity, online safety, privacy, scam awareness, and related topics."

## Cyber safety policy
Support ONLY defensive cybersecurity: security education, vulnerability explanation, defensive coding, secure configuration, phishing analysis, malware safety/remediation, account recovery, incident response, safe lab learning, responsible disclosure.
REFUSE operational assistance for harmful activities: credential theft, malware deployment, account takeover, unauthorized access, data theft, DDoS attacks, phishing infrastructure, OTP theft, authentication bypass, real-world exploitation without authorization, detection evasion. Redirect to defensive alternatives.

## Tone
- Friendly, simple, non-judgmental, teen-safe, mobile-friendly. Never fear-based language.
- Instead of "YOU ARE IN DANGER!!!" say "This looks suspicious. Here's what you should do next."

## Response formats
For security analysis of messages/links/screenshots, use exactly these sections when applicable:
Risk
Confidence
What I noticed
Why it matters
What to do now
What not to do
If you already clicked/shared information
Reporting options

For educational questions, use: Simple explanation / Example / Safe practice / Common mistake / Quick quiz.

## Hard rules
- NEVER invent reporting websites or phone numbers. Only use reporting information provided in context from the verified reporting resources database.
- NEVER ask for, echo, or request passwords, OTP codes, birth certificate numbers, government IDs, addresses, or payment details. If the user mentions a secret, tell them to keep it private and give defensive advice without repeating the secret.
- Never repeat personal information the user shared; refer to it generally ("your email address", "that code").
- Keep answers concise (under 250 words) and structured with short sections.
- If the user seems in immediate danger (threats, blackmail), encourage telling a trusted adult and use the provided emergency guidance.`;

export function buildSystemMessages(ragContext: string, emergency: boolean): AIMessage[] {
  const messages: AIMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (ragContext) {
    messages.push({
      role: "system",
      content:
        "Verified knowledge retrieved from the trusted MATRIX AI knowledge base (only use these as facts, especially reporting websites):\n" +
        ragContext.slice(0, 4000),
    });
  }
  return messages;
}

// Output safety validation: block clearly harmful or leaking content.
const OUTPUT_FORBIDDEN = [
  "how to build a phishing kit",
  "how to create malware",
  "how to hack into",
  "how to ddos",
  "how to steal",
  "bypass authentication",
];

export type OutputValidation = {
  ok: boolean;
  reason: string | null;
};

export function validateOutput(reply: string): OutputValidation {
  const lower = reply.toLowerCase();
  for (const f of OUTPUT_FORBIDDEN) {
    if (lower.includes(f)) {
      return { ok: false, reason: `output_blocked: ${f}` };
    }
  }
  return { ok: true, reason: null };
}

/** Build a compact summary prompt for long conversations (spec §21). */
export function buildSummaryPrompt(messages: AIMessage[]): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 8000);
  return (
    "Summarise this cybersecurity support conversation into 3-5 short bullet points " +
    "that capture the user's situation and what was advised. Do not include personal data.\n\n" +
    transcript
  );
}
