import { isCodingRequest, type TextAttachment } from "@/lib/ai/agent";
import type { ChatMode, ModelLane, ResponseStrategy } from "@/lib/ai/modes";

export type RouteDecision = {
  mode: ChatMode;
  lane: ModelLane;
  coding: boolean;
  vision: boolean;
  image: boolean;
  reason: string;
};

export function decideRoute(opts: {
  mode: ChatMode;
  message: string;
  attachments?: TextAttachment[];
  lane?: ModelLane;
  strategy?: ResponseStrategy;
}): RouteDecision {
  const { mode, message, attachments = [], lane = "auto", strategy = "balanced" } = opts;
  if (mode === "image" || lane === "image") {
    return { mode: "image", lane: "image", coding: false, vision: false, image: true, reason: "Image generation lane" };
  }
  if (lane === "vision") {
    return { mode, lane: "vision", coding: false, vision: true, image: false, reason: "Vision lane override" };
  }
  if (lane === "coding" || mode === "code" || mode === "agent") {
    return { mode, lane: mode === "agent" ? "coding" : "coding", coding: true, vision: false, image: false, reason: "Coding / Agent capability" };
  }
  if (lane === "fast" || strategy === "fast" || strategy === "efficient") {
    return { mode, lane: "fast", coding: false, vision: false, image: false, reason: "Fast / efficient strategy" };
  }
  if (lane === "reasoning" || strategy === "quality" || mode === "research" || mode === "orchestrator") {
    return { mode, lane: "reasoning", coding: mode === "orchestrator" ? isCodingRequest(message, attachments) : false, vision: false, image: false, reason: "Reasoning / quality strategy" };
  }
  if (lane === "balanced") {
    const coding = isCodingRequest(message, attachments);
    return { mode, lane: coding ? "coding" : "balanced", coding, vision: false, image: false, reason: "Balanced with auto coding detect" };
  }
  // auto
  const coding = isCodingRequest(message, attachments);
  const vision = attachments.some((f) => (f.type ?? "").startsWith("image/"));
  return {
    mode,
    lane: coding ? "coding" : vision ? "vision" : "auto",
    coding,
    vision,
    image: false,
    reason: coding ? "Auto: coding intent" : vision ? "Auto: image attachment" : "Auto: general chat",
  };
}

/** Split an orchestrator goal into real subtasks (heuristic — no fake LLM plan). */
export function planOrchestrator(goal: string): Array<{ id: string; mode: ChatMode; title: string; prompt: string }> {
  const g = goal.trim();
  const tasks: Array<{ id: string; mode: ChatMode; title: string; prompt: string }> = [];
  const wantsStudy = /\b(study|exam|learn|quiz|flashcard|explain|topic|physics|math|revision)\b/i.test(g);
  const wantsCode = /\b(python|code|implement|program|example|script|react|function)\b/i.test(g);
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
