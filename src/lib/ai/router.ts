import { isCodingRequest, type TextAttachment } from "@/lib/ai/agent";
import type { ChatMode, ModelLane, ResponseStrategy } from "@/lib/ai/modes";

export type WorkloadTier = "high" | "low";

export type RouteDecision = {
  mode: ChatMode;
  lane: ModelLane;
  tier: WorkloadTier;
  coding: boolean;
  vision: boolean;
  image: boolean;
  reason: string;
};

const WEB_DEV_OR_HIGH_LOAD_RE =
  /\b(website|web\s*app|webapp|landing\s*page|frontend|front-end|backend|back-end|fullstack|full-stack|next\.?js|react|vue|svelte|angular|tailwind|html5?|css3?|sass|javascript|typescript|node\.?js|express|fastapi|django|flask|rest\s*api|graphql|database|postgres|mysql|sqlite|mongodb|firestore|supabase|prisma|docker|kubernetes|microservice|architecture|system\s*design|security\s*audit|threat\s*model|vulnerability|refactor|debug|stack\s*trace|benchmark|algorithm|data\s*structure|compile|bundle|deploy|ui\/ux|dashboard|responsive\s*layout|state\s*machine|concurrency|distributed\s*system)\b/i;

/**
 * Classifies whether a request belongs on the high-end GLM tier (coding, web
 * development, architecture, deep reasoning, attachments, or heavy multi-part
 * workloads) vs. a lightweight response strategy; both use the same GLM default.
 */
export function isHighLoadRequest(message: string, attachments: TextAttachment[] = []): boolean {
  if (attachments.length > 0) return true;
  if (isCodingRequest(message, attachments)) return true;
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (WEB_DEV_OR_HIGH_LOAD_RE.test(trimmed)) return true;
  if (/```[\s\S]{16,}/.test(trimmed)) return true;
  if (trimmed.length >= 420) return true;
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length >= 8 && trimmed.length >= 240) return true;
  return false;
}

export function decideRoute(opts: {
  mode: ChatMode;
  message: string;
  attachments?: TextAttachment[];
  lane?: ModelLane;
  strategy?: ResponseStrategy;
}): RouteDecision {
  const { mode, message, attachments = [], lane = "auto", strategy = "balanced" } = opts;
  if (mode === "image" || lane === "image") {
    return { mode: "image", lane: "image", tier: "high", coding: false, vision: false, image: true, reason: "GLM image generation lane" };
  }
  if (lane === "vision") {
    return { mode, lane: "vision", tier: "high", coding: false, vision: true, image: false, reason: "GLM vision lane" };
  }
  if (lane === "coding" || mode === "code" || mode === "agent") {
    return { mode, lane: "coding", tier: "high", coding: true, vision: false, image: false, reason: "GLM coding & web-dev engine" };
  }
  if (lane === "fast" || strategy === "fast" || strategy === "efficient") {
    const coding = isCodingRequest(message, attachments);
    if (coding) {
      return { mode, lane: "coding", tier: "high", coding: true, vision: false, image: false, reason: "GLM coding override" };
    }
    return { mode, lane: "fast", tier: "low", coding: false, vision: false, image: false, reason: "GLM-5-Turbo fast response strategy" };
  }
  if (lane === "reasoning" || strategy === "quality" || mode === "study" || mode === "research" || mode === "orchestrator") {
    return {
      mode,
      lane: "reasoning",
      tier: "high",
      coding: mode === "orchestrator" ? isCodingRequest(message, attachments) : false,
      vision: false,
      image: false,
      reason: "GLM high-end reasoning & orchestration",
    };
  }
  if (lane === "balanced") {
    const coding = isCodingRequest(message, attachments) || WEB_DEV_OR_HIGH_LOAD_RE.test(message);
    const highLoad = coding || isHighLoadRequest(message, attachments);
    return {
      mode,
      lane: coding ? "coding" : "balanced",
      tier: highLoad ? "high" : "low",
      coding,
      vision: false,
      image: false,
      reason: highLoad ? "GLM high-load / web-dev tier" : "GLM-5-Turbo balanced response strategy",
    };
  }
  // auto
  const coding = isCodingRequest(message, attachments) || WEB_DEV_OR_HIGH_LOAD_RE.test(message);
  const vision = attachments.some((f) => (f.type ?? "").startsWith("image/"));
  const highLoad = coding || vision || isHighLoadRequest(message, attachments);
  return {
    mode,
    lane: coding ? "coding" : vision ? "vision" : "auto",
    tier: highLoad ? "high" : "low",
    coding,
    vision,
    image: false,
    reason: coding
      ? "Auto: GLM coding & web-dev tier"
      : vision
        ? "Auto: GLM multimodal vision"
        : highLoad
          ? "Auto: GLM high-load system"
          : "Auto: GLM-5-Turbo",
  };
}

/** Split an orchestrator goal into real subtasks (heuristic — no fake LLM plan). */
export function planOrchestrator(goal: string): Array<{ id: string; mode: ChatMode; title: string; prompt: string }> {
  const g = goal.trim();
  const tasks: Array<{ id: string; mode: ChatMode; title: string; prompt: string }> = [];
  const wantsStudy = /\b(study|exam|learn|quiz|flashcard|explain|topic|physics|math|revision)\b/i.test(g);
  const wantsCode = /\b(python|code|implement|program|example|script|react|function|website|html|css|app)\b/i.test(g);
  const wantsImage = /\b(image|visual|diagram|illustration|poster|infographic)\b/i.test(g);
  const wantsResearch = /\b(research|sources|cite|evidence|literature)\b/i.test(g);
  if (wantsStudy || (!wantsCode && !wantsImage)) {
    tasks.push({ id: "study", mode: "study", title: "Study plan & explanation", prompt: `As a tutor, address this goal with a study plan, explanations of difficult points, and practice questions.\n\nGoal: ${g}` });
  }
  if (wantsResearch) {
    tasks.push({ id: "research", mode: "research", title: "Research synthesis", prompt: `Produce a structured research brief with verified vs inferred vs uncertain sections.\n\nGoal: ${g}` });
  }
  if (wantsCode) {
    tasks.push({ id: "code", mode: "code", title: "Code example", prompt: `Provide a complete, runnable example that supports this learning/work goal.\n\nGoal: ${g}` });
  }
  if (wantsImage) {
    tasks.push({ id: "image", mode: "image", title: "Visual material", prompt: `Educational visual: ${g.slice(0, 400)}` });
  }
  if (tasks.length === 0) {
    tasks.push({ id: "general", mode: "general", title: "Unified response", prompt: g });
  }
  return tasks.slice(0, 4);
}
