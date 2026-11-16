// =============================================================================
// QORVYNA build / publish intent (§2, §25, §26)
//
//   "Make it" · "Build it" · "Create the website" · "Build this project"
//   "Make the app" · "Fix and publish it" · "Deploy this" · "Host this"
//        → a REAL build run: plan → files → build → validate → publish
//
//   "Update my project" · "Change the design" · "Add this feature"
//   "Remove this component" · "Modify the backend" · "Rebrand the platform"
//        → a REAL revision run on the saved project: the Agent edits the
//          files, the pipeline validates and builds them, and the result is
//          whatever those steps actually reported.
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
  /** Change a project that already exists: the Agent edits its saved files. */
  modify?: boolean;
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
  modify: false,
  explicit: false,
  needsClarification: false,
  clarification: null,
  signals: [],
};

const BUILD_VERB = /\b(?:build|built|make|made|create|creating|generate|scaffold|implement|develop|write|code|draw\s+up|turn\s+(?:this|that|it|into)|convert\s+(?:this|it))\b/i;
/** Things a publish verb can be aimed at. */
const PUBLISHABLE = String.raw`project|website|web\s?site|site|app|application|web\s?app|platform|landing\s+page|dashboard|store|shop|portfolio|page|game|blog|build|changes|update|version`;
/**
 * "Publish", "deploy" and "go live" mean one thing. "Host", "ship" and
 * "launch" are everyday words ("launch a marketing campaign"), so they only
 * count when their object is a project or a pronoun ("host this", "ship the site").
 */
const PUBLISH_VERB = new RegExp(
  String.raw`\b(?:publish|re-?publish|deploy|re-?deploy|go\s+live|put\s+(?:it|this)\s+(?:online|live)|make\s+(?:it|this)\s+(?:public|live|available\s+online))\b` +
  String.raw`|\b(?:host|ship|launch)\s+(?:it|this|that|them|(?:my|our|the|this|that)\s+(?:[\w'’-]+\s+){0,2}?(?:${PUBLISHABLE}))\b`,
  "i",
);
const PREVIEW_VERB = /\b(?:preview|pre-view|show\s+me\s+(?:it|the\s+site)\s+live|open\s+it\s+in\s+a\s+browser|run\s+it|try\s+it)\b/i;
const FIX_VERB = /\b(?:fix|repair|debug|correct|resolve|patch|repair|clean\s+up)\b/i;

// --- changing something that already exists ---------------------------------
// Words like "complete", "update" or "change" are also nouns and adjectives
// ("that looks complete", "any update?"), so a change verb only counts where
// an instruction starts: at the start of the message or a clause, or after a
// request lead-in ("please", "can you", "I want you to", "and", …).
const LEAD_IN = String.raw`(?:^|[.!?;:,\n]\s*|\b(?:please|pls|kindly|now|then|also|and|next|first|finally|just|only|simply|quickly|actually|can\s+you|could\s+you|would\s+you|will\s+you|i\s+want\s+(?:you\s+)?to|i\s+need\s+(?:you\s+)?to|i(?:'d|\s+would)\s+like\s+(?:you\s+)?to|you\s+(?:should|need\s+to|must|have\s+to|can)|let'?s|go\s+ahead\s+and|help\s+me(?:\s+to)?|try\s+to|we\s+(?:should|need\s+to)|to)\s+)`;
const MODIFY_WORDS = String.raw`update|change|modify|edit|improve|enhance|redesign|restyle|rebrand|rename|replace|rewrite|refactor|rework|revamp|overhaul|restructure|reorgani[sz]e|upgrade|optimi[sz]e|polish|adjust|tweak|simplify|moderni[sz]e|translate|add|insert|remove|delete|hide|move|swap|apply|integrate|extend|expand|finish|complete|migrate|resize|enlarge|shrink|align|cent(?:er|re)`;
const BUILD_WORDS = String.raw`build|make|create|generate|scaffold|implement|develop|write|code`;
const FIX_WORDS = String.raw`fix|repair|debug|correct|resolve|patch|clean\s+up`;
const MODIFY_IMPERATIVE = new RegExp(`${LEAD_IN}(?:${MODIFY_WORDS})\\b`, "i");
const BUILD_IMPERATIVE = new RegExp(`${LEAD_IN}(?:${BUILD_WORDS})\\b`, "i");
const FIX_IMPERATIVE = new RegExp(`${LEAD_IN}(?:${FIX_WORDS})\\b`, "i");

