"use client";

// =============================================================================
// Contextual mode tools (product spec §14, §24)
//
// A selected mode decides behaviour, not decoration. Mode tools render only
// when they are relevant to what is actually on screen:
//
//   Study    → Quiz / Flashcards / Study plan, once there is material to study
//   Code     → Analyse / Refactor / Tests, plus Workspace once files exist
//   Health   → guidance prompts once a health question was asked
//   Research → Sources only when the reply really contains sources
//   Agent    → execution controls only while/after a real agent run
//   General  → nothing
// =============================================================================

import { useMemo, useState } from "react";
import { ChevronDown, Layers, MonitorPlay } from "lucide-react";
import type { ChatMode, ExplainStyle, StudyLevel } from "@/lib/ai/modes";
import { parseStudyArtifacts } from "@/lib/ai/modes";
import type { ContentSignals } from "@/lib/ai/intent";
import { MenuItem, MenuLabel, Popover } from "@/components/popover";
import { cn } from "@/lib/utils";

export type GraphNode = { id: string; title: string; status: "queued" | "running" | "completed" | "failed" };

const CHIP =
  "chip inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent";

const STUDY_LEVELS: StudyLevel[] = ["beginner", "school", "college", "university", "professional"];
const EXPLAIN_STYLES: ExplainStyle[] = ["simple", "detailed", "exam", "intuitive", "technical"];

type Tool = { id: string; label: string; prompt?: string; onClick?: () => void };

