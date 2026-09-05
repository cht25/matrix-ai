export type ChatMode =
  | "general"
  | "study"
  | "code"
  | "health"
  | "research"
  | "creative"
  | "agent"
  | "image"
  | "orchestrator";

export type ModelLane = "auto" | "fast" | "balanced" | "reasoning" | "coding" | "vision" | "image";
export type ResponseStrategy = "fast" | "balanced" | "quality" | "efficient";
export type StudyLevel = "beginner" | "school" | "college" | "university" | "professional";
export type ExplainStyle = "simple" | "detailed" | "exam" | "intuitive" | "technical";

export const MATRIX_MODES: Array<{ id: ChatMode; label: string; placeholder: string; hint: string }> = [
  { id: "general", label: "General", placeholder: "Ask Matrix anything...", hint: "Everyday assistant" },
  { id: "study", label: "Study", placeholder: "What would you like to learn?", hint: "Tutor, quizzes, plans" },
  { id: "code", label: "Code", placeholder: "Describe the coding problem...", hint: "Debug, refactor, explain" },
  { id: "health", label: "Health", placeholder: "Describe your health question...", hint: "General information only" },
  { id: "research", label: "Research", placeholder: "What should we investigate?", hint: "Plan, evidence, synthesis" },
  { id: "creative", label: "Creative", placeholder: "Describe what you want to create...", hint: "Writing and ideas" },
  { id: "agent", label: "Agent", placeholder: "What task should Matrix execute?", hint: "Build and preview" },
  { id: "image", label: "Image", placeholder: "Describe the image you want to create...", hint: "Together AI" },
  { id: "orchestrator", label: "Orchestrator", placeholder: "Give Matrix a multi-part goal...", hint: "One prompt, many intelligences" },
];

export const MODEL_LANES: Array<{ id: ModelLane; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "fast", label: "Fast" },
  { id: "balanced", label: "Balanced" },
  { id: "reasoning", label: "Reasoning" },
  { id: "coding", label: "Coding" },
  { id: "vision", label: "Vision" },
  { id: "image", label: "Image" },
];

export function isChatMode(value: unknown): value is ChatMode {
  return MATRIX_MODES.some((m) => m.id === value);
}

export function isModelLane(value: unknown): value is ModelLane {
  return MODEL_LANES.some((m) => m.id === value);
}

export function isStrategy(value: unknown): value is ResponseStrategy {
  return value === "fast" || value === "balanced" || value === "quality" || value === "efficient";
}

export function modeMeta(mode: ChatMode) {
  return MATRIX_MODES.find((m) => m.id === mode) ?? MATRIX_MODES[0];
}

/** Detect a *suggested* mode. Never auto-switch unless the caller opts in. */
export function suggestMode(input: string, current: ChatMode): ChatMode | null {
  const t = input.toLowerCase();
  if (current === "image" || current === "agent" || current === "orchestrator") return null;
  if (/\b(diagnos|symptom|medication|blood pressure|medical report)\b/.test(t) && current !== "health") return "health";
  if (/\b(quiz|flashcard|study plan|exam prep|explain like)\b/.test(t) && current !== "study") return "study";
  if (/\b(react bug|typescript|refactor|unit test|stack trace)\b/.test(t) && current !== "code") return "code";
  if (/\b(generate|create)\b.{0,40}\b(image|illustration|logo|picture)\b/.test(t)) return "image";
  if (/\b(cite|literature|systematic review|sources?)\b/.test(t) && current !== "research") return "research";
  return null;
}

export function studySystemPrompt(level: StudyLevel, style: ExplainStyle): string {
  return `You are MATRIX Study, a dedicated tutor. You are not a generic chatbot.
Adapt to level: ${level}. Explanation style: ${style}.
Prioritize teaching: concept breakdown, worked examples, checks for understanding, short quizzes, flashcards, and study plans when asked.
When the user attached notes, answer from that material first and label anything that is general knowledge as [General knowledge].
Never invent citations or exam board rules.`;
}

export function healthSystemPrompt(): string {
  return `You are MATRIX Health, a health-information assistant.
You are NOT a licensed clinician and must never claim to be a doctor or give a definitive diagnosis.
You may explain terminology, discuss common possibilities in general terms, summarize user-supplied reports, and help prepare questions for a clinician.
For urgent or dangerous symptoms (chest pain, difficulty breathing, stroke signs, suicidal thoughts, severe bleeding), clearly recommend emergency / professional care first.
Always include: "I can provide general health information, but I can't replace a qualified healthcare professional."`;
}

export function researchSystemPrompt(): string {
  return `You are MATRIX Research. Structure answers as:
1) Research plan 2) What is reasonably established 3) Inferences 4) Uncertainties 5) Suggested sources to verify.
Never claim you retrieved a live web page unless a tool result is actually present. Label [Verified information], [Inference], and [Uncertainty] explicitly. Do not invent URLs or paper titles.`;
}

export function codeSystemPrompt(): string {
  return `You are MATRIX Code, a software engineering assistant.
Workflow: analyse → locate the issue → propose a fix → explain tests.
Give complete, runnable snippets with filenames. Do not claim you executed tests unless a sandbox result is included.
Never print secrets, .env values, or private keys. Prefer root-cause fixes over patches that hide errors.`;
}

export function creativeSystemPrompt(): string {
  return `You are MATRIX Creative. Help with writing, brainstorming, narrative, copy, and design language. Offer options, then a recommended direction. Keep output usable, not filler.`;
}

export function orchestratorSystemPrompt(): string {
  return `You are MATRIX Orchestrator. The user gave a multi-part goal. Produce a unified workspace result that clearly sections Study / Code / Research / Visuals as relevant. Do not claim tools ran unless results are provided.`;
}

export function parseStudyArtifacts(text: string): { flashcards: Array<{ q: string; a: string }>; quiz: Array<{ q: string; options?: string[]; answer?: string }> } {
  const flashcards: Array<{ q: string; a: string }> = [];
  const quiz: Array<{ q: string; options?: string[]; answer?: string }> = [];
  const card = /(?:Q|Front)\s*[:.-]\s*(.+)\n(?:A|Back)\s*[:.-]\s*(.+)/gi;
  let m: RegExpExecArray | null;
  while ((m = card.exec(text)) && flashcards.length < 20) flashcards.push({ q: m[1].trim(), a: m[2].trim() });
  return { flashcards, quiz };
}
