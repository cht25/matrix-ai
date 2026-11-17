// =============================================================================
// QORVYNA routing policy — WHICH KIND OF WORK this turn is, and therefore
// which model class is allowed to do it.
//
// Phase-5 contract (see app_build_guide.md § "AI model configuration"):
//
//   conversation        "Hello", general questions, normal coding questions
//                       → GPT OSS 120B (primary)
//                       → GPT OSS 20B (fallback, only when 120B is genuinely
//                         unavailable; the fallback is always reported)
//
//   artifact            website creation, HTML/CSS/JS generation, application
//                       scaffolding, PDF/document content, structured file
//                       creation, codebase modification, large multi-file
//                       generation
//                       → GLM 4.7 Flash on Cloudflare Workers AI
//                       → GPT OSS team when Cloudflare is not configured /
//                         unavailable (reported, never silent)
//
//   image               image generation → the configured image provider
//                       (GLM plans the prompt; it never emits binary images)
//
// Rules this module exists to guarantee:
//   • classification is deterministic — same text, same decision, no model call;
//   • the model class is chosen from the REQUEST, not from a hardcoded default;
//   • a manual model selection is never silently overridden: the preference is
//     expressed as `models: { auto: false, enabled: [...] }` and the resolver
//     in ./models/pool.ts honours it (and says when it cannot).
//
// Pure module: no React, no network, no Firestore — fully unit tested.
// =============================================================================

/** The three capability classes the router distinguishes. */
export type RouteIntent = "conversation" | "artifact" | "image";

/** What a selected model class must be able to do for this turn. */
export type RequiredCapability = "chat" | "code-generation" | "long-form" | "image-generation";

export type RouteClassification = {
  intent: RouteIntent;
  /** Capabilities the chosen model must have for this turn. */
  requires: RequiredCapability[];
  /** The model class the policy selects. */
  preferred: "conversation" | "artifact" | "image";
  /** Human-readable reason, shown in the execution steps (never fabricated). */
  reason: string;
  /** Signals that matched (kept short; used for diagnostics and tests). */
  signals: string[];
  /** True when the turn is expected to produce files/documents worth staging. */
  producesArtifact: boolean;
};

// --- artifact / generation requests -----------------------------------------
// A verb that makes something, aimed at a machine-readable object.
/**
 * Verbs that by themselves mean "produce a deliverable". "Write", "implement",
 * "design" and friends are deliberately NOT here: "write a python function" is
 * a normal coding answer, not a multi-file artifact job.
 */
const STRONG_MAKE_VERB = String.raw`(?:build|create|make|generate|scaffold|produce|assemble|rebuild|convert|export|turn\s+(?:this|that|it)\s+into)`;

/** Anything a strong verb can be aimed at. */
const ARTIFACT_OBJECT = String.raw`(?:web\s?site|web\s?site|web\s?app|webapp|landing\s+page|frontend|front-end|backend|back-end|api|app|application|platform|dashboard|site|page|html|css|javascript|js|typescript|react|next\.?js|vue|svelte|sveltekit|tailwind|python|node|express|fastapi|flask|django|sql|schema|component|function|class|module|script|program|game|blog|portfolio|store|shop|pdf|document|docx?|report|invoice|certificate|resume|cv|presentation|spreadsheet|csv|json|yaml|xml|markdown|file|files|project|codebase|scaffold|template|boilerplate|repository|repo|config|configuration)`;

/**
 * A deliverable CONTAINER (many files / a rendered file). Only these count
 * after a weak verb such as "write" or "design".
 */
const DELIVERABLE_OBJECT = String.raw`(?:web\s?site|web\s?app|webapp|landing\s+page|site|app|application|platform|dashboard|project|codebase|repository|repo|boilerplate|scaffold|pdf|document|docx|report|invoice|certificate|presentation|spreadsheet|json\s+file|yaml\s+file|html\s+file|css\s+file|component\s+library|template|config(?:uration)?\s+file)`;

/** Words that introduce an instruction rather than a question. */
const LEAD_IN = String.raw`(?:^|[.!?;:,\n]\s*|\b(?:please|pls|kindly|now|then|also|and|can\s+you|could\s+you|would\s+you|will\s+you|i\s+want\s+(?:you\s+)?to|i\s+need\s+(?:you\s+)?to|i(?:'d|\s+would)\s+like\s+(?:you\s+)?to|you\s+(?:should|need\s+to|must|have\s+to|can)|let'?s|go\s+ahead\s+and|help\s+me(?:to)?|try\s+to|we\s+(?:should|need\s+to))\s+)`;

