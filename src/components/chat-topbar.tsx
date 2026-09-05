"use client";

// =============================================================================
// Chat top bar (product spec §13, §25)
//
// Only two primary controls stay visible — what the conversation IS and which
// model lane it uses — plus a quiet readiness dot. Everything else (response
// strategy, auto-read, demo mode, routing detail, Agent workspace) lives in
// [Settings ▾] so the bar never becomes a wall of controls.
//
//   [Mode ▾] [Model ▾]                                   ● Ready   [Settings ▾]
// =============================================================================

import { FlaskConical, MonitorPlay, Settings2, SlidersHorizontal, Volume2 } from "lucide-react";
import { MATRIX_MODES, MODEL_LANES, type ChatMode, type ModelLane, type ResponseStrategy } from "@/lib/ai/modes";
import { MenuItem, MenuLabel, MenuSeparator, Popover } from "@/components/popover";
import { cn } from "@/lib/utils";
const SELECT =
  "inline-flex h-9 min-w-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-transparent bg-transparent px-2 text-[12.5px] font-medium text-ink transition-colors hover:border-border hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";

export function ChatTopBar({
  mode,
  onModeChange,
  lane,
  onLaneChange,
  strategy,
  onStrategyChange,
  streaming,
  locked,
  autoSpeak,
  onToggleAutoSpeak,
  demoMode,
  onToggleDemo,
  routingLabel,
  workspaceCount,
  onOpenWorkspace,
  autoSpeakLabels,
}: {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  lane: ModelLane;
  onLaneChange: (lane: ModelLane) => void;
  strategy: ResponseStrategy;
  onStrategyChange: (strategy: ResponseStrategy) => void;
  streaming: boolean;
  /** Temporary chats cannot switch mode. */
  locked?: boolean;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  demoMode: boolean;
  onToggleDemo: () => void;
  routingLabel: string | null;
  workspaceCount: number;
  onOpenWorkspace: () => void;
  autoSpeakLabels: { on: string; off: string };
}) {
  const strategies: Array<{ id: ResponseStrategy; label: string }> = [
    { id: "fast", label: "Fast" },
    { id: "balanced", label: "Balanced" },
    { id: "quality", label: "Quality" },
    { id: "efficient", label: "Efficient" },
  ];

  return (
    <div className="chat-topbar mb-2 flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border py-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <label className="sr-only" htmlFor="matrix-mode">Matrix mode</label>
        <select
          id="matrix-mode"
          value={mode}
          disabled={streaming || locked}
          onChange={(event) => onModeChange(event.target.value as ChatMode)}
          className={cn(SELECT, "max-w-40 font-semibold")}
        >
          {MATRIX_MODES.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="matrix-lane">Model</label>
        <select
          id="matrix-lane"
          value={lane}
          disabled={streaming}
          onChange={(event) => onLaneChange(event.target.value as ModelLane)}
          className={cn(SELECT, "max-w-32 text-ink-2")}
        >
          {MODEL_LANES.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* The Agent workspace button is contextual: it appears only once an
            Agent run actually produced files. */}
        {workspaceCount > 0 ? (
          <button
            type="button"
            onClick={onOpenWorkspace}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
          >
            <MonitorPlay size={13} aria-hidden="true" />
            <span className="hidden sm:inline">Workspace</span>
            <span className="font-mono text-[10.5px]">{workspaceCount}</span>
          </button>
        ) : null}

        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-ink-2"
        >
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", streaming ? "bg-accent pulse-dot" : "bg-success")} />
          {streaming ? "Working" : "Ready"}
        </span>

        <Popover
          label="Chat settings"
          panelClassName="w-60"
          trigger={({ toggle, open, aria }) => (
            <button
              type="button"
              onClick={toggle}
              title="Settings"
              aria-label="Chat settings"
              className={cn(
                "grid h-9 w-9 place-items-center rounded-[10px] border transition-colors",
                open ? "border-border bg-surface-2 text-ink" : "border-transparent text-ink-3 hover:border-border hover:bg-surface-2 hover:text-ink",
              )}
              {...aria}
            >
              <Settings2 size={15} strokeWidth={1.8} />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuLabel>Response strategy</MenuLabel>
              {strategies.map((item) => (
                <MenuItem
                  key={item.id}
                  icon={<SlidersHorizontal size={13} strokeWidth={1.7} />}
                  active={strategy === item.id}
                  onClick={() => {
                    onStrategyChange(item.id);
                    close();
                  }}
                >
                  {item.label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuLabel>Session</MenuLabel>
              <MenuItem
                icon={<Volume2 size={13} strokeWidth={1.7} />}
                active={autoSpeak}
                onClick={() => {
                  onToggleAutoSpeak();
                  close();
                }}
              >
                {autoSpeak ? autoSpeakLabels.on : autoSpeakLabels.off}
              </MenuItem>
              <MenuItem
                icon={<FlaskConical size={13} strokeWidth={1.7} />}
                active={demoMode}
                onClick={() => {
                  onToggleDemo();
                  close();
                }}
              >
                Demo mode {demoMode ? "on" : "off"}
              </MenuItem>
              {routingLabel ? (
                <>
                  <MenuSeparator />
                  <p className="px-2.5 pb-1.5 pt-1 font-mono text-[10px] leading-relaxed text-ink-3">
                    Routing · {routingLabel}
                    <br />
                    Set in Admin → AI configuration.
                  </p>
                </>
              ) : null}
            </>
          )}
        </Popover>
      </div>
    </div>
  );
}
