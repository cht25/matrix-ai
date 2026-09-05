"use client";

import { AGENT_STAGES, type AgentNodeState, type AgentStageId } from "@/lib/ai/pipeline";
import { cn } from "@/lib/utils";

export function AgentSandbox({
  activeStage,
  failed,
  tool,
}: {
  activeStage: AgentStageId | "complete" | null;
  failed?: boolean;
  tool?: string | null;
}) {
  const order = AGENT_STAGES.map((s) => s.id);
  const activeIdx = activeStage === "complete" ? order.length : activeStage ? order.indexOf(activeStage) : -1;

  function stateFor(i: number): AgentNodeState {
    if (failed && i === Math.max(activeIdx, 0)) return "failed";
    if (activeStage === "complete") return "completed";
    if (activeIdx < 0) return "queued";
    if (i < activeIdx) return "completed";
    if (i === activeIdx) return "running";
    return "waiting";
  }

  return (
    <div className="sandbox-graph rounded-xl border border-border bg-surface p-3">
      <p className="eyebrow mb-3">Agent sandbox</p>
      <ol className="grid gap-2">
        {AGENT_STAGES.map((stage, i) => {
          const state = stateFor(i);
          return (
            <li key={stage.id} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs", nodeClass(state))}>
              <span className={cn("h-2 w-2 rounded-full", dotClass(state))} />
              <span className="min-w-0 flex-1 font-medium">{stage.node}</span>
              <span className="font-mono text-[10px] uppercase tracking-wide text-ink-3">{state}</span>
            </li>
          );
        })}
      </ol>
      {tool ? <p className="mt-2 font-mono text-[11px] text-ink-3">Tool · {tool}</p> : null}
    </div>
  );
}

function nodeClass(state: AgentNodeState) {
  if (state === "running") return "border-[#8B5CF6]/40 bg-[#8B5CF6]/10";
  if (state === "completed") return "border-[#00FFA3]/35 bg-[#00FFA3]/8";
  if (state === "failed") return "border-danger/40 bg-danger-soft";
  return "border-border bg-surface-2 text-ink-3";
}

function dotClass(state: AgentNodeState) {
  if (state === "running") return "bg-[#8B5CF6] animate-pulse";
  if (state === "completed") return "bg-[#00FFA3]";
  if (state === "failed") return "bg-danger";
  return "bg-ink-3/40";
}
