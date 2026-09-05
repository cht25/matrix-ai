// =============================================================================
// MATRIX build / publish intent (§2, §25, §26)
//
//   "Make it" · "Build it" · "Create the website" · "Build this project"
//   "Make the app" · "Fix and publish it" · "Deploy this" · "Host this"
//        → a REAL build run: plan → files → build → validate → publish
//
//   "Hi" · "Explain React" · "What is Python?" · "How do I deploy to Vercel?"
//        → nothing. No files, no build, no publish, no popup.
//
// Publishing is only requested when the user actually asked to publish, deploy
// or host something (§16: build → preview → publish). A bare "make it" with no
// project and no prior plan asks one short clarifying question instead of
// guessing (§26).
//
// Pure + deterministic: no React, no network, no Firestore — unit tested.
// =============================================================================

import type { ChatMode } from "@/lib/ai/modes";
import { slugify } from "@/lib/projects/paths";

export type BuildIntent = {
  /** Generate or refresh project files with the Agent. */
  build: boolean;
  /** Publish through the deployment provider. */
  publish: boolean;
  /** Open the in-app preview environment. */
  preview: boolean;
  /** Repair the existing project before building. */
  fix: boolean;
  /** The user used explicit build/publish wording (not just Agent mode). */
  explicit: boolean;
  /** Request is real but under-specified: ask one question, never deploy. */
  needsClarification: boolean;
  clarification: string | null;
  signals: string[];
};

export const NO_BUILD_INTENT: BuildIntent = {
  build: false,
  publish: false,
  preview: false,
  fix: false,
  explicit: false,
  needsClarification: false,
  clarification: null,
  signals: [],
};

const BUILD_VERB = /\b(?:build|built|make|made|create|creating|generate|scaffold|implement|develop|write|code|draw\s+up|turn\s+(?:this|that|it|into)|convert\s+(?:this|it))\b/i;
const PUBLISH_VERB = /\b(?:publish|deploy|host|ship|launch|go\s+live|put\s+(?:it|this)\s+(?:online|live)|make\s+(?:it|this)\s+(?:public|live|available\s+online))\b/i;
const PREVIEW_VERB = /\b(?:preview|pre-view|show\s+me\s+(?:it|the\s+site)\s+live|open\s+it\s+in\s+a\s+browser|run\s+it|try\s+it)\b/i;
const FIX_VERB = /\b(?:fix|repair|debug|correct|resolve|patch|repair|clean\s+up)\b/i;

const TARGET =
  /\b(?:website|web\s?site|web\s?app|webpage|web\s?page|landing\s+page|homepage|home\s+page|site|portfolio|project|app|application|store|shop|game|dashboard|prototype|page|form|blog|resume|cv|profile|component|webpage)\b/i;

/** "it / this / that" instead of naming the artifact — needs conversation context. */
const PRONOUN_TARGET = /\b(?:it|this|that|these|those|everything|the\s+whole\s+thing)\b/i;