/** "Build me a website", "create a PDF", "scaffold an app" — strong verb + object. */
const ARTIFACT_REQUEST_RE = new RegExp(
  String.raw`${LEAD_IN}${STRONG_MAKE_VERB}\b[\s\S]{0,60}?\b${ARTIFACT_OBJECT}\b`,
  "i",
);

/** "write a landing page", "design a dashboard" — weak verb + deliverable only. */
const WEAK_MAKE_REQUEST_RE = new RegExp(
  String.raw`${LEAD_IN}(?:write|code|implement|develop|design|draft|prepare|compose|set\s*up)\b[\s\S]{0,40}?\b${DELIVERABLE_OBJECT}\b`,
  "i",
);

/** Unambiguous multi-file / codebase work, no verb-object pairing needed. */
const CODEBASE_RE = /\b(codebase|multi-?file|multiple files|whole project|entire project|project files?|full[- ]stack|boilerplate|scaffold(?:ing)?)\b/i;

/** Explicit file creation with an extension: "a .html file", "three .tsx files". */
const FILE_EXTENSION_RE = /\.(?:html?|css|js|jsx|ts|tsx|json|md|py|sql|yaml|yml|toml|sh|txt|pdf|docx?)\b/i;

/** Document export intent — content plus a real rendering step. */
const DOCUMENT_RE = /\b(pdf|docx|word\s+document|report\s+file|export\s+(?:as|to)\s+(?:pdf|docx?)|downloadable\s+(?:pdf|document)|spreadsheet|csv\s+file)\b/i;

/** The user asked to modify existing files ("edit my project", "update the code"). */
const MODIFY_RE = /\b(?:edit|modify|change|update|refactor|rename|delete|remove|add|patch|fix)\b[^.!?\n]{0,40}?\b(?:file|files|project|codebase|repo|repository|component|route|page|schema)\b/i;

// --- image generation --------------------------------------------------------
const IMAGE_RE = /\b(?:generate|create|make|draw|paint|render|design|imagine|produce)\b[^.!?\n]{0,30}?\b(?:image|picture|photo|illustration|logo|icon|poster|artwork|wallpaper|thumbnail|graphic|drawing)\b/i;

// --- keep a conversation a conversation --------------------------------------
// Questions ABOUT these subjects are coding *questions*, not artifact jobs.
// "Can you build…" / "Could you create…" are polite INSTRUCTIONS, not
// questions, so they are deliberately absent here.
const QUESTION_LEAD_RE = /^\s*(?:what|why|how|when|where|which|who|whose|whom|is|are|was|were|does|do|did|explain|tell\s+me|help\s+me\s+understand|compare)\b/i;
const EXPLAIN_RE = /\b(?:explain|what\s+is|what\s+are|how\s+does|how\s+do|why\s+(?:is|does|do)|difference\s+between|meaning\s+of|teach\s+me|show\s+me\s+how|example\s+of|best\s+practice)\b/i;

// --- signals that change the fallback story ----------------------------------
const HEAVY_RE = /\b(?:entire|whole|complete|full|production|multi-?page|multi-?file|dashboard|authentication|database|checkout|admin\s+panel)\b/i;

/** Longest message the classifier reads (keeps RegExp cost bounded). */
const MAX_SCAN = 4000;

export type ClassifyInput = {
  message: string;
  /** Chat mode / lane from the client (agent & image modes are authoritative). */
  mode?: string | null;
  /** True when the client explicitly asked for an image reply. */
  imageRequested?: boolean;
  /** True when the user asked for a downloadable artifact. */
  exportRequested?: boolean;
  /** Number of attachments (an attachment makes work code-shaped). */
  attachments?: number;
};

/**
 * Classify a turn. Deterministic and cheap: the router calls this once per
 * request, and the same inputs always produce the same route.
 */