/** A part of a project rather than the project itself ("the header", "the
 *  colours", "the backend"). It only identifies a project where one is the
 *  obvious subject — see `partTarget` below. */
const PART_TARGET =
  /\b(?:design|layout|theme|styles?|styling|stylesheet|css|html|colou?rs?|palette|fonts?|typography|header|footer|nav(?:bar|igation)?|menu|sidebar|hero|sections?|buttons?|logo|brand(?:ing)?|platform|ui|ux|interface|front-?end|back-?end|code(?:base)?|source|files?|features?|functionality|api|endpoints?|routes?|server|database|schema|auth(?:entication)?|login|sign-?up|animations?|images?|icons?|links?|cards?|modal|table|gallery|pricing|checkout|cart|search|filters?|dark\s+mode|light\s+mode|responsive(?:ness)?|mobile\s+(?:view|layout|version)|performance|seo|accessibility|content|text|copy|title|headings?|spacing|padding|margins?|background|gradient|banner|dependenc(?:y|ies)|packages?|config(?:uration)?|tests?|readme|docs|documentation|bugs?|errors?|script|function|class|module|query)\b/i;

/** "Explain the build errors", "review the header code" ask for words, not work. */
const EXPLAIN_REQUEST =
  /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:explain|describe|summari[sz]e|teach|tell\s+me|show\s+me\s+how|help\s+me\s+understand|walk\s+me\s+through|list|review|analy[sz]e|compare|suggest|recommend)\b/i;

/** "Don't change anything" is a refusal. ("Update the header but don't touch
 *  the footer" is an instruction with a constraint, and still runs.) */
