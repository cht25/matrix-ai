// =============================================================================
// MATRIX intent + artifact detection
//
// The UI is context-aware: capabilities exist in the system, but the interface
// only reveals them when they become relevant. This module is the single source
// of truth for "what did the user actually ask for?".
//
//   USER INTENT → CAPABILITY SELECTION → EXECUTION → CONTEXTUAL UI
//
// Rules enforced here (product spec):
//   • The default is always intent = CHAT, artifact = NONE.
//   • An artifact is only "requested" when the user clearly asked for one.
//   • Ambiguous requests ("make a report") never guess a format — they offer a
//     minimal format choice instead.
//   • An explicit user request overrides every automatic behaviour, including
//     an explicit "don't export".
//
// Pure + deterministic: no React, no network, no Firestore — fully unit tested.
// =============================================================================

import type { ChatMode } from "@/lib/ai/modes";

/** What the user wants Matrix to do. */
export type IntentId =
  | "CHAT"
  | "EXPORT"
  | "IMAGE_GENERATION"
  | "AGENT_TASK"
  | "CODE"
  | "RESEARCH"
  | "STUDY"
  | "HEALTH"
  | "FORMAT_CLARIFY";

/** A concrete deliverable the UI may have to produce. */
export type ArtifactType =
  | "NONE"
  | "PDF"
  | "DOCX"
  | "CSV"
  | "XLSX"
  | "JSON"
  | "TXT"
  | "MARKDOWN"
  | "CODE"
  | "IMAGE"
  | "RESEARCH"
  | "AGENT_TASK";

/** Export formats Matrix can really build in the browser. */
export type ExportFormat = "pdf" | "docx" | "markdown" | "txt" | "json" | "csv" | "xlsx";

/** Which gateway capability a request needs. */
export type Capability = "chat" | "image" | "agent" | "orchestrate";

export type IntentResult = {
  /** Dominant task the user asked for. */
  intent: IntentId;
  /** Deliverable the UI owes the user. "NONE" unless clearly requested. */
  artifact: ArtifactType;
  /** True only when the user explicitly asked for an artifact. */
  artifactRequested: boolean;
  /** Every export format named in the message (usually 0 or 1). */
  formats: ExportFormat[];
  /**
   * The user asked for "a report"/"a document" but never said which format.
   * Matrix answers normally and then offers a minimal format choice.
   */
  needsFormatChoice: boolean;
  /** Formats offered when `needsFormatChoice` is true. Kept deliberately small. */
  formatChoices: ExportFormat[];
  /** The user explicitly refused export/automation — respect it. */
  suppressExport: boolean;
  /** Image generation provider, set only for real image requests. */
  provider: "together_ai" | null;
  /** Short, human-readable reasons. Used for debugging + Activity copy. */
  signals: string[];
};

