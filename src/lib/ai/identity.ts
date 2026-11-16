// =============================================================================
// QORVYNA AI identity — who the assistant is, and what it runs on.
//
// Two different questions, answered from two different sources:
//
//   "Who are you?"            → the PRODUCT identity. The assistant is
//                               QORVYNA AI in every mode. The wording comes
//                               from src/lib/brand.ts.
//   "Which model / provider?" → the TECHNICAL truth. Built at request time from
//                               the real routing for that request (the model
//                               that will answer, the other models in the
//                               user's pool, the hosting provider) — the same
//                               objects the gateway sends requests to. Nothing
//                               here is typed by hand.
//
// The identity reaches the model as a block appended to EVERY system prompt
// (general, each mode, Agent, the build pipeline). Because an open-weight model
// may still answer the two most common probes from its own training ("I'm
// ChatGPT…"), the unambiguous standalone questions are also answered directly
// from this module without asking the model at all — see `identityQuestion`.
//
// Pure: no network, no storage. Unit tested in tests/ai-identity.test.ts.
// =============================================================================

import { BRAND, BRAND_PILLARS } from "@/lib/brand";
import { QORVYNA_MODEL_ID, QORVYNA_MODEL_LABEL, QORVYNA_MODEL_PROVIDER, QORVYNA_MODEL_PUBLISHER } from "@/lib/ai/model";
import { modelById } from "@/lib/ai/models/registry";

/** One model as the user should hear about it. */
export type RoutedModel = {
  /** Provider model ID, exactly as requests name it. */
  id: string;
  label: string;
  /** Who published the weights. Null when the registry does not know. */
  publisher: string | null;
  /** The service the request is sent to. */
  provider: string;
};

/** The models a request can be answered by — first is the one that answers. */
export type ModelRouting = {
  primary: RoutedModel;
  /** Other enabled, available models (collaboration and takeover). */
  others: RoutedModel[];
};

// What works today comes from the brand's own pillar list, with its honest
// status: an area marked `planned` is never described as something the
// assistant can do in this product now.
const AREA_WORDS: Record<(typeof BRAND_PILLARS)[number]["id"], { en: string; bn: string }> = {
  ai: { en: "AI", bn: "AI" },
  agents: { en: "AI agents", bn: "AI এজেন্ট" },
  iot: { en: "IoT and connected devices", bn: "IoT ও সংযুক্ত ডিভাইস" },
  automation: { en: "automation", bn: "অটোমেশন" },
  cloud: { en: "cloud services", bn: "ক্লাউড সেবা" },
  developers: { en: "developer tools", bn: "ডেভেলপার টুল" },
  robotics: { en: "robotics", bn: "রোবোটিক্স" },
};

function areas(status: "live" | "planned", language: "en" | "bn"): string[] {
  return BRAND_PILLARS.filter((pillar) => pillar.status === status).map((pillar) => AREA_WORDS[pillar.id][language]);
}

function listWords(values: string[], conjunction = "and"): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} ${conjunction} ${values[values.length - 1]}`;
}

/**
 * The canonical self-description. This sentence is the brand's own wording and
 * is used verbatim: it names what the QORVYNA ecosystem is about, robotics
 * included. Which of those areas works in this product today is a separate
 * fact, taken from the pillar list (`PLANNED_AREAS`), and the system prompt
 * tells the assistant to say so when asked.
 */
export const IDENTITY_STATEMENT =
  `I'm ${BRAND.aiName}, the intelligent assistant of the ${BRAND.name} technology ecosystem. ` +
  "I help users build, develop, automate, connect, and manage technology through AI, IoT, robotics, cloud services, and software tools.";

export const IDENTITY_STATEMENT_BN =
  `আমি ${BRAND.aiName} — ${BRAND.name} প্রযুক্তি ইকোসিস্টেমের বুদ্ধিমান সহকারী। ` +
  "AI, IoT, রোবোটিক্স, ক্লাউড সেবা ও সফটওয়্যার টুলের মাধ্যমে প্রযুক্তি তৈরি, উন্নয়ন, স্বয়ংক্রিয়করণ, সংযোগ ও পরিচালনায় আমি ব্যবহারকারীদের সাহায্য করি।";