const MODIFY_REFUSAL =
  /^\s*(?:please\s+)?(?:don'?t|do\s+not|dont|never|stop)\s+(?:chang|updat|modif|edit|touch|remov|delet|add|redesign|rewrit|replac|rebrand|renam)\w*\b/i;

/** Nouns that only make sense for software ("the backend", "the platform"):
 *  with a change verb they are project work in any mode. */
export const SOFTWARE_TARGET =
  /\b(?:platform|back-?end|front-?end|code-?base|repo(?:sitory)?|api|endpoints?|database|server|deployment|features?|functionality|ui|user\s+interface|design|layout|theme|nav(?:bar|igation(?:\s+bar)?)?)\b/i;

/** An explanation request that ALSO asks for work ("review and fix my site"). */
const THEN_DO = new RegExp(String.raw`\b(?:and|then)\s+(?:(?:then|also|please)\s+)*(?:${BUILD_WORDS}|${FIX_WORDS}|${MODIFY_WORDS}|publish|deploy|redeploy|host|ship|launch)\b`, "i");

// --- Bangla and Banglish (Bangla written in Latin letters) -------------------
// The verb comes last ("ওয়েবসাইট বানাও", "design ta change koro"), so these are
// matched anywhere in the sentence. JavaScript's \b does not see Bengali
// letters, so word boundaries are only used around Latin words.
const BN_KORO = String.raw`(?:koro|kor|korun|koren|kore\s+da[ow]|kore\s+din|kore\s+felo)`;
const BN_BUILD = new RegExp(String.raw`বানাও|বানান|বানিয়ে\s*(?:দাও|দিন)|তৈরি\s*কর|\b(?:build|create|make|generate)\s+${BN_KORO}\b|\b(?:banao|banan|baniye\s+da[ow]|toiri\s+(?:koro|korun|kore\s+da[ow]))\b`, "i");
const BN_MODIFY = new RegExp(String.raw`আপডেট|পরিবর্তন|বদলা(?:ও|ন)|বদলে\s*(?:দাও|দিন)|চেঞ্জ|এডিট|সম্পাদনা|যোগ\s*কর|অ্যাড\s*কর|মুছে\s*(?:দাও|দিন|ফেল)|সরা(?:ও|ন)|সরিয়ে\s*(?:দাও|দিন)|রিমুভ|উন্নত\s*কর|রিডিজাইন|রিব্র্যান্ড|\b(?:update|change|modify|edit|improve|redesign|rebrand|rename|replace|remove|delete|add|upgrade)\s+${BN_KORO}\b|\b(?:bodla[ow]|bodle\s+da[ow]|jog\s+koro|muche\s+da[ow]|shorao|sorao|shoriye\s+da[ow])\b`, "i");
const BN_FIX = new RegExp(String.raw`ঠিক\s*কর|ফিক্স|মেরামত|\b(?:fix|repair|debug)\s+${BN_KORO}\b|\bthik\s+(?:koro|korun|kore\s+da[ow])\b`, "i");
export const BN_PUBLISH = new RegExp(String.raw`ডিপ্লয়|পাবলিশ|প্রকাশ\s*কর|লাইভ\s*কর|হোস্ট\s*কর|\b(?:deploy|publish|host|live)\s+${BN_KORO}\b`, "i");
/** Bangla names for a whole project … */
export const BN_PROJECT_TARGET = /ওয়েবসাইট|ওয়েব\s*সাইট|সাইট|অ্যাপ|প্রজেক্ট|প্রকল্প|ড্যাশবোর্ড|পোর্টফোলিও|প্ল্যাটফর্ম|ব্যাকএন্ড|ফ্রন্টএন্ড|ল্যান্ডিং\s*পেজ|গেম|স্টোর|ব্লগ/;
/** … and for a part of one. */
const BN_PART_TARGET = /ডিজাইন|ফিচার|কম্পোনেন্ট|হেডার|ফুটার|লোগো|বাটন|থিম|লেআউট|রং|রঙ|কোড|পেজ|পেইজ|মেনু|ফন্ট/;
const BN_PRONOUN = /এটা|এটি|ওটা|সেটা|এইটা|এগুলো|\b(?:eta|eita|ota|sheta|egulo)\b/i;
const BN_QUESTION = /কিভাবে|কীভাবে|কি\s*ভাবে|কেমনে|কেন|কোথায়|কখন|[?？]\s*$|\b(?:kivabe|kibhabe|kemne|kemon\s+kore|keno|kothay)\b/i;
const BN_REFUSAL = /(?:কর|করো|করবে|করবেন|দিও|দিবে|দেবে)\s*না|\b(?:koro|korba|korben|dio)\s+na\b/i;
const BN_TEXT = new RegExp(String.raw`[\u0980-\u09ff]|\b(?:${BN_KORO}|banao|bodla[ow]|amar|eta|eita)\b`, "i");
/** Bangla script, or Bangla typed in Latin letters. */
export function isBanglaText(text: string): boolean {
  return BN_TEXT.test(text);
}

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
  if (MODIFY_REFUSAL.test(text)) {
    return { ...NO_BUILD_INTENT, signals: ["change refused by user"] };
  }

  const agentMode = context.agentMode === true || context.mode === "agent";
  const bangla = BN_TEXT.test(text);
  const looksLikeQuestion = (INFO_QUESTION.test(text) && !IMPERATIVE_PLEASE.test(text)) || (bangla && BN_QUESTION.test(text));
  if (looksLikeQuestion) return { ...NO_BUILD_INTENT, signals: ["information question"] };
  // "Explain how to deploy my site", "review the header code": words, not work
  // — unless the same sentence goes on to ask for the work ("…and fix it").
  if (EXPLAIN_REQUEST.test(text) && !THEN_DO.test(text)) return { ...NO_BUILD_INTENT, signals: ["explanation request"] };
  if (bangla && BN_REFUSAL.test(text)) return { ...NO_BUILD_INTENT, signals: ["change refused by user"] };

  const namedTarget = TARGET.test(text) || (bangla && BN_PROJECT_TARGET.test(text));
  const pronounTarget = PRONOUN_TARGET.test(text) || (bangla && BN_PRONOUN.test(text));
  const confirmOnly = SHORT_CONFIRM.test(text) && agentMode;

  const buildVerb = BUILD_VERB.test(text) || (bangla && BN_BUILD.test(text));
  const publishVerb = PUBLISH_VERB.test(text) || (bangla && BN_PUBLISH.test(text));
  const fixVerb = FIX_VERB.test(text) || (bangla && BN_FIX.test(text));
  const previewVerb = PREVIEW_VERB.test(text);

  // --- changing an existing project ----------------------------------------
  // A change verb needs something it can only mean a project by:
  //   • a project noun ("my website", "the app")                  — any mode
  //   • a software noun ("the backend", "the design")             — any mode
  //   • a part of a project ("the header", "the colours") or a bare pronoun
  //     ("change it") — only where a project is the obvious subject: an
  //     executing mode (Agent / Code) or a conversation that already has one.
  //     In ordinary chat "change the title" or "improve this" is about an essay.
  const executingMode = agentMode || context.mode === "code";
  const hasProject = (context.projectFileCount ?? 0) > 0;
  const projectIsSubject = executingMode || hasProject;
  const modifyVerb = MODIFY_IMPERATIVE.test(text) || (bangla && BN_MODIFY.test(text));
  const instructionVerb = modifyVerb || BUILD_IMPERATIVE.test(text) || FIX_IMPERATIVE.test(text) || (bangla && (BN_BUILD.test(text) || BN_FIX.test(text)));
  const partTarget = instructionVerb && (SOFTWARE_TARGET.test(text) || ((PART_TARGET.test(text) || (bangla && BN_PART_TARGET.test(text))) && projectIsSubject));
  const modify = modifyVerb && (namedTarget || partTarget || (pronounTarget && projectIsSubject));
  const hasTarget = namedTarget || pronounTarget || partTarget;

  const explicit = ((buildVerb || publishVerb || fixVerb || previewVerb) && (hasTarget || confirmOnly)) || modify;
  if (!explicit) {
    // Agent mode alone is not permission to publish; it only permits building
    // when the user actually asked to build something.
    return { ...NO_BUILD_INTENT, signals: agentMode ? ["agent mode, no build verb"] : [] };
  }

  const needsContext = pronounTarget && !namedTarget && !partTarget;
  const contextReady = hasEnoughContext(context);
  if (needsContext && !contextReady) {
    return {
      ...NO_BUILD_INTENT,
      explicit: true,
      needsClarification: true,
      clarification: modify && !buildVerb
        ? "Which project should I change, and what should change? Name the project (or open it in the workspace) and describe the change — I will edit the files, validate them and report exactly what happened."
        : publishVerb && !buildVerb && !fixVerb
          ? "Which project should I publish? Name it or open it in the workspace — I will publish it and report the live address, or exactly why it could not be published."
          : "What should I build? Give me a one-line description of the site or app (and attach any existing files) and I will create it, validate it and — if you ask — publish it.",
      signals: ["pronoun target without context"],
    };
  }

  // "make it live", "publish this", "deploy the site" → publish (needs files
  // to exist or to be generated first).
  const publish = publishVerb && hasTarget;
  const build = buildVerb || (publish && !contextReady) || fixVerb || modify;
  const preview = previewVerb || (agentMode && build && !publish);

  if (buildVerb) signals.push("build verb");
  if (modify) signals.push("change verb");
  if (publish) signals.push("publish verb");
  if (fixVerb) signals.push("fix verb");
  if (previewVerb) signals.push("preview verb");
  if (partTarget && !namedTarget) signals.push("project part as target");
  if (needsContext && contextReady) signals.push("resolved from conversation context");
  if (confirmOnly) signals.push("confirmation in agent mode");

  return {
    build,
    publish,
    preview,
    fix: fixVerb,
    modify,
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
  const titleSource = (cleaned || text || "QORVYNA project").slice(0, 60);
  const title = titleSource
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .replace(/^\w/, (c) => c.toUpperCase());
  return {
    title: title || "QORVYNA project",
    slug: slugify(titleSource) || "qorvyna-site",
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
