"use client";

import { useMemo, useState } from "react";
import type { ChatMode, ExplainStyle, StudyLevel } from "@/lib/ai/modes";
import { parseStudyArtifacts } from "@/lib/ai/modes";
import { cn } from "@/lib/utils";

export type GraphNode = { id: string; title: string; status: "queued" | "running" | "completed" | "failed" };

export function ModeTools({
  mode,
  onPrompt,
  studyLevel,
  setStudyLevel,
  explainStyle,
  setExplainStyle,
}: {
  mode: ChatMode;
  onPrompt: (text: string) => void;
  studyLevel: StudyLevel;
  setStudyLevel: (v: StudyLevel) => void;
  explainStyle: ExplainStyle;
  setExplainStyle: (v: ExplainStyle) => void;
}) {
  if (mode === "study") {
    return (
      <div className="mb-3 rounded-xl border border-border bg-surface p-3">
        <p className="eyebrow mb-2">Study mode</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(["beginner", "school", "college", "university", "professional"] as StudyLevel[]).map((l) => (
            <button key={l} type="button" onClick={() => setStudyLevel(l)} className={cn("export-btn", studyLevel === l && "!border-accent !text-ink")}>{l}</button>
          ))}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(["simple", "detailed", "exam", "intuitive", "technical"] as ExplainStyle[]).map((s) => (
            <button key={s} type="button" onClick={() => setExplainStyle(s)} className={cn("export-btn", explainStyle === s && "!border-accent !text-ink")}>{s}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="export-btn" onClick={() => onPrompt("Explain the topic simply, then give one worked example.")}>Explain</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Quiz me with 5 mixed questions (MCQ, true/false, short answer). After each set, provide an answer key.")}>Quiz me</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Create 8 flashcards in this format:\nQ: ...\nA: ...")}>Flashcards</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Create a 7-day study plan with daily goals and revision checkpoints.")}>Study plan</button>
        </div>
      </div>
    );
  }
  if (mode === "health") {
    return (
      <div className="mb-3 rounded-xl border border-border bg-surface p-3">
        <p className="eyebrow mb-1">Health assistant</p>
        <p className="mb-2 text-[11px] text-ink-3">General information only — not a substitute for a clinician.</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="export-btn" onClick={() => onPrompt("Explain this symptom in general terms and what questions I should ask a clinician.")}>Explain a symptom</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Give general information about this medication: uses, common cautions, and what to ask a pharmacist or doctor. I am not asking you to prescribe.")}>Medication information</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Help me understand this report in plain language without diagnosing.")}>Understand a report</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Help me prepare a concise timeline and question list for a doctor visit.")}>Prepare for a visit</button>
        </div>
      </div>
    );
  }
  if (mode === "code") {
    return (
      <div className="mb-3 rounded-xl border border-border bg-surface p-3">
        <p className="mode-pill mb-2">Sandbox Active</p>
        <p className="mb-2 text-[11px] text-ink-3">Authorized project files only. MATRIX does not have unrestricted host access.</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="export-btn" onClick={() => onPrompt("Analyse the attached or pasted code: locate the root cause, propose a patch, and list tests I should run.")}>Analyse</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Refactor this code for readability and safety. Keep behaviour the same.")}>Refactor</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Write unit tests for the described function or module.")}>Tests</button>
        </div>
      </div>
    );
  }
  if (mode === "research") {
    return (
      <div className="mb-3 rounded-xl border border-border bg-surface p-3">
        <p className="eyebrow mb-2">Research desk</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="export-btn" onClick={() => onPrompt("Draft a research plan with questions, evidence needed, and uncertainties.")}>Plan</button>
          <button type="button" className="export-btn" onClick={() => onPrompt("Synthesize what is reasonably established vs inference vs uncertainty. Do not invent sources.")}>Synthesize</button>
        </div>
      </div>
    );
  }
  if (mode === "orchestrator") {
    return (
      <div className="mb-3 rounded-xl border border-border bg-surface p-3">
        <p className="eyebrow mb-1">Matrix Orchestrator</p>
        <p className="text-[12px] text-ink-2">One goal → study, code, research and visuals composed into a single workspace. Uses real model calls per subtask.</p>
      </div>
    );
  }
  return null;
}

export function FlashcardDeck({ text }: { text: string }) {
  const cards = useMemo(() => parseStudyArtifacts(text).flashcards, [text]);
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);
  if (!cards.length) return null;
  const card = cards[Math.min(i, cards.length - 1)];
  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-surface p-4">
      <p className="eyebrow mb-2">Flashcards · {i + 1}/{cards.length}</p>
      <button type="button" onClick={() => setFlip((v) => !v)} className="min-h-28 w-full rounded-lg border border-border bg-surface-2 p-4 text-left text-sm">
        {flip ? card.a : card.q}
      </button>
      <div className="mt-2 flex gap-2">
        <button type="button" className="export-btn" onClick={() => { setFlip(false); setI((n) => Math.max(0, n - 1)); }}>Prev</button>
        <button type="button" className="export-btn" onClick={() => setFlip((v) => !v)}>Flip</button>
        <button type="button" className="export-btn" onClick={() => { setFlip(false); setI((n) => Math.min(cards.length - 1, n + 1)); }}>Next</button>
      </div>
    </div>
  );
}

export function LiveTaskGraph({ nodes }: { nodes: GraphNode[] }) {
  if (!nodes.length) return null;
  return (
    <div className="mb-3 rounded-xl border border-border bg-surface p-3">
      <p className="eyebrow mb-2">Live task graph</p>
      <ul className="space-y-1.5 font-mono text-[12px]">
        {nodes.map((n) => (
          <li key={n.id} className="flex items-center gap-2">
            <span className={cn("w-3 text-center", n.status === "completed" && "text-[#00FFA3]", n.status === "running" && "text-[#8B5CF6]", n.status === "failed" && "text-danger", n.status === "queued" && "text-ink-3")}>
              {n.status === "completed" ? "✓" : n.status === "running" ? "●" : n.status === "failed" ? "✕" : "○"}
            </span>
            <span>{n.title}</span>
            <span className="ml-auto text-[10px] uppercase text-ink-3">{n.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