export function ModeQuickActions({
  mode,
  signals,
  hasConversation,
  hasArtifacts,
  onPrompt,
  onOpenWorkspace,
  studyLevel,
  setStudyLevel,
  explainStyle,
  setExplainStyle,
  compact = false,
}: {
  mode: ChatMode;
  signals: ContentSignals | null;
  /** True once at least one assistant reply exists — tools need material. */
  hasConversation: boolean;
  hasArtifacts: boolean;
  onPrompt: (text: string) => void;
  onOpenWorkspace: () => void;
  studyLevel: StudyLevel;
  setStudyLevel: (value: StudyLevel) => void;
  explainStyle: ExplainStyle;
  setExplainStyle: (value: ExplainStyle) => void;
  compact?: boolean;
}) {
  const tools = useMemo<Tool[]>(() => {
    if (!hasConversation) return [];
    switch (mode) {
      case "study":
        return [
          { id: "explain", label: "Explain simply", prompt: "Explain the topic simply, then give one worked example." },
          { id: "quiz", label: "Quiz me", prompt: "Quiz me with 5 mixed questions (MCQ, true/false, short answer). After each set, provide an answer key." },
          { id: "flashcards", label: "Flashcards", prompt: "Create 8 flashcards in this format:\nQ: ...\nA: ..." },
          { id: "plan", label: "Study plan", prompt: "Create a 7-day study plan with daily goals and revision checkpoints." },
        ];
      case "code":
        return [
          { id: "analyse", label: "Analyse", prompt: "Analyse the code above: locate the root cause, propose a patch, and list the tests I should run." },
          { id: "refactor", label: "Refactor", prompt: "Refactor this code for readability and safety. Keep behaviour the same." },
          { id: "tests", label: "Write tests", prompt: "Write unit tests for the function or module above." },
        ];
      case "health":
        return [
          { id: "symptom", label: "Explain a symptom", prompt: "Explain this symptom in general terms and what questions I should ask a clinician." },
          { id: "medication", label: "Medication info", prompt: "Give general information about this medication: uses, common cautions, and what to ask a pharmacist or doctor. I am not asking you to prescribe." },
          { id: "visit", label: "Prepare for a visit", prompt: "Help me prepare a concise timeline and question list for a doctor visit." },
        ];
      case "research":
        // Sources appear only when research was actually performed.
        return signals?.hasSources
          ? [{ id: "sources", label: "List sources", prompt: "List the sources and evidence behind the answer above, and mark anything you could not verify." }]
          : [];
      default:
        return [];
    }
  }, [mode, hasConversation, signals?.hasSources]);

  const visible = compact ? tools.slice(0, 2) : tools.slice(0, 4);
  const hidden = compact ? tools.slice(2) : [];
  // Agent mode already exposes the workspace in the top bar and on the reply
  // itself, so the chip is only added for Code mode.
  const showWorkspace = hasArtifacts && mode === "code";

  if (!visible.length && !hidden.length && !showWorkspace && mode !== "study") return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {visible.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={CHIP}
          onClick={() => (tool.prompt ? onPrompt(tool.prompt) : tool.onClick?.())}
        >
          {tool.label}
        </button>
      ))}
      {hidden.length ? (
        <Popover
          label="More mode tools"
          align="left"
          trigger={({ toggle, open, aria }) => (
            <button type="button" className={CHIP} onClick={toggle} {...aria}>
              More
              <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        >
          {({ close }) => (
            <>
              {hidden.map((tool) => (
                <MenuItem
                  key={tool.id}
                  onClick={() => {
                    close();
                    if (tool.prompt) onPrompt(tool.prompt);
                    else tool.onClick?.();
                  }}
                >
                  {tool.label}
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      ) : null}

      {showWorkspace ? (
        <button type="button" className={cn(CHIP, "!border-accent/40 !text-accent")} onClick={onOpenWorkspace}>
          <MonitorPlay size={12} aria-hidden="true" /> Workspace
        </button>
      ) : null}

      {mode === "study" ? (
        <Popover
          label="Study preferences"
          align="left"
          panelClassName="w-56"
          trigger={({ toggle, open, aria }) => (
            <button type="button" className={CHIP} onClick={toggle} {...aria}>
              <Layers size={12} aria-hidden="true" />
              {studyLevel} · {explainStyle}
              <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuLabel>Level</MenuLabel>
              {STUDY_LEVELS.map((level) => (
                <MenuItem
                  key={level}
                  active={studyLevel === level}
                  onClick={() => {
                    setStudyLevel(level);
                    close();
                  }}
                >
                  {level}
                </MenuItem>
              ))}
              <MenuLabel>Explanation style</MenuLabel>
              {EXPLAIN_STYLES.map((style) => (
                <MenuItem
                  key={style}
                  active={explainStyle === style}
                  onClick={() => {
                    setExplainStyle(style);
                    close();
                  }}
                >
                  {style}
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

/** Flashcards exist only when the reply really contains them — and stay folded. */
export function FlashcardDeck({ text }: { text: string }) {
  const cards = useMemo(() => parseStudyArtifacts(text).flashcards, [text]);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [flip, setFlip] = useState(false);
  if (!cards.length) return null;
  const card = cards[Math.min(index, cards.length - 1)];

  return (
    <div className="mt-2 max-w-xl">
      <button type="button" className={CHIP} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        Flashcards · {cards.length}
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mt-2 rounded-xl border border-border bg-surface p-3">
          <p className="eyebrow mb-2">Flashcard {index + 1} of {cards.length}</p>
          <button
            type="button"
            onClick={() => setFlip((value) => !value)}
            className="min-h-24 w-full rounded-lg border border-border bg-surface-2 p-3.5 text-left text-[13.5px] leading-relaxed text-ink"
          >
            {flip ? card.a : card.q}
          </button>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={CHIP} onClick={() => { setFlip(false); setIndex((n) => Math.max(0, n - 1)); }}>Previous</button>
            <button type="button" className={CHIP} onClick={() => setFlip((value) => !value)}>{flip ? "Show question" : "Show answer"}</button>
            <button type="button" className={CHIP} onClick={() => { setFlip(false); setIndex((n) => Math.min(cards.length - 1, n + 1)); }}>Next</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Orchestrator/demo task graph — rendered only while there are real nodes. */
export function LiveTaskGraph({ nodes }: { nodes: GraphNode[] }) {
  if (!nodes.length) return null;
  return (
    <div className="mb-2 rounded-xl border border-border bg-surface px-3 py-2">
      <p className="eyebrow mb-1.5">Task progress</p>
      <ul className="grid gap-1 font-mono text-[11.5px]">
        {nodes.map((node) => (
          <li key={node.id} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "w-3 text-center",
                node.status === "completed" && "text-success",
                node.status === "running" && "text-accent",
                node.status === "failed" && "text-danger",
                node.status === "queued" && "text-ink-3",
              )}
            >
              {node.status === "completed" ? "✓" : node.status === "running" ? "●" : node.status === "failed" ? "✕" : "○"}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{node.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