/** Refusals win over automation, always. */
const SUPPRESS =
  /\b(?:don'?t|do\s+not|dont|never|no|without|skip|avoid|stop)\s+(?:me\s+)?(?:publish|deploy|host|ship|build|make|create|generating|a\s+deploy|it\s+published)\b|\bno\s+(?:deploy|publish|hosting)\b|\bjust\s+(?:explain|tell|show)\s+me\b/i;

/** Questions about the concept, not requests for the work. */
const INFO_QUESTION =
  /^\s*(?:what|who|why|where|when|which|how|is|are|do|does|did|can\s+you\s+(?:explain|tell|describe)|should|could\s+you\s+explain|difference\s+between)\b/i;
const IMPERATIVE_PLEASE = /\b(?:please|for\s+me|i\s+(?:want|need|would\s+like)|now|directly|immediately|right\s+away)\b/i;
const SHORT_CONFIRM = /^(?:\s*(?:ok(?:ay)?|yes|yep|yeah|sure|great|perfect|go\s+ahead|do\s+it|go\s+for\s+it|please|thanks|thank\s+you|👍|yes\s+please)[\s.!]*)+$/i;

export type BuildIntentContext = {
  mode?: ChatMode;
  agentMode?: boolean;
  /** The conversation already has a real project (server-side file count). */
  projectFileCount?: number;
  /** True when the previous assistant turn described or drafted the thing. */
  priorPlan?: string | null;
  hasAttachments?: boolean;
};

function hasEnoughContext(context: BuildIntentContext): boolean {
  if ((context.projectFileCount ?? 0) > 0) return true;
  if (context.hasAttachments) return true;
  const prior = (context.priorPlan ?? "").trim();
  return prior.length > 40;
}

/**
 * Classify one message. Deterministic and conservative: it takes an explicit
 * build/publish verb plus an artifact target (or a pronoun with real context)
 * before it will ever return `build: true`.
 */
export function detectBuildIntent(input: string, context: BuildIntentContext = {}): BuildIntent {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  const signals: string[] = [];
  if (!text) return { ...NO_BUILD_INTENT };

  if (SUPPRESS.test(text)) {
    return { ...NO_BUILD_INTENT, signals: ["build/publish refused by user"] };
  }

  const agentMode = context.agentMode === true || context.mode === "agent";
  const looksLikeQuestion = INFO_QUESTION.test(text) && !IMPERATIVE_PLEASE.test(text);
  if (looksLikeQuestion) return { ...NO_BUILD_INTENT, signals: ["information question"] };

  const namedTarget = TARGET.test(text);
  const pronounTarget = PRONOUN_TARGET.test(text);
  const confirmOnly = SHORT_CONFIRM.test(text) && agentMode;

  const buildVerb = BUILD_VERB.test(text);
  const publishVerb = PUBLISH_VERB.test(text);
  const fixVerb = FIX_VERB.test(text);
  const previewVerb = PREVIEW_VERB.test(text);
  const hasTarget = namedTarget || pronounTarget;

  const explicit = (buildVerb || publishVerb || fixVerb || previewVerb) && (hasTarget || pronounTarget || confirmOnly);
  if (!explicit) {
    // Agent mode alone is not permission to publish; it only permits building
    // when the user actually asked to build something.
    return { ...NO_BUILD_INTENT, signals: agentMode ? ["agent mode, no build verb"] : [] };
  }

  const needsContext = pronounTarget && !namedTarget;
  const contextReady = hasEnoughContext(context);
  if (needsContext && !contextReady) {
    return {
      ...NO_BUILD_INTENT,
      explicit: true,
      needsClarification: true,
      clarification:
        "What should I build? Give me a one-line description of the site or app (and attach any existing files) and I will create it, validate it and — if you ask — publish it.",
      signals: ["pronoun target without context"],
    };
  }

  // "make it live", "publish this", "deploy the site" → publish (needs files
  // to exist or to be generated first).
  const publish = publishVerb && (namedTarget || pronounTarget);
  const build = buildVerb || (publish && !contextReady) || fixVerb;
  const preview = previewVerb || (agentMode && build && !publish);

  if (buildVerb) signals.push("build verb");
  if (publish) signals.push("publish verb");
  if (fixVerb) signals.push("fix verb");
  if (previewVerb) signals.push("preview verb");
  if (needsContext && contextReady) signals.push("resolved from conversation context");
  if (confirmOnly) signals.push("confirmation in agent mode");

  return {
    build,
    publish,
    preview,
    fix: fixVerb,
    explicit: true,
    needsClarification: false,
    clarification: null,
    signals,
  };
}

/** Should the chat run the real build pipeline for this message? */
export function shouldRunBuildPipeline(intent: BuildIntent): boolean {
  return !intent.needsClarification && (intent.build || intent.publish || intent.preview || intent.fix);
}

/** Which pipeline actions a build run should execute. */
export function buildActionsFor(intent: BuildIntent): { build: boolean; publish: boolean; preview: boolean } {
  return {
    build: intent.build || intent.fix,
    publish: intent.publish,
    preview: intent.preview && !intent.publish,
  };
}

/**
 * Pre-flight plan for a generated project. Everything here is derived from the
 * user's own words: a project title, a hosting slug and whether an entry page
 * must be created. The pipeline persists it so the "Planning" step in the UI
 * reports work that actually happened.
 */
export function planFromRequest(text: string): { title: string; slug: string; needsEntry: boolean } {
  const cleaned = String(text ?? "")
    .replace(/^(?:please\s+|pls\s+)?(?:build|make|create|generate|scaffold|implement|fix|publish|deploy|host)\s+(?:me\s+)?(?:a|an|the|my|this|it|that)?\s*/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  const titleSource = (cleaned || text || "MATRIX project").slice(0, 60);
  const title = titleSource
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .replace(/^\w/, (c) => c.toUpperCase());
  return {
    title: title || "MATRIX project",
    slug: slugify(titleSource) || "matrix-site",
    needsEntry: /website|web ?site|landing|page|site|portfolio|store|shop|blog|app|dashboard|game/i.test(text ?? ""),
  };
}

/**
 * Requests for generated imagery inside an Agent build (§27). Only concrete
 * "generate me images for the site" phrasing counts, so a normal chat message
 * never spends image credits.
 */
export function detectImageAssetRequest(text: string): boolean {
  const clean = String(text ?? "").trim();
  if (!clean) return false;
  if (INFO_QUESTION.test(clean) && !IMPERATIVE_PLEASE.test(clean)) return false;
  return /\b(?:hero|background|feature|illustration|banner|mockup|artwork|logo|image)\s+(?:images?\s+)?(?:generated|generate|of|for)?\b/i.test(clean)
    || (/\b(?:generat\w+|create)\b/i.test(clean) && /\b(?:images?|illustrations?|graphics?|artwork|hero\s+shot)\b/i.test(clean));
}