/** Areas on the roadmap that are not available yet (never claimed as working). */
export const PLANNED_AREAS = areas("planned", "en");

/** The dedicated OpenAI-compatible endpoint a deployment may configure instead of the hosted provider. */
const DEDICATED_PROVIDER_ID = "gpt-oss";
const DEDICATED_PROVIDER = "a dedicated OpenAI-compatible endpoint configured by this deployment's operator";

/**
 * Describe a model as it is actually reached. `provider` / `providerId` come
 * from the gateway's own route — the service the request is sent to — so a
 * deployment on a dedicated endpoint is never described as the hosted one.
 */
export function describeModel(id: string, provider: string = QORVYNA_MODEL_PROVIDER, providerId?: string | null): RoutedModel {
  const spec = modelById(id);
  return {
    id,
    label: spec?.label ?? id,
    publisher: spec?.publisher ?? null,
    provider: providerId === DEDICATED_PROVIDER_ID ? DEDICATED_PROVIDER : provider.trim() || QORVYNA_MODEL_PROVIDER,
  };
}

/** The deployment's configured default — used when no per-request routing is known. */
export function defaultRouting(): ModelRouting {
  return {
    primary: { id: QORVYNA_MODEL_ID, label: QORVYNA_MODEL_LABEL, publisher: QORVYNA_MODEL_PUBLISHER, provider: QORVYNA_MODEL_PROVIDER },
    others: [],
  };
}

/** Routing from the gateway's own targets (coordinator first). */
export function routingFromTargets(targets: ReadonlyArray<{ model: string; provider: string; providerId?: string | null }>): ModelRouting {
  if (!targets.length) return defaultRouting();
  const seen = new Set<string>();
  const models: RoutedModel[] = [];
  for (const target of targets) {
    if (seen.has(target.model)) continue;
    seen.add(target.model);
    models.push(describeModel(target.model, target.provider, target.providerId));
  }
  return { primary: models[0], others: models.slice(1) };
}

