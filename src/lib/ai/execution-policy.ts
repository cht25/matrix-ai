import type { ChatMode } from "@/lib/ai/modes";
import { isChatMode } from "@/lib/ai/modes";
import { BN_PROJECT_TARGET, BN_PUBLISH, isBanglaText, type BuildIntent } from "@/lib/ai/build-intent";
import { hasFileProtocol, isCodingRequest, type TextAttachment } from "@/lib/ai/agent";

/** Execution authority is explicit for every request. A stored Agent mode is
 * context, never permission to execute a later unspecified request. */
export function requestChatMode(requested: unknown, temporary = false): ChatMode {
  if (temporary) return "general";
  return isChatMode(requested) && requested !== "image" ? requested : "general";
}

export function mayExecuteAgent(mode: ChatMode, intent: BuildIntent): boolean {
  return (mode === "agent" || mode === "code") && !intent.needsClarification && (intent.build || intent.publish || intent.preview || intent.fix === true);
}

/** In explicit Code mode, implementation requests go to a persisted workspace,
 * while explanations/questions remain normal chat. */
export function shouldCreateCodeWorkspace(input: string, attachments: TextAttachment[] = []): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/^(?:what|why|how|when|where|which|explain|describe|teach|help me understand|can you (?:explain|tell|describe|show me how)|could you (?:explain|show me how)|show me how|tell me how)\b/i.test(text)) return false;
  const action = /\b(?:write|create|build|make|implement|generate|fix|debug|refactor|add|edit|update|scaffold|code|test|need|want)\b/i.test(text);
  const codeObject = /\b(?:code|function|class|script|program|algorithm|component|module|query|api|app|application|website|web ?app|site|bug|software|programming)\b/i.test(text);
  return attachments.length > 0 || (action && (isCodingRequest(text) || codeObject));
}

export function isAgentSourceReply(mode: ChatMode, content: string): boolean {
  return mode === "agent" && (hasFileProtocol(content) || /^\s*(?:<!doctype html|<html[\s>]|<div[\s>]|<svg[\s>])/im.test(content));
}

// =============================================================================
// Execution hand-off — doing versus describing.
//
// The failure this exists to prevent: a request to DO something ("update my
// project", "deploy it") being answered with a sentence that sounds like the
// work happened. Every message therefore ends up on exactly one of four paths
// (the order below is the order `send()` in chat-client.tsx applies them):
//
//   clarify   real work that is missing its subject — one question.
//   execute   Agent / Code mode: the real pipeline runs now (/api/build). Files
//             are written, validated and built, and the result is whatever
//             those steps reported.
//   approval  the request is real project work, but it was made in a
//             conversation mode, which never changes files on its own.
//             Nothing runs and nothing is claimed: the user is asked for one
//             tap (`agentHandoffReason` below decides this).
//   chat      a question or a writing task: answered in the conversation.
//
// The server applies the same detector: /api/ai refuses to answer executable
// Agent work with words (409 AGENT_RUNTIME_REQUIRED → the browser runs it), and
// tells the model plainly when a turn is a chat answer about project work.
//
// Pure and deterministic — unit tested in tests/execution-routing.test.ts.
// =============================================================================

export type HandoffReason = "publish" | "project" | "build";

/**
 * "Build me a <site/app>": a build verb whose OBJECT is something the Agent
 * can actually create. The words between the verb and the object may not
 * turn it into a writing task ("create a blog post about my website"), and the
 * object may not be the subject of one ("generate website copy").
 */
const NOT_THE_OBJECT = String.raw`about|for|of|on|to|with|in|from|that|which|and|post|article|essay|email|story|poem|plan|list|summary|description|review|logo|name|outline|proposal|report|letter|pitch`;
const BUILDABLE = String.raw`website|web\s?site|web\s?app|webpage|web\s?page|landing\s+page|homepage|home\s+page|portfolio|online\s+(?:store|shop)|e-?commerce\s+(?:site|store|website)|dashboard|app|application|game|store|shop|blog`;
const NOT_A_BUILD = String.raw`copy|content|text|ideas?|names?|description|outline|plan|proposal|strategy|mock-?ups?|wireframes?|examples?|inspiration|tips|checklist|keywords|title|tagline|slogan|logo|sign|icon|banner|posts?|articles?|review|policy|email|ads?|listing|idea|concept|pitch|store\s+listing`;
const BUILD_OBJECT = new RegExp(
  String.raw`\b(?:build|make|create|generate|develop|design|code|scaffold|set\s+up|spin\s+up|launch)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|my|our|this|that)\s+)?(?:(?!(?:${NOT_THE_OBJECT})\b)[\w'-]+\s+){0,4}?(?:${BUILDABLE})\b(?!\s+(?:${NOT_A_BUILD})\b)`,
  "i",
);
/**
 * The user's own software, named as the thing to change: "my website", "the
 * backend", "this feature". The noun must be the head of its phrase, so "add a
 * feature comparison table to my essay" is not a match.
 */