export function classifyRoute(input: ClassifyInput): RouteClassification {
  const raw = (input.message ?? "").slice(0, MAX_SCAN);
  const text = raw.trim();
  const signals: string[] = [];

  // A described picture is an image request even without the word "generate".
  const imageMode = input.imageRequested === true || input.mode === "image";
  if (imageMode) {
    return {
      intent: "image",
      requires: ["image-generation"],
      preferred: "image",
      reason: "Image generation requested — the image provider draws it; a language model only plans the prompt.",
      signals: ["image-mode"],
      producesArtifact: true,
    };
  }

  // A picture request phrased in words ("generate an image of a robot",
  // "make a logo") goes to the image provider. Questions about images
  // ("how do I generate an image in Python?") stay conversational.
  if (IMAGE_RE.test(text) && !QUESTION_LEAD_RE.test(text) && !DOCUMENT_RE.test(text)) {
    return {
      intent: "image",
      requires: ["image-generation"],
      preferred: "image",
      reason: "Image generation requested — the image provider draws it; a language model only plans the prompt.",
      signals: ["image-words"],
      producesArtifact: true,
    };
  }

  // An explicit export ("download this as PDF") needs a rendering engine, and
  // its content/structure is a document-generation job.
  if (input.exportRequested === true) {
    signals.push("export-requested");
  }

  const looksLikeQuestion = QUESTION_LEAD_RE.test(text);
  const explaining = EXPLAIN_RE.test(text) && !/\b(?:build|create|make|generate|scaffold|implement)\b/i.test(text);
  const agentMode = input.mode === "agent";

  const artifactSignals: string[] = [];
  if (ARTIFACT_REQUEST_RE.test(text)) artifactSignals.push("make-object");
  if (WEAK_MAKE_REQUEST_RE.test(text)) artifactSignals.push("make-deliverable");
  if (CODEBASE_RE.test(text)) artifactSignals.push("multi-file");
  if (DOCUMENT_RE.test(text)) artifactSignals.push("document");
  if (FILE_EXTENSION_RE.test(text) && !looksLikeQuestion) artifactSignals.push("file-extension");
  if (MODIFY_RE.test(text)) artifactSignals.push("modify-existing");
  if (input.exportRequested === true) artifactSignals.push("export");
  if (agentMode && (artifactSignals.length > 0 || /\b(?:build|create|make|generate|implement|scaffold)\b/i.test(text))) {
    artifactSignals.push("agent-mode");
  }

  // A question that merely mentions a technology stays conversational:
  // "how do I build a website with React?" is a coding question.
  const questionOverrides =
    (looksLikeQuestion || explaining) && !agentMode && input.exportRequested !== true && !FILE_EXTENSION_RE.test(text);
  if (questionOverrides) {
    return {
      intent: "conversation",
      requires: ["chat"],
      preferred: "conversation",
      reason: "A question about the topic is answered as conversation — it does not create files.",
      signals: [...signals, "question"],
      producesArtifact: false,
    };
  }

  if (artifactSignals.length > 0) {
    const requires: RequiredCapability[] = ["code-generation"];
    if (DOCUMENT_RE.test(text) || input.exportRequested === true) requires.push("long-form");
    if (HEAVY_RE.test(text)) requires.push("long-form");
    return {
      intent: "artifact",
      requires: [...new Set(requires)],
      preferred: "artifact",
      reason: artifactSignals.includes("document")
        ? "Document creation — GLM 4.7 Flash writes the content and structure; a PDF/text engine renders the file."
        : "Artifact generation — GLM 4.7 Flash writes the files, then the build pipeline validates them.",
      signals: [...signals, ...artifactSignals],
      producesArtifact: true,
    };
  }

  const coding =
    /\b(?:code|function|bug|error|debug|script|api|regex|sql|algorithm|typescript|javascript|python|react|css|html)\b/i.test(text);
  return {
    intent: "conversation",
    requires: [coding ? "code-generation" : "chat"],
    preferred: "conversation",
    reason: "Conversation — GPT OSS 120B answers (GPT OSS 20B takes over only if 120B is unavailable).",
    signals: [...signals, "chat"],
    producesArtifact: false,
  };
}

/** Convenience: does this turn belong on the artifact (GLM) class? */
export function isArtifactRequest(input: ClassifyInput): boolean {
  return classifyRoute(input).intent === "artifact";
}

/** Convenience: is this an image-generation turn? */
export function isImageRequest(input: ClassifyInput): boolean {
  return classifyRoute(input).intent === "image" || IMAGE_RE.test((input.message ?? "").slice(0, MAX_SCAN));
}
