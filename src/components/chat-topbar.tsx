"use client";

// =============================================================================
// Chat toolbar (product spec §13, §25) — one compact row that never wraps,
// shared by Chat and Agent:
//
//   [ Chat | Agent ]  [Models ▾]    conversation title    ● Idle   [⚙]
//
//   · Chat | Agent     switches mode INSIDE the same conversation.
//   · Models           the only model control. The bar never prints a
//                      technical model name; those live inside the selector.
//   · ● Idle/Working   what QORVYNA is doing right now.
//   · ⚙ Chat settings  everything secondary: chat style, response strategy,
//                      response display, voice language, read-aloud, demo
//                      mode and the conversation's own actions.
//
// On a phone the title and the status word step aside (the dot stays) so the
// four controls always fit on one line down to 320px.
// =============================================================================

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Archive, ChevronLeft, ChevronRight, Download, EyeOff, FlaskConical, Languages, MessageSquareText, Mic, MonitorPlay, Pencil,
  Settings2, SlidersHorizontal, Trash2, Type, Volume2, VolumeX,
} from "lucide-react";
import { QORVYNA_MODES, type ChatMode, type ResponseStrategy } from "@/lib/ai/modes";
import { MenuItem, MenuLabel, MenuSeparator, Popover } from "@/components/popover";
import { ConfirmModal, Modal } from "@/components/modal";
import { ModelSelector } from "@/components/model-picker";
import { VOICE_LANGUAGES, voiceLanguage, type VoiceInputMode } from "@/lib/voice-input";
import type { RevealMode } from "@/lib/stream-reveal";
import { cn } from "@/lib/utils";

export type ToolbarStatus = "idle" | "working" | "recording";

const STRATEGIES: Array<{ id: ResponseStrategy; label: string; hint: string }> = [
  { id: "fast", label: "Fast", hint: "Shorter, quicker answers" },
  { id: "balanced", label: "Balanced", hint: "The default" },
  { id: "quality", label: "Quality", hint: "More careful and complete" },
  { id: "efficient", label: "Efficient", hint: "Uses fewer tokens" },
];

const REVEAL_MODES: Array<{ id: RevealMode; label: string; hint: string }> = [
  { id: "adaptive", label: "Adaptive typing", hint: "Smooth, keeps up with the answer" },
  { id: "word", label: "Word by word", hint: "Steady reading pace" },
  { id: "natural", label: "Natural stream", hint: "Shows text as it arrives" },
  { id: "reduced", label: "Reduced motion", hint: "Fewer, larger updates" },
];

/** Chat styles: every mode except Agent, which has its own tab. */
const CHAT_STYLES = QORVYNA_MODES.filter((item) => item.id !== "agent");

const STATUS: Record<ToolbarStatus, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-ink-3" },
  working: { label: "Working", dot: "bg-accent pulse-dot" },
  recording: { label: "Recording", dot: "bg-danger pulse-dot" },
};

type SettingsView = "main" | "style" | "strategy" | "display" | "voice";

export type ConversationActions = {
  title: string;
  onRename: (title: string) => Promise<void> | void;
  onExport: () => void;
  onArchive: () => void;
  onDelete: () => Promise<void> | void;
};