const SOFTWARE_SUBJECT = new RegExp(
  String.raw`\b(?:my|our|the|this|that|a|an|new|another|some)\s+(?:[\w'’-]+\s+){0,2}?(?:project|website|web\s?site|site|app|application|web\s?app|platform|code-?base|repo(?:sitory)?|back-?end|front-?end|landing\s+page|dashboard|store|shop|portfolio|api|endpoint|database|server|deployment|ui|user\s+interface|design|layout|theme|navbar|navigation\s+bar|feature|functionality|component)s?(?=[\s.,!?;:]*$|[.,!?;:]|\s+(?:to|for|in|on|of|that|which|where|so|and|but|with|from|by|using|please|now|into|across|everywhere)\b)`,
  "i",
);
/** A publish verb whose object is a project — not "launch a marketing campaign". */
const PUBLISH_OBJECT = new RegExp(
  String.raw`\b(?:publish|re-?publish|deploy|re-?deploy|host)\s+(?:it|this|that|them|(?:my|our|the|this|that)\s+(?:[\w'’-]+\s+){0,2}?(?:project|website|web\s?site|site|app|application|web\s?app|platform|landing\s+page|dashboard|store|shop|portfolio|page|game|blog|build|changes|update|version))\b` +
  String.raw`|\b(?:go|put\s+(?:it|this|that)|make\s+(?:it|this|that))\s+(?:live|online|public)\b` +
  String.raw`|\b(?:ship|launch)\s+(?:it|this|(?:my|our|the)\s+(?:project|website|web\s?site|site|app|web\s?app))\b`,
  "i",
);
/**
 * "Deploy it" / "please publish this": the two verbs that only ever mean
 * putting a project online, as an instruction, aimed at a pronoun. Kept this
 * narrow on purpose — "ship it" and "make it public" are everyday speech.
 */