function modelPhrase(model: RoutedModel): string {
  return `${model.label} (${model.id})${model.publisher ? `, an open-weight model published by ${model.publisher}` : ""}`;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Plain facts about the routing, shared by the system prompt and the direct
 * answers. Worded about the assistant ("answers in this conversation") so the
 * same sentences are true in both places, in chat and inside a build run.
 */
export function modelFacts(routing: ModelRouting, voice: "assistant" | "first-person" = "assistant"): string[] {
  const { primary, others } = routing;
  const mine = voice === "first-person";
  if (!others.length) {
    return [
      `${mine ? "My" : `${BRAND.aiName}'s`} answers in this conversation are generated by ${modelPhrase(primary)}, served by ${primary.provider}.`,
      `${BRAND.name} is the product you are using; it did not create the underlying model.`,
    ];
  }
  const providers = unique([primary, ...others].map((model) => model.provider));
  return [
    `${mine ? "My lead model" : `The lead model for ${BRAND.aiName}`} in this conversation is ${modelPhrase(primary)}, served by ${primary.provider}.`,
    `${BRAND.name} can also route work to ${listWords(others.map((model) => `${model.label}${model.publisher ? ` (published by ${model.publisher})` : ""}`))}${providers.length === 1 ? `, served by ${providers[0]} as well` : `, served by ${listWords(providers)}`}. They may contribute working notes, review the work, or take over if the lead model is unavailable.`,
    `${BRAND.name} is the product you are using; it did not create these models.`,
  ];
}

/**
 * The identity block appended to every system prompt. `routing` is the real
 * routing for the request; without it the deployment default is described.
 */
export function identityPrompt(routing: ModelRouting = defaultRouting()): string {
  const vendors = unique([routing.primary, ...routing.others].flatMap((model) => [model.publisher, model.provider]));
  return [
    "## Identity",
    `- You are ${BRAND.aiName}, the intelligent assistant of the ${BRAND.name} technology ecosystem. ${BRAND.name} is operated by ${BRAND.operator}.`,
    `- Working in this product today: ${listWords(areas("live", "en"))}.`,
    ...(PLANNED_AREAS.length ? [`- Planned, not available yet: ${listWords(PLANNED_AREAS)}. Your introduction names ${PLANNED_AREAS.length === 1 ? "it" : "them"} because ${PLANNED_AREAS.length === 1 ? "it is" : "they are"} part of what the ecosystem is about, not because ${PLANNED_AREAS.length === 1 ? "it works" : "they work"} here. If the user asks what you can do in a planned area, say it is not available yet; never describe a planned area as a working feature.`] : []),
    `- Your name is ${BRAND.aiName} in every mode and every language. When asked who or what you are, answer in the user's language with this meaning: "${IDENTITY_STATEMENT}"`,
    `- Never introduce yourself as ChatGPT, as an assistant made by ${listWords(vendors, "or")}, or by the name of the underlying model. Do not bring up the underlying model unless the user asks about it.`,
    `- ${BRAND.name} was formerly named ${BRAND.formerName}. Never call yourself ${BRAND.formerName}; mention the former name only if the user asks about it.`,
    `- The name ${BRAND.name} stands for "${BRAND.concept}". That is a brand name, not a scientific claim: never say quantum computing is involved.`,
    `- Do not invent ${BRAND.name} features, prices, hardware or services. If you are not sure something exists in the product, say so.`,
    "",
    "## Model transparency",
    "If the user explicitly asks which model, LLM, AI provider or company's technology powers you, answer truthfully and specifically using only the facts below. Do not refuse, deflect or guess.",
    ...modelFacts(routing).map((fact) => `- ${fact}`),
    "- You have no verified facts about training data, parameter counts, version history or knowledge cut-off dates. If asked, say you do not know rather than guessing.",
  ].join("\n");
}

/** Append the identity block to the first system message of a prompt. */
export function withIdentity<T extends { role: string; content: string }>(messages: T[], routing?: ModelRouting): T[] {
  const index = messages.findIndex((message) => message.role === "system");
  if (index < 0) return messages;
  return messages.map((message, i) => (i === index ? { ...message, content: `${message.content}\n\n${identityPrompt(routing)}` } : message));
}

// -----------------------------------------------------------------------------
// Direct answers to unambiguous identity questions
// -----------------------------------------------------------------------------

export type IdentityQuestion = "who" | "model" | "maker" | "former" | "other-assistant";

const GREETING = /^(?:(?:hi|hello|hey|hola|yo|ok(?:ay)?|so|well|and|please|excuse\s+me|assalamu\s+alaikum|salam|হাই|হ্যালো|আচ্ছা)[\s,!.]+)+/i;

const WHO = [
  /^(?:who|what)\s+(?:are|r)\s+(?:you|u)(?:\s+exactly)?$/i,
  /^(?:what(?:'s|\s+is)|tell\s+me|say)\s+your\s+name$/i,
  /^your\s+name$/i,
  /^(?:please\s+)?introduce\s+yourself$/i,
  /^tell\s+me\s+(?:about|who)\s+(?:yourself|you\s+are)$/i,
  /^(?:who|what)\s+is\s+qorvyna(?:\s+ai)?$/i,
  /^are\s+you\s+qorvyna(?:\s+ai)?$/i,
  /^(?:তুমি|আপনি|তুই)\s+কে$/,
  /^(?:তোমার|আপনার)\s+(?:নাম|পরিচয়)\s+(?:কি|কী)$/,
  /^(?:tumi|apni)\s+ke$/i,
  /^(?:tomar|apnar)\s+na+m\s+ki$/i,
];

const MODEL = [
  /^(?:which|what)\s+(?:ai\s+|language\s+|large\s+language\s+)?(?:model|llm)\s+(?:are\s+you(?:\s+(?:using|running(?:\s+on)?|based\s+on|built\s+on|powered\s+by))?|do\s+you\s+(?:use|run\s+on)|is\s+this|powers\s+you|is\s+(?:behind|powering)\s+you)$/i,
  /^(?:what(?:'s|\s+is)|which\s+is)\s+your\s+(?:underlying\s+|base\s+|ai\s+|language\s+)?(?:model|llm)$/i,
  /^(?:which|what)\s+(?:ai\s+)?(?:provider|company|api)\s+(?:do\s+you\s+use|are\s+you\s+using|powers\s+you|is\s+(?:behind|powering)\s+you)$/i,
  /^who\s+is\s+your\s+(?:model\s+|ai\s+)?provider$/i,
  /^(?:what|which)\s+(?:are\s+you|is\s+this)\s+(?:powered\s+by|based\s+on|built\s+on|running\s+on)$/i,
  /^what\s+(?:powers|runs)\s+you$/i,
  /^(?:তুমি|আপনি)\s+কোন\s+(?:এআই\s+|ai\s+)?মডেল(?:\s+(?:ব্যবহার\s+(?:করো|কর|করেন)|এ\s+চলো))?$/i,
  /^(?:tumi|apni)\s+kon\s+model(?:\s+use\s+koro)?$/i,
];

const MAKER = [
  /^who\s+(?:made|created|built|developed|trained|owns|makes|programmed|designed)\s+you$/i,
  /^who\s+is\s+your\s+(?:creator|developer|maker|owner|author)$/i,
  /^who\s+(?:are\s+you|were\s+you)\s+(?:made|created|built|developed|trained)\s+by$/i,
  /^(?:তোমাকে|আপনাকে)\s+কে\s+(?:বানিয়েছে|তৈরি\s+করেছে|বানাইছে)$/,
  /^(?:tomake|apnake)\s+ke\s+(?:baniyeche|toiri\s+koreche)$/i,
];

const FORMER = [/^are\s+you\s+(?:the\s+)?matrix(?:\s+ai)?$/i, /^(?:is\s+this|what\s+happened\s+to)\s+matrix(?:\s+ai)?$/i];

const OTHER_ASSISTANT = [
  /^are\s+you\s+(?:really\s+|actually\s+|just\s+)?(?:chat\s?gpt|gpt|open\s?ai|an?\s+open\s?ai\s+(?:model|product|assistant)|llama|qwen|groq|meta\s+ai)$/i,
  /^(?:is\s+this|so\s+you\s+are)\s+chat\s?gpt$/i,
];

/**
 * Is this message ONLY an identity question? Strict on purpose: "who are you
 * to judge?" and "who are you, and can you fix my code?" return null and go to
 * the model (which still carries the identity block).
 */
export function identityQuestion(message: string): IdentityQuestion | null {
  const text = String(message ?? "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(GREETING, "")
    .replace(/[\s?!.।,:;]+$/g, "")
    .trim();
  if (!text || text.length > 80) return null;
  if (FORMER.some((pattern) => pattern.test(text))) return "former";
  if (OTHER_ASSISTANT.some((pattern) => pattern.test(text))) return "other-assistant";
  if (MODEL.some((pattern) => pattern.test(text))) return "model";
  if (MAKER.some((pattern) => pattern.test(text))) return "maker";
  if (WHO.some((pattern) => pattern.test(text))) return "who";
  return null;
}

/** The direct answer, in English or Bangla, built from the real routing. */
export function identityAnswer(kind: IdentityQuestion, routing: ModelRouting = defaultRouting(), language: "en" | "bn" = "en"): string {
  const { primary, others } = routing;
  const several = others.length > 0;
  if (language === "bn") {
    const model = `${primary.label} (${primary.id})${primary.publisher ? ` — ${primary.publisher}-এর প্রকাশিত একটি ওপেন-ওয়েট ভাষা মডেল` : ""}`;
    const served = primary.provider === QORVYNA_MODEL_PROVIDER ? `${primary.provider}-এর সেবার মাধ্যমে` : "এই ডিপ্লয়মেন্টের অপারেটরের নির্ধারিত একটি ডেডিকেটেড এন্ডপয়েন্টের মাধ্যমে";
    const pool = several ? ` প্রয়োজনে ${BRAND.name} আরও কিছু মডেলে কাজ পাঠাতে পারে: ${others.map((item) => item.label).join(", ")}।` : "";
    const notMade = `${BRAND.name} হলো আপনার ব্যবহৃত পণ্যটি; ${several ? "এই মডেলগুলো" : "মূল মডেলটি"} ${BRAND.name}-এর তৈরি নয়।`;
    const powered = `এই কথোপকথনে আমার উত্তর তৈরি করে ${model}, যা চলে ${served}।${pool} ${notMade}`;
    if (kind === "who") return IDENTITY_STATEMENT_BN;
    if (kind === "former") return `${BRAND.name} হলো সেই প্ল্যাটফর্মের নতুন নাম, যার আগের নাম ছিল ${BRAND.formerName}। আমি ${BRAND.aiName}। আপনার অ্যাকাউন্ট, চ্যাট ও প্রজেক্ট আগের মতোই আছে।`;
    if (kind === "maker") return `আমি ${BRAND.aiName} — ${BRAND.name} প্ল্যাটফর্মের সহকারী, যা পরিচালনা করে ${BRAND.operator}। ${powered}`;
    if (kind === "other-assistant") return `না — আমি ${BRAND.aiName}। ${powered}`;
    return `আমি ${BRAND.aiName}। ${powered}`;
  }
  const facts = modelFacts(routing, "first-person").join(" ");
  if (kind === "who") return IDENTITY_STATEMENT;
  if (kind === "former") {
    return `${BRAND.name} is the new name of the platform that used to be called ${BRAND.formerName}. I'm ${BRAND.aiName}. Your account, chats and projects are unchanged.`;
  }
  if (kind === "maker") {
    return `I'm ${BRAND.aiName}, the assistant of the ${BRAND.name} platform, which is operated by ${BRAND.operator}. ${facts}`;
  }
  if (kind === "other-assistant") return `No — I'm ${BRAND.aiName}. ${facts}`;
  return `I'm ${BRAND.aiName}. ${facts}`;
}

/**
 * Did the user set up a character for the assistant to play? Then "what's your
 * name?" belongs to the story, and the model answers it (still carrying the
 * identity block, so a sincere question gets the real answer).
 */
export function personaInPlay(history: ReadonlyArray<{ role: string; content: string }>): boolean {
  const setup = /\b(?:role-?play(?:ing)?|pretend(?:ing)?|act\s+(?:as|like)|play\s+the\s+(?:role|part)\s+of|you\s+are\s+now|from\s+now\s+on,?\s+you(?:'re|\s+are)|imagine\s+(?:that\s+)?you(?:'re|\s+are)|stay\s+in\s+character|in\s+character|your\s+name\s+is|you(?:'re|\s+are)\s+(?:called|named))\b|অভিনয়|ভান\s+কর|চরিত্র/i;
  return history.slice(-12).some((message) => message.role === "user" && setup.test(message.content.replace(/[’‘]/g, "'")));
}

/** Which language a direct identity answer should use. */
export function identityLanguage(message: string, preferred?: "en" | "bn"): "en" | "bn" {
  if (/[\u0980-\u09ff]/.test(message)) return "bn";
  if (/\b(?:tumi|apni|tomar|apnar|tomake|apnake)\b/i.test(message)) return "bn";
  return preferred === "bn" && !/[a-z]{3,}/i.test(message) ? "bn" : "en";
}