export function ChatTopBar({
  mode,
  onModeChange,
  strategy,
  onStrategyChange,
  revealMode,
  onRevealModeChange,
  voiceLang,
  onVoiceLangChange,
  voiceMode,
  onVoiceModeChange,
  status,
  locked,
  autoSpeak,
  onToggleAutoSpeak,
  demoMode,
  onToggleDemo,
  workspaceCount,
  onOpenWorkspace,
  autoSpeakLabels,
  conversation,
}: {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  strategy: ResponseStrategy;
  onStrategyChange: (strategy: ResponseStrategy) => void;
  revealMode: RevealMode;
  onRevealModeChange: (mode: RevealMode) => void;
  voiceLang: string;
  onVoiceLangChange: (code: string) => void;
  voiceMode?: VoiceInputMode;
  onVoiceModeChange?: (mode: VoiceInputMode) => void;
  status: ToolbarStatus;
  /** Temporary chats stay in Chat mode and are never saved. */
  locked?: boolean;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  demoMode: boolean;
  onToggleDemo: () => void;
  workspaceCount: number;
  onOpenWorkspace: () => void;
  autoSpeakLabels: { on: string; off: string };
  /** Present once the conversation is saved: title plus its own actions. */
  conversation?: ConversationActions | null;
}) {
  const [view, setView] = useState<SettingsView>("main");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // The settings menu always opens on its first page.
  useEffect(() => { if (!settingsOpen) setView("main"); }, [settingsOpen]);

  const busy = status !== "idle";
  const agent = mode === "agent";
  const state = STATUS[status];
  const style = CHAT_STYLES.find((item) => item.id === mode) ?? CHAT_STYLES[0];
  const strategyLabel = STRATEGIES.find((item) => item.id === strategy)?.label ?? "Balanced";
  const revealLabel = REVEAL_MODES.find((item) => item.id === revealMode)?.label ?? "Adaptive typing";
  const voice = voiceLanguage(voiceLang);

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    const next = renameValue.trim();
    if (!conversation || !next || renameBusy) return;
    setRenameBusy(true);
    try { await conversation.onRename(next); setRenaming(false); }
    finally { setRenameBusy(false); }
  }

  /** A settings row that opens a second page instead of growing the menu. */
  const drill = (target: SettingsView, icon: ReactNode, label: string, value: string) => (
    <MenuItem icon={icon} onClick={() => setView(target)} description={value}>
      <span className="flex items-center justify-between gap-2">{label}<ChevronRight size={14} className="shrink-0 text-ink-3" aria-hidden="true" /></span>
    </MenuItem>
  );
  const back = (label: string) => (
    <>
      <MenuItem icon={<ChevronLeft size={15} />} onClick={() => setView("main")}>{label}</MenuItem>
      <MenuSeparator />
    </>
  );

  return (
    <div className="chat-toolbar" role="toolbar" aria-label="Chat controls">
      <div className="flex min-w-0 items-center gap-1 sm:gap-1.5">
        {locked ? (
          <span className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-border bg-surface-2 px-2.5 text-[13px] font-semibold text-ink" title="Nothing in this chat is saved">
            <EyeOff size={14} aria-hidden="true" /> Temporary
          </span>
        ) : (
          <div className="mode-switch" role="radiogroup" aria-label="QORVYNA mode">
            <button
              type="button"
              role="radio"
              aria-checked={!agent}
              disabled={busy}
              onClick={() => { if (agent) onModeChange("general"); }}
              title="Chat — ask, learn, write and plan"
            >
              Chat
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={agent}
              disabled={busy}
              onClick={() => { if (!agent) onModeChange("agent"); }}
              title="Agent — build, preview and publish projects"
            >
              Agent
            </button>
          </div>
        )}
        <ModelSelector disabled={status === "recording"} />
        {conversation?.title ? (
          <p className="ml-1 hidden min-w-0 truncate text-[13px] text-ink-3 md:block" title={conversation.title}>{conversation.title}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {/* Contextual: appears only once an Agent run actually produced files. */}
        {workspaceCount > 0 ? (
          <button
            type="button"
            onClick={onOpenWorkspace}
            aria-label={`Open workspace, ${workspaceCount} file${workspaceCount === 1 ? "" : "s"}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border px-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <MonitorPlay size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Workspace</span>
            <span className="font-mono text-[11px] tabular-nums">{workspaceCount}</span>
          </button>
        ) : null}

        <span role="status" aria-live="polite" title={state.label} className="inline-flex h-9 items-center gap-1.5 px-1.5 text-[12px] font-medium text-ink-2 sm:px-2">
          <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", state.dot)} />
          <span className="sr-only sm:not-sr-only">{state.label}</span>
        </span>

        <Popover
          label="Chat settings"
          sheetTitle="Chat settings"
          panelClassName="w-72"
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          viewKey={view}
          trigger={({ toggle, open, aria }) => (
            <button
              type="button"
              onClick={toggle}
              title="Chat settings"
              aria-label="Chat settings"
              className={cn(
                "grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border transition-colors",
                open ? "border-border bg-surface-2 text-ink" : "border-transparent text-ink-2 hover:border-border hover:bg-surface-2 hover:text-ink",
              )}
              {...aria}
            >
              <Settings2 size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
        >
          {({ close }) => {
            if (view === "style") {
              return (
                <>
                  {back("Chat style")}
                  {CHAT_STYLES.map((item) => (
                    <MenuItem key={item.id} checked={!agent && mode === item.id} description={item.hint} onClick={() => { onModeChange(item.id); close(); }}>
                      {item.label}
                    </MenuItem>
                  ))}
                </>
              );
            }
            if (view === "strategy") {
              return (
                <>
                  {back("Response strategy")}
                  {STRATEGIES.map((item) => (
                    <MenuItem key={item.id} checked={strategy === item.id} description={item.hint} onClick={() => { onStrategyChange(item.id); close(); }}>
                      {item.label}
                    </MenuItem>
                  ))}
                </>
              );
            }
            if (view === "display") {
              return (
                <>
                  {back("Response display")}
                  {REVEAL_MODES.map((item) => (
                    <MenuItem key={item.id} checked={revealMode === item.id} description={item.hint} onClick={() => { onRevealModeChange(item.id); close(); }}>
                      {item.label}
                    </MenuItem>
                  ))}
                </>
              );
            }
            if (view === "voice") {
              return (
                <>
                  {back("Voice language")}
                  {VOICE_LANGUAGES.map((item) => (
                    <MenuItem key={item.code} checked={voice.code === item.code} description={item.code === "auto" ? "Detects Bangla, English and more" : item.native} onClick={() => { onVoiceLangChange(item.code); close(); }}>
                      {item.code === "auto" ? "Auto-detect" : item.label}
                    </MenuItem>
                  ))}
                </>
              );
            }
            return (
              <>
                {conversation ? (
                  <>
                    <MenuLabel>Conversation</MenuLabel>
                    <p className="truncate px-2.5 pb-1 text-[12.5px] text-ink-2 md:hidden" title={conversation.title}>{conversation.title}</p>
                    <MenuItem icon={<Pencil size={15} />} onClick={() => { close(); setRenameValue(conversation.title); setRenaming(true); }}>Rename</MenuItem>
                    <MenuItem icon={<Download size={15} />} onClick={() => { close(); conversation.onExport(); }}>Export JSON</MenuItem>
                    <MenuItem icon={<Archive size={15} />} onClick={() => { close(); conversation.onArchive(); }}>Archive</MenuItem>
                    <MenuItem icon={<Trash2 size={15} />} danger onClick={() => { close(); setConfirmDelete(true); }}>Delete conversation</MenuItem>
                    <MenuSeparator />
                  </>
                ) : null}
                <MenuLabel>Responses</MenuLabel>
                {!locked && !agent ? drill("style", <MessageSquareText size={15} />, "Chat style", style.label) : null}
                {drill("strategy", <SlidersHorizontal size={15} />, "Response strategy", strategyLabel)}
                {drill("display", <Type size={15} />, "Response display", revealLabel)}
                <MenuSeparator />
                <MenuLabel>Voice</MenuLabel>
                {drill("voice", <Languages size={15} />, "Voice language", voice.code === "auto" ? "Auto-detect" : voice.label)}
                {onVoiceModeChange ? (
                  <MenuItem
                    icon={<Mic size={15} />}
                    checked={voiceMode === "hands_free"}
                    description={voiceMode === "hands_free" ? "Auto-sends voice turns after pause" : "Dictate words into composer first"}
                    onClick={() => { onVoiceModeChange(voiceMode === "hands_free" ? "dictate" : "hands_free"); close(); }}
                  >
                    Hands-free voice mode
                  </MenuItem>
                ) : null}
                {!agent ? (
                  <MenuItem icon={autoSpeak ? <Volume2 size={15} /> : <VolumeX size={15} />} checked={autoSpeak} onClick={() => { onToggleAutoSpeak(); close(); }}>
                    {autoSpeak ? autoSpeakLabels.on : autoSpeakLabels.off}
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem icon={<FlaskConical size={15} />} checked={demoMode} description="Shows execution detail for every reply" onClick={() => { onToggleDemo(); close(); }}>
                  Demo mode {demoMode ? "on" : "off"}
                </MenuItem>
              </>
            );
          }}
        </Popover>
      </div>

      {conversation ? (
        <>
          <Modal open={renaming} onClose={() => setRenaming(false)} title="Rename conversation" size="sm">
            <form onSubmit={(event) => void submitRename(event)} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-ink-2">Title</span>
                <input
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  maxLength={120}
                  autoComplete="off"
                  className="input-base w-full"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setRenaming(false)} className="min-h-10 rounded-lg px-3.5 text-sm font-medium text-ink-2 hover:bg-surface-2">Cancel</button>
                <button type="submit" disabled={!renameValue.trim() || renameBusy} className="min-h-10 rounded-lg bg-accent-solid px-4 text-sm font-semibold text-accent-ink hover:bg-accent-solid-hover disabled:opacity-50">
                  {renameBusy ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          </Modal>
          <ConfirmModal
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => {
              setDeleteBusy(true);
              void Promise.resolve(conversation.onDelete()).finally(() => { setDeleteBusy(false); setConfirmDelete(false); });
            }}
            title="Delete this conversation?"
            body="The conversation and its messages are removed from your history. This can't be undone."
            confirmLabel="Delete"
            busy={deleteBusy}
          />
        </>
      ) : null}
    </div>
  );
}