const PUBLISH_PRONOUN = /^(?:(?:please|pls|now|ok(?:ay)?|and|then|so|just|can\s+you|could\s+you|go\s+ahead\s+and)[\s,]+)*(?:re-?)?(?:deploy|publish)\s+(?:it|this|that|them)\b/i;
const SOFTWARE_NOUN = /\b(?:project|website|web\s?site|site|app|application|web\s?app|platform|code-?base|repo(?:sitory)?|back-?end|front-?end|landing\s+page|dashboard|store|shop|portfolio)\b/i;
const BUILDABLE_NOUN = new RegExp(String.raw`\b(?:${BUILDABLE})\b`, "i");
/** Pasted code or markup: the user wants help with what is in the message. */
const INLINE_MATERIAL = /```|<\/?[a-z][\w-]*(?:\s[^>]*)?>|^\s{4,}\S.*[;{}]\s*$/im;

/** Modes that answer in the conversation and never write project files. */
export function isConversationMode(mode: ChatMode): boolean {
  return mode !== "agent" && mode !== "code" && mode !== "image" && mode !== "orchestrator";
}

function runnable(intent: BuildIntent): boolean {
  return !intent.needsClarification && (intent.build || intent.publish || intent.preview || intent.fix === true);
}

/**
 * In a conversation mode: is this message work that only the Agent can do?
 * Deliberately narrow — "write a blog post", "make a resume" and "fix this
 * function" (with the code pasted) are ordinary chat and stay there.
 */
export function agentHandoffReason(
  input: string,
  intent: BuildIntent,
  context: { hasProject?: boolean; hasAttachments?: boolean } = {},
): HandoffReason | null {
  const text = input.trim();
  if (!text) return null;
  // Material supplied inline is a request to work on that material here.
  if (context.hasAttachments || INLINE_MATERIAL.test(text) || text.length > 1200) return null;
  // "Deploy it" with no project in the conversation. The detector wants to know
  // which project — and the Agent run asks that with the user's real projects to
  // choose from, then publishes. A chat reply could only ask in prose and leave
  // the user to switch modes and say it all again.
  if (intent.needsClarification && PUBLISH_PRONOUN.test(text)) return "publish";
  if (!runnable(intent)) return null;
  // In Bangla / Banglish the verb comes last ("website ta update koro"), so the
  // English word-order patterns do not apply: naming the thing is enough.
  const bangla = isBanglaText(text);
  // Publishing cannot be done with words at all — and it is the consequence
  // the user must see named, even when the same message also asks for a change.
  if (intent.publish && (context.hasProject || PUBLISH_OBJECT.test(text) || BN_PUBLISH.test(text))) return "publish";
  // The conversation already owns a project: a request for work is about it.
  if (context.hasProject) return "project";
  const change = intent.modify === true || intent.fix;
  if (change && (SOFTWARE_SUBJECT.test(text) || BN_PROJECT_TARGET.test(text) || (bangla && SOFTWARE_NOUN.test(text)))) return "project";
  if (intent.build && !change && (BUILD_OBJECT.test(text) || BN_PROJECT_TARGET.test(text) || (bangla && BUILDABLE_NOUN.test(text)))) return "build";
  return null;
}

/**
 * The intent an approved hand-off runs with. "Deploy it" was parked without a
 * project to point at; approving it is the user saying "yes, publish", and the
 * run then resolves the project or asks which one.
 */
export function approvedIntent(intent: BuildIntent, reason: HandoffReason): BuildIntent {
  if (reason === "publish" && intent.needsClarification) {
    return { ...intent, publish: true, needsClarification: false, clarification: null };
  }
  return intent;
}

/** What the approval prompt says. One sentence each, no promises. */
export function handoffCopy(reason: HandoffReason): { title: string; detail: string; action: string } {
  if (reason === "publish") {
    return {
      title: "Publish this with the Agent?",
      detail: "Publishing puts real files on a public address, so it runs as an Agent task and waits for your go-ahead. Nothing has been published yet.",
      action: "Publish with Agent",
    };
  }
  if (reason === "project") {
    return {
      title: "Apply this change with the Agent?",
      detail: "This changes real project files. The Agent will edit them, validate and build the result, and report exactly what happened. Nothing has been changed yet.",
      action: "Run with Agent",
    };
  }
  return {
    title: "Build this for real with the Agent?",
    detail: "The Agent creates an actual project: it writes the files, validates and builds them, and gives you a preview. Nothing has been built yet.",
    action: "Build with Agent",
  };
}

// -----------------------------------------------------------------------------
// Unbacked action claims
//
// A conversation reply never writes files, builds or deploys — only a pipeline
// run does, and a run leaves a record on its message. So when a plain reply
// SAYS the work was done ("I've updated your project", "your site is now live
// at …"), the statement has nothing behind it. The interface labels such a
// reply instead of trusting the model not to write one.
// -----------------------------------------------------------------------------
const ACTION_WORDS = String.raw`updated|changed|modified|edited|deployed|redeployed|published|built|rebuilt|created|added|removed|deleted|fixed|applied|pushed|committed|installed|configured|redesigned|rebranded|renamed|replaced|launched|implemented|refactored|migrated|set\s+up|saved|uploaded`;
const WORK_OBJECT = String.raw`project|site|website|web\s?app|app|application|platform|repository|repo|codebase|deployment|server|database|back-?end|front-?end|files?|changes|branch|workspace`;
const ACTIVE_CLAIM = new RegExp(
  String.raw`\bI(?:['’]ve|\s+have)?(?:\s+(?:just|now|already|successfully|gone\s+ahead\s+and|went\s+ahead\s+and))*\s+(?:${ACTION_WORDS})\b[^.!?\n]{0,100}?\b(?:your|the|this)\s+(?:[\w-]+\s+){0,3}(?:${WORK_OBJECT})\b`,
  "i",
);
const PASSIVE_CLAIM = new RegExp(
  String.raw`\b(?:your|the)\s+(?:[\w-]+\s+){0,3}(?:${WORK_OBJECT}|update|build)\s+(?:has|have)\s+been\s+(?:successfully\s+)?(?:${ACTION_WORDS})\b|\b(?:is|are)\s+now\s+live\s+at\b|\b(?:has|have)\s+been\s+(?:successfully\s+)?(?:deployed|published|pushed)\s+to\b`,
  "i",
);

/**
 * Does this reply state that project work was carried out? Returns the
 * sentence that makes the claim, or null. Code blocks are ignored: a comment
 * inside generated code is not the assistant speaking.
 */
export function unbackedActionClaim(reply: string): string | null {
  const prose = String(reply ?? "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const match = ACTIVE_CLAIM.exec(prose) ?? PASSIVE_CLAIM.exec(prose);
  if (!match) return null;
  // Stating that nothing was done is the opposite of a claim.
  const start = Math.max(0, prose.lastIndexOf("\n", match.index), prose.slice(0, match.index).search(/[.!?][^.!?]*$/) + 1);
  const sentence = prose.slice(start, match.index + match[0].length).replace(/\s+/g, " ").trim();
  if (/\b(?:have\s*n[o']t|haven['’]t|did\s*n[o']t|didn['’]t|cannot|can['’]t|could\s*n[o']t|not\s+(?:yet|actually|been)|no\s+files?|nothing|unable\s+to|won['’]t)\b/i.test(sentence)) return null;
  return sentence.slice(0, 200);
}
