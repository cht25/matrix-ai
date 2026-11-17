"use client";

// =============================================================================
// System assistant panel — the controls for the REAL floating assistant
//
// Two hosts, one panel:
//
//   DESKTOP (Windows/macOS/Linux)
//     Ctrl+Shift+Space toggles a frameless always-on-top popup that loads the
//     same bundled frontend. This panel can open it explicitly and says so.
//
//   ANDROID
//     The bubble, the ASSIST role and the on-device wake phrase. Every control
//     reads the state the Kotlin service reports and offers the exact system
//     page needed to grant it — nothing here pretends a permission is granted.
//
// The wake phrase is enrolled by recording it (default twice). Enrolment is
// what turns "Hey QORVYNA" on; deleting the samples switches it off again.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleSlash, Loader2, Mic, Settings2, SquareArrowOutUpRight } from "lucide-react";
import {
  assistantState,
  clearWakeWordSamples,
  enrolWakeWordSample,
  isNativeShell,
  openAssistantSettings,
  requestPermission,
  setWakeWordEnabled,
  showAssistantPopup,
  toggleAssistantPopup,
  type AssistantState,
} from "@/native/native-bridge";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

type Busy = "none" | "enroll" | "clear" | "popup" | "toggle" | "wake";

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ok ? "bg-accent-soft text-accent-strong" : "bg-surface-3 text-ink-3",
      )}
    >
      {ok ? <CheckCircle2 size={11} /> : <CircleSlash size={11} />}
      {label}
    </span>
  );
}

export function NativeAssistantPanel() {
  const native = isNativeShell();
  const [state, setState] = useState<AssistantState | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Busy>("none");

  const refresh = useCallback(async () => {
    if (!native) return;
    const next = await assistantState();
    if (next) setState(next);
  }, [native]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!native) {
    return (
      <div className="rounded-xl border border-border bg-surface-2/60 p-3 text-xs text-ink-2">
        The floating assistant needs the installed app. In a browser, use Push-to-talk or the
        Speak shortcut — the wake phrase is only listened for by the desktop and Android builds.
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 p-3 text-xs text-ink-2">
        <Loader2 size={14} className="animate-spin" /> Reading the assistant state from this device…
      </div>
    );
  }

  const android = state.platform === "android";

  const run = async (kind: Busy, action: () => Promise<unknown>, fallbackError: string) => {
    setBusy(kind);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setBusy("none");
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-surface-2/60 p-3">
        <p className="text-xs text-ink-2">{state.note}</p>
        {detail ? <p className="mt-1 text-xs text-ink-3">{detail}</p> : null}
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </div>

      {android ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-ink">Floating bubble</p>
                <p className="text-xs text-ink-3">
                  Sits over other apps. Needs “Display over other apps”.
                </p>
              </div>
              <StatusPill ok={state.overlaySupported} label={state.overlaySupported ? "granted" : "not granted"} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                className="!min-h-8 !px-3 !text-xs"
                disabled={busy !== "none"}
                onClick={() =>
                  void run(
                    "popup",
                    async () => {
                      if (!state.overlaySupported) {
                        const result = await openAssistantSettings("overlay");
                        setDetail(result?.detail ?? "");
                        return;
                      }
                      await showAssistantPopup();
                      setDetail("Bubble shown. Drag it anywhere; tap it to start a turn.");
                    },
                    "Could not open the overlay settings.",
                  )
                }
              >
                <SquareArrowOutUpRight size={13} />
                {state.overlaySupported ? "Show bubble" : "Allow over other apps"}
              </Button>
              <Button
                variant="secondary"
                className="!min-h-8 !px-3 !text-xs"
                disabled={busy !== "none"}
                onClick={() =>
                  void run(
                    "toggle",
                    async () => {
                      const shown = await toggleAssistantPopup();
                      setDetail(shown ? "Bubble is running." : "Bubble stopped.");
                    },
                    "Could not toggle the bubble.",
                  )
                }
              >
                Hide / show
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-ink">Wake phrase “Hey QORVYNA”</p>
                <p className="text-xs text-ink-3">
                  On-device only: record the phrase {state.wakeRequired}× — {state.wakeSamples}/
                  {state.wakeRequired} saved on this phone. Audio never leaves the device.
                </p>
              </div>
              <StatusPill
                ok={state.wakeWordSupported}
                label={state.wakeWordSupported ? "ready" : "not enrolled"}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                className="!min-h-8 !px-3 !text-xs"
                disabled={busy !== "none"}
                onClick={() =>
                  void run(
                    "enroll",
                    async () => {
                      // The recorder needs the runtime grant; ask before it opens.
                      await requestPermission("microphone").catch(() => null);
                      setDetail("Recording 3 seconds — say “Hey QORVYNA” clearly.");
                      const result = await enrolWakeWordSample();
                      setDetail(result?.detail ?? "");
                    },
                    "Could not record the wake phrase.",
                  )
                }
              >
                {busy === "enroll" ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                Record phrase
              </Button>
              {state.wakeSamples > 0 ? (
                <Button
                  variant="secondary"
                  className="!min-h-8 !px-3 !text-xs"
                  disabled={busy !== "none"}
                  onClick={() =>
                    void run(
                      "clear",
                      async () => {
                        const result = await clearWakeWordSamples();
                        setDetail(result?.detail ?? "Wake-phrase samples deleted.");
                      },
                      "Could not delete the wake-phrase samples.",
                    )
                  }
                >
                  Forget phrase
                </Button>
              ) : null}
              <label className="flex items-center gap-2 px-1 text-xs text-ink-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-accent"
                  checked={state.wakeWordEnabled && state.wakeWordSupported}
                  disabled={!state.wakeWordSupported || busy !== "none"}
                  onChange={(event) =>
                    void run(
                      "wake",
                      async () => {
                        const next = await setWakeWordEnabled(event.target.checked);
                        if (next) setState(next);
                      },
                      "Could not change the wake-phrase setting.",
                    )
                  }
                />
                Listen in the background
              </label>
            </div>
          </div>

          <div className="rounded-xl border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-ink">Digital assistant role</p>
                <p className="text-xs text-ink-3">
                  Makes the system gesture (long-press home / power button) open QORVYNA.
                </p>
              </div>
              <StatusPill
                ok={state.defaultAssistant}
                label={state.defaultAssistant ? "active" : "not set"}
              />
            </div>
            <Button
              variant="secondary"
              className="mt-2 !min-h-8 !px-3 !text-xs"
              disabled={busy !== "none"}
              onClick={() =>
                void run(
                  "popup",
                  async () => {
                    const result = await openAssistantSettings("assistant");
                    setDetail(result?.detail ?? "");
                  },
                  "Could not open the assistant settings.",
                )
              }
            >
              <Settings2 size={13} /> Choose QORVYNA
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border p-3">
          <p className="font-medium text-ink">Floating assistant</p>
          <p className="text-xs text-ink-3">
            Ctrl+Shift+Space opens the always-on-top popup over any app; Esc closes it. It runs on
            the same account and the same conversation as this window.
          </p>
          <Button
            className="mt-2 !min-h-8 !px-3 !text-xs"
            disabled={busy !== "none"}
            onClick={() =>
              void run(
                "popup",
                async () => {
                  await showAssistantPopup();
                  setDetail("Floating assistant opened.");
                },
                "Could not open the floating assistant.",
              )
            }
          >
            <SquareArrowOutUpRight size={13} /> Open floating assistant
          </Button>
        </div>
      )}
    </div>
  );
}