export const DEFAULT_INTENT: IntentResult = {
  intent: "CHAT",
  artifact: "NONE",
  artifactRequested: false,
  formats: [],
  needsFormatChoice: false,
  formatChoices: [],
  suppressExport: false,
  provider: null,
  signals: [],
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const FORMAT_PATTERNS: Array<{ format: ExportFormat; re: RegExp }> = [
  { format: "pdf", re: /\bpdf(?:s|'s)?\b|\bপিডিএফ\b/gi },
  { format: "docx", re: /\bdocx?\b|\bword (?:document|file)\b|\bmicrosoft word\b|\bওয়ার্ড (?:ফাইল|ডকুমেন্ট)\b/gi },
  { format: "csv", re: /\bcsv(?:s)?\b|\bসিএসভি\b/gi },
  { format: "xlsx", re: /\bxlsx?\b|\bexcel\b|\bspreadsheet\b|\bএক্সেল\b/gi },
  { format: "json", re: /\bjson\b|\bজেসন\b/gi },
  { format: "txt", re: /\btxt\b|\bplain[- ]text\b|\btext (?:file|document)\b|\bটেক্সট ফাইল\b/gi },
  { format: "markdown", re: /\bmarkdown\b|\bmd (?:file|document|format)\b|\b\.md\b|\bমার্কডাউন\b/gi },
];

/** Verbs that turn a mention of a format into a request for that format. */
const PRODUCE_VERB =
  /\b(?:export|exported|download|save|convert|turn|turning|transform|make|made|generate|generating|create|creating|produce|output|send|give|giving|return|deliver|write|build|prepare|render|as|into|to|in)\b/i;

/** Nouns that make "<format> <noun>" a deliverable ("a PDF report"). */
const DELIVERABLE_NOUN =
  /\b(?:file|files|document|documents|doc|version|copy|report|sheet|table|data|download|attachment|format)\b/i;

/** "Make a report" with no format — never guess, offer a choice instead. */
const DOCUMENT_NOUN = /\b(?:report|document|write[- ]?up|handout|brief|dossier|manual|guide|ebook|whitepaper|one[- ]pager)\b/i;
const DOCUMENT_VERB = /\b(?:make|create|prepare|generate|write|produce|build|turn|export|save|give|draft)\b/i;

/** Explicit refusal — user intent always wins over automation. */
const SUPPRESS_EXPORT =
  /\b(?:don'?t|do not|dont|no|never|skip|without|avoid|stop)\s+(?:export|download|convert|save it|generate (?:a )?file)|\bno export\b|\bnot (?:as|in) (?:a )?(?:pdf|docx|csv|json|txt)\b/i;

const IMAGE_NOUN =
  /\b(?:image|images|picture|pictures|photo|photos|illustration|illustrations|artwork|logo|logos|poster|posters|banner|banners|icon|icons|thumbnail|wallpaper|avatar|portrait|sketch|graphic|graphics|infographic|ছবি|লোগো|পোস্টার)\b/i;
const IMAGE_VERB =
  /\b(?:generate|generating|create|creating|make|making|draw|drawing|design|designing|render|rendering|produce|imagine|paint|sketch)\b|\b(?:তৈরি|বানান|বানাও|আঁক)\b/i;

const AGENT_VERB =
  /\b(?:analy[sz]e|analysing|analyzing|inspect|auditing|audit|review|fix|repair|resolve|debug|run|execute|test|build|implement|refactor|deploy|scan|verify|validate|find|investigate|migrate|set up|setup|install|package)\b/gi;
const AGENT_TARGET =
  /\b(?:project|projects|repo|repository|codebase|code base|files?|folders?|director(?:y|ies)|workspace|app|application|service|tests?|test suite|build|pipeline|environment|branch|errors?|bugs?|issues?)\b/i;
const AGENT_EXPLICIT =
  /\b(?:agent|autonomous(?:ly)?|multi[- ]step|end[- ]to[- ]end|step by step and|automate|automation|on your own|by yourself|do it (?:for me|all)|complete the task|run the (?:tests|build|suite)|and then (?:fix|run|deploy|test))\b/i;

const CODE_TASK_NOUN =
  /\b(?:function|functions|component|components|class|classes|method|methods|script|scripts|program|programs|api|endpoint|endpoints|hook|hooks|module|modules|snippet|snippets|code|algorithm|algorithms|query|queries|regex|unit tests?|bug|bugs|error|errors|stack trace|pull request|migration|service|handler|route|routes|utility|utils)\b/i;
const CODE_VERB =
  /\b(?:write|code|implement|create|build|develop|debug|fix|refactor|optimi[sz]e|review|complete|convert|scaffold|test)\b/i;
const CODE_LANGUAGE =
  /\b(?:python|javascript|typescript|tsx?|jsx?|react|next\.?js|vue|svelte|node\.?js|express|django|flask|fastapi|spring|rust|golang|\bgo\b|java|kotlin|swift|c\+\+|c#|php|ruby|sql|graphql|html|css|scss|tailwind|bash|shell|powershell)\b/i;
const CODE_FILE = /(?:^|[\s'"`(\/])[\w./-]+\.(?:tsx?|jsx?|py|html?|css|scss|json|ya?ml|sql|go|rs|java|kt|php|rb|swift|dart|c|h|cc|cpp|cs|vue|svelte|sh)\b/i;

const RESEARCH_CUE =
  /\b(?:research|literature review|systematic review|meta[- ]analysis|citations?|cite|sources?|evidence|peer[- ]reviewed|papers?|journal|investigate|fact[- ]check|verify (?:the )?claims?|state of the art)\b/i;
const STUDY_CUE =
  /\b(?:quiz|quizzes|flashcards?|study plan|study guide|exam prep|revision|revise for|tutor|teach me|lesson|syllabus|coursework|memori[sz]e|practice questions?|mcq)\b/i;
const HEALTH_CUE =
  /\b(?:symptoms?|diagnos\w*|medication|medicine|dosage|dose|side effects?|blood pressure|doctor|clinician|clinic|hospital|treatment|therap(?:y|ies)|medical report|lab report|fever|pain|illness|disease|infection|vaccine|mental health|anxiety|depression)\b/i;

/**
 * Information questions ("How do I export data to CSV?", "What is a PDF?") must
 * never be read as "produce that file". Requests phrased as questions but
 * clearly asking Matrix to do the work ("Can you make this a PDF?") still pass.
 */
const INFO_QUESTION =
  /^\s*(?:what|who|why|where|when|which|how\s+(?:do|does|did|can|could|to|is|are|was|were|much|many|long|often)|explain|define|describe|tell me about|is there|are there)\b/i;
const PLEASES = /\b(?:please|for me)\b/i;

/** True when the message only asks *about* something rather than requesting it. */
function isInformationQuestion(text: string): boolean {
  return INFO_QUESTION.test(text) && !PLEASES.test(text);
}

function unique<T>(list: T[]): T[] {
  return list.filter((value, index) => list.indexOf(value) === index);
}

function distinctVerbs(text: string): string[] {
  const matches = text.match(new RegExp(AGENT_VERB.source, "gi")) ?? [];
  return unique(matches.map((m) => m.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Detection primitives
// ---------------------------------------------------------------------------

/**
 * Formats the user explicitly asked for. A bare mention ("what is a PDF?") is
 * not a request — a production verb, a preposition ("as/into/to/in") or a
 * deliverable noun next to the format is required.
 */
export function detectExportFormats(input: string): ExportFormat[] {
  const text = input.trim();
  if (!text) return [];
  if (SUPPRESS_EXPORT.test(text)) return [];
  if (isInformationQuestion(text)) return [];

  const found: ExportFormat[] = [];
  for (const { format, re } of FORMAT_PATTERNS) {
    const global = new RegExp(re.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
      const start = Math.max(0, match.index - 64);
      const end = Math.min(text.length, match.index + match[0].length + 32);
      const window = text.slice(start, end);
      if (PRODUCE_VERB.test(window) || DELIVERABLE_NOUN.test(window)) {
        found.push(format);
        break;
      }
    }
  }
  return unique(found);
}

/** "Make a report" — a document was requested without a format. */
export function detectDocumentWithoutFormat(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 600) return false;
  if (detectExportFormats(text).length > 0) return false;
  if (SUPPRESS_EXPORT.test(text)) return false;
  if (!DOCUMENT_NOUN.test(text)) return false;
  return DOCUMENT_VERB.test(text);
}

export function detectSuppressedExport(input: string): boolean {
  return SUPPRESS_EXPORT.test(input);
}

export function detectImageRequest(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 1200) return false;
  if (isInformationQuestion(text)) return false;
  if (!IMAGE_NOUN.test(text)) return false;
  if (!IMAGE_VERB.test(text)) return false;
  // "Create an image component in React" is code, not a picture.
  if (/\b(component|hook|class|function|api|endpoint|library|package|tag|element)\b/i.test(text) && CODE_LANGUAGE.test(text)) return false;
  return true;
}

export function detectAgentTask(input: string): boolean {
  const text = input.trim();
  if (!text || text.length > 2000) return false;
  if (isInformationQuestion(text)) return false;
  if (AGENT_EXPLICIT.test(text) && AGENT_TARGET.test(text)) return true;
  const verbs = distinctVerbs(text);
  // A multi-step execution request: several distinct actions aimed at a real
  // target ("analyse my project, find the bug, fix it and run the tests").
  return verbs.length >= 2 && AGENT_TARGET.test(text);
}

export function detectCodeRequest(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/```[\s\S]*```/.test(text)) return true; // the user pasted code
  if (CODE_FILE.test(text) && (CODE_VERB.test(text) || /\b(?:bug|error|issue|broken|failing|crash)\b/i.test(text))) return true;
  if (CODE_VERB.test(text) && CODE_TASK_NOUN.test(text)) {
    // "fix the bug in my project" is an agent task when it is multi-step; a
    // single code deliverable stays CODE.
    const window = text.slice(0, 220);
    if (CODE_LANGUAGE.test(window) || CODE_TASK_NOUN.test(window)) return true;
  }
  if (CODE_LANGUAGE.test(text) && CODE_TASK_NOUN.test(text) && !isInformationQuestion(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export type IntentContext = {
  /** Active Matrix mode. Explicit user wording always beats the mode. */
  mode?: ChatMode;
  /** True when the user pressed the Image capability in the composer. */
  imageCapability?: boolean;
  /** True when the user pressed the Code capability in the composer. */
  codeCapability?: boolean;
  /** True when Agent Mode is selected in the top bar. */
  agentMode?: boolean;
};

/**
 * Classify one user message. Never throws, never guesses: when the request is
 * ambiguous the result stays `CHAT` / `NONE` (plus an optional format choice).
 */
export function detectIntent(input: string, context: IntentContext = {}): IntentResult {
  const text = (input ?? "").trim();
  const mode = context.mode ?? "general";
  const signals: string[] = [];
  if (!text) return { ...DEFAULT_INTENT, signals };

  const suppressExport = detectSuppressedExport(text);
  if (suppressExport) signals.push("export refused by user");

  const formats = suppressExport ? [] : detectExportFormats(text);
  if (formats.length) signals.push(`format named: ${formats.join(", ")}`);

  const wantsImage = context.imageCapability === true || mode === "image" || (!suppressExport && detectImageRequest(text));
  if (wantsImage) signals.push(context.imageCapability || mode === "image" ? "image capability active" : "image creation requested");

  const wantsAgent =
    context.agentMode === true ||
    mode === "agent" ||
    (mode === "orchestrator" ? false : detectAgentTask(text));
  if (wantsAgent) signals.push(mode === "agent" || context.agentMode ? "agent mode active" : "multi-step execution requested");

  const wantsCode = context.codeCapability === true || mode === "code" || detectCodeRequest(text);
  if (wantsCode) signals.push(mode === "code" || context.codeCapability ? "code capability active" : "code deliverable requested");

  const wantsResearch = mode === "research" || RESEARCH_CUE.test(text);
  const wantsStudy = mode === "study" || STUDY_CUE.test(text);
  const wantsHealth = mode === "health" || HEALTH_CUE.test(text);
  const needsFormatChoice = !suppressExport && formats.length === 0 && detectDocumentWithoutFormat(text);
  if (needsFormatChoice) signals.push("document requested without a format");

  // --- intent precedence ---------------------------------------------------
  // 1. Explicit artifacts beat everything (user request overrides automation).
  // 2. Explicit image / agent / code capabilities follow.
  // 3. Domain intents (research / study / health) shape the answer.
  // 4. Default: plain chat.
  let intent: IntentId = "CHAT";
  let artifact: ArtifactType = "NONE";
  let artifactRequested = false;
  let provider: IntentResult["provider"] = null;

  if (formats.length > 0) {
    intent = "EXPORT";
    artifact = formatToArtifact(formats[0]);
    artifactRequested = true;
  } else if (wantsImage) {
    intent = "IMAGE_GENERATION";
    artifact = "IMAGE";
    artifactRequested = true;
    provider = "together_ai";
  } else if (wantsAgent) {
    intent = mode === "orchestrator" ? "CHAT" : "AGENT_TASK";
    artifact = intent === "AGENT_TASK" ? "AGENT_TASK" : "NONE";
    artifactRequested = intent === "AGENT_TASK";
  } else if (wantsCode) {
    intent = "CODE";
    artifact = "CODE";
  } else if (needsFormatChoice) {
    intent = "FORMAT_CLARIFY";
  } else if (wantsResearch) {
    intent = "RESEARCH";
    artifact = "RESEARCH";
  } else if (wantsStudy) {
    intent = "STUDY";
  } else if (wantsHealth) {
    intent = "HEALTH";
  }

  // A coding/agent request that also names a file format keeps both: the task
  // intent drives the answer, the artifact drives the export UI.
  if (formats.length > 0) {
    if (wantsAgent && !wantsImage) {
      intent = "AGENT_TASK";
      artifact = formatToArtifact(formats[0]);
      artifactRequested = true;
    } else if (wantsCode) {
      intent = "CODE";
      artifact = formatToArtifact(formats[0]);
      artifactRequested = true;
    }
  }

  return {
    intent,
    artifact,
    artifactRequested,
    formats,
    needsFormatChoice,
    formatChoices: needsFormatChoice ? ["pdf", "docx", "markdown"] : [],
    suppressExport,
    provider,
    signals,
  };
}

export function formatToArtifact(format: ExportFormat): ArtifactType {
  switch (format) {
    case "pdf": return "PDF";
    case "docx": return "DOCX";
    case "csv": return "CSV";
    case "xlsx": return "XLSX";
    case "json": return "JSON";
    case "txt": return "TXT";
    case "markdown": return "MARKDOWN";
    default: return "NONE";
  }
}

export function artifactToFormat(artifact: ArtifactType): ExportFormat | null {
  switch (artifact) {
    case "PDF": return "pdf";
    case "DOCX": return "docx";
    case "CSV": return "csv";
    case "XLSX": return "xlsx";
    case "JSON": return "json";
    case "TXT": return "txt";
    case "MARKDOWN": return "markdown";
    default: return null;
  }
}

/** Capability selection: which gateway action this request needs. */
export function selectCapability(result: IntentResult, mode: ChatMode): Capability {
  if (mode === "orchestrator") return "orchestrate";
  if (result.intent === "IMAGE_GENERATION" || mode === "image") return "image";
  if (result.intent === "AGENT_TASK" || mode === "agent") return "agent";
  return "chat";
}

/**
 * The mode Matrix should actually send to the gateway for this one message.
 * Explicit intent can upgrade a General-mode message into an Agent/Image run
 * without permanently switching the user's UI mode.
 */
export function effectiveMode(result: IntentResult, mode: ChatMode): ChatMode {
  const capability = selectCapability(result, mode);
  if (capability === "image") return "image";
  if (capability === "agent") return "agent";
  return mode;
}

// ---------------------------------------------------------------------------
// Response content analysis — drives the contextual action row
// ---------------------------------------------------------------------------

export type ContentSignals = {
  hasCodeBlock: boolean;
  codeLanguages: string[];
  hasTable: boolean;
  hasCsvData: boolean;
  hasJson: boolean;
  hasLists: boolean;
  hasSources: boolean;
  hasFlashcards: boolean;
  wordCount: number;
  /** Long, structured prose — a document rather than a chat reply. */
  isDocument: boolean;
};

export const EMPTY_SIGNALS: ContentSignals = {
  hasCodeBlock: false,
  codeLanguages: [],
  hasTable: false,
  hasCsvData: false,
  hasJson: false,
  hasLists: false,
  hasSources: false,
  hasFlashcards: false,
  wordCount: 0,
  isDocument: false,
};

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const MARKDOWN_TABLE_ROW = /^\s*\|?.*\|.*\|?\s*$/;
const MARKDOWN_TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

export function analyzeContent(content: string): ContentSignals {
  const text = content ?? "";
  if (!text.trim()) return { ...EMPTY_SIGNALS };

  const languages: string[] = [];
  let hasJson = false;
  let hasCsvFence = false;
  let hasCodeBlock = false;
  const fence = new RegExp(FENCE.source, "g");
  let match: RegExpExecArray | null;
  const fencedRanges: Array<[number, number]> = [];
  while ((match = fence.exec(text)) !== null) {
    hasCodeBlock = true;
    fencedRanges.push([match.index, match.index + match[0].length]);
    const lang = (match[1] ?? "").trim().toLowerCase();
    if (lang) languages.push(lang);
    if (lang === "json" || lang === "jsonc") hasJson = true;
    if (lang === "csv" || lang === "tsv") hasCsvFence = true;
  }

  const outsideFences = text
    .split("")
    .map((ch, i) => (fencedRanges.some(([s, e]) => i >= s && i < e) ? "" : ch))
    .join("");

  // Markdown table: a divider row (---|---) with a header row above it.
  const lines = outsideFences.split("\n");
  let hasTable = false;
  for (let i = 1; i < lines.length; i++) {
    if (MARKDOWN_TABLE_DIVIDER.test(lines[i]) && MARKDOWN_TABLE_ROW.test(lines[i - 1]) && lines[i - 1].includes("|")) {
      hasTable = true;
      break;
    }
  }

  // CSV-shaped data: 3+ consecutive rows with a consistent comma column count.
  const csvRows = outsideFences.split("\n").filter((line) => line.includes(",") && !/^\s*(?:#|[-*•]|\d+[.)]|>)/.test(line));
  let hasCsvData = hasCsvFence;
  if (!hasCsvData && csvRows.length >= 3) {
    const counts = csvRows.slice(0, 6).map((line) => line.split(",").length);
    hasCsvData = counts.every((count) => count >= 2 && count === counts[0]);
  }

  if (!hasJson) {
    const jsonBlock = outsideFences.match(/[{[][\s\S]{20,}[}\]]/);
    if (jsonBlock && /"\w+"\s*:/.test(jsonBlock[0])) hasJson = true;
  }

  const hasLists = /^\s*(?:[-*•]\s+|\d+[.)]\s+)/m.test(outsideFences);
  const hasSources =
    /(https?:\/\/[^\s)]+)|^\s*(?:sources?|references?|citations?|further reading)\s*:?/im.test(outsideFences) ||
    /^\s*\[\d+\]\s/m.test(outsideFences);
  const hasFlashcards = /(?:^|\n)\s*(?:Q|Question|Front)\s*[:.-]\s*.+(?:\n)\s*(?:A|Answer|Back)\s*[:.-]\s*.+/i.test(text);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  return {
    hasCodeBlock,
    codeLanguages: unique(languages),
    hasTable,
    hasCsvData,
    hasJson,
    hasLists,
    hasSources,
    hasFlashcards,
    wordCount,
    isDocument: wordCount >= 220 && (hasLists || hasTable || /^#{1,4}\s/m.test(outsideFences)),
  };
}

/** True when the reply holds structured tabular data worth exporting as CSV. */
export function hasTabularData(signals: ContentSignals): boolean {
  return signals.hasTable || signals.hasCsvData;
}

/**
 * Export formats that make sense for this reply. CSV/JSON/XLSX only appear when
 * the content actually holds tabular or structured data — a prose answer never
 * offers a spreadsheet.
 */
export function availableExportFormats(signals: ContentSignals, explicit: ExportFormat[] = []): ExportFormat[] {
  const formats: ExportFormat[] = ["pdf", "docx", "markdown", "txt"];
  if (signals.hasJson) formats.push("json");
  if (hasTabularData(signals)) formats.push("csv");
  for (const format of explicit) if (!formats.includes(format)) formats.push(format);
  return formats;
}

// ---------------------------------------------------------------------------
// Contextual response actions
// ---------------------------------------------------------------------------

export type ResponseActionId =
  | "copy"
  | "regenerate"
  | "listen"
  | "more"
  | "copyCode"
  | "run"
  | "explain"
  | "save"
  | "editPrompt"
  | "sources"
  | "export"
  | "open"
  | "copyJson"
  | "activity"
  | "performance"
  | "flashcards"
  | "workspace"
  | "report";

export type ResponseKind = "chat" | "code" | "image" | "research" | "document" | "agent" | "data";

export type ActionContext = {
  intent: IntentId;
  mode: ChatMode;
  signals: ContentSignals;
  /** An artifact was produced (or is ready) for this message. */
  artifactType: ArtifactType;
  artifactReady: boolean;
  /** True when the ready artifact is a format a browser can render inline. */
  artifactOpenable?: boolean;
  /** Execution happened (agent run, tool call) and can be inspected. */
  hasExecution: boolean;
  /** Real performance numbers exist for this message. */
  hasAnalytics: boolean;
  /** A code runner / Agent workspace is actually available. */
  canRun: boolean;
  canListen: boolean;
  canExport: boolean;
  /** Compact (mobile) layout — fewer visible actions, the rest go to More. */
  compact?: boolean;
};

/** Classify a finished reply so the action row matches the response type. */
export function classifyResponseKind(context: Pick<ActionContext, "intent" | "mode" | "signals" | "artifactType">): ResponseKind {
  if (context.artifactType === "IMAGE" || context.intent === "IMAGE_GENERATION" || context.mode === "image") return "image";
  if (context.artifactType === "CSV" || context.artifactType === "XLSX" || context.artifactType === "JSON") return "data";
  if (context.artifactType === "AGENT_TASK" || context.intent === "AGENT_TASK" || context.mode === "agent") return "agent";
  if (context.signals.hasCodeBlock || context.intent === "CODE" || context.mode === "code") return "code";
  if (context.intent === "RESEARCH" || context.mode === "research" || context.signals.hasSources) return "research";
  if (["PDF", "DOCX", "TXT", "MARKDOWN"].includes(context.artifactType) || context.signals.isDocument) return "document";
  return "chat";
}

/**
 * Decide which actions are visible and which live in the More menu.
 * Never returns every possible action — only the valid ones for this reply.
 */
export function planResponseActions(context: ActionContext): { primary: ResponseActionId[]; overflow: ResponseActionId[] } {
  const kind = classifyResponseKind(context);
  const maxPrimary = context.compact ? 1 : 3;
  const wanted: ResponseActionId[] = [];

  switch (kind) {
    case "image":
      wanted.push("save", "regenerate", "editPrompt");
      break;
    case "code":
      wanted.push("copyCode");
      if (context.canRun) wanted.push("run");
      wanted.push("explain", "copy", "regenerate");
      break;
    case "data":
      // Open only exists once the file really is built and is browser-viewable.
      if (context.artifactReady && context.artifactOpenable !== false) wanted.push("open");
      wanted.push("copy", "regenerate");
      if (context.canExport) wanted.push("export");
      break;
    case "research":
      if (context.signals.hasSources) wanted.push("sources");
      wanted.push("copy", "regenerate");
      if (context.canExport) wanted.push("export");
      break;
    case "document":
      if (context.artifactReady && context.artifactOpenable !== false) wanted.push("open");
      wanted.push("copy", "regenerate");
      if (context.canExport) wanted.push("export");
      break;
    case "agent":
      wanted.push("copy", "regenerate");
      if (context.hasExecution) wanted.push("activity");
      break;
    default:
      wanted.push("copy", "regenerate");
      break;
  }

  // Secondary, always available through More (never all rendered inline).
  const overflow: ResponseActionId[] = [];
  if (context.canListen && kind !== "image") overflow.push("listen");
  if (context.hasExecution && kind !== "agent") overflow.push("activity");
  if (context.hasAnalytics) overflow.push("performance");
  if (context.canExport && !wanted.includes("export")) overflow.push("export");
  if (context.signals.hasFlashcards) overflow.push("flashcards");
  if (kind === "agent" && context.canRun) overflow.push("workspace");
  overflow.push("report");

  const deduped = unique(wanted);
  return { primary: deduped.slice(0, maxPrimary), overflow: unique([...deduped.slice(maxPrimary), ...overflow]) };
}

/** Small helper for tests/UI copy: is this intent "just a conversation"? */
export function isPlainChat(result: IntentResult): boolean {
  return result.intent === "CHAT" && result.artifact === "NONE" && !result.artifactRequested;
}
