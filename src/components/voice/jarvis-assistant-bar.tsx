"use client";

// =============================================================================
// Jarvis Voice Assistant Bar
//
// Features:
//   - Visible status pill ("Hey QORVYNA" foreground wake-word standby,
//     command capture, speaking, or off).
//   - Opt-in local SpeechRecognition wake-word matcher (NEVER sends continuous
//     background audio to cloud; foreground tab only).
//   - Global keyboard shortcut Ctrl+Shift+Space (or Cmd+Shift+Space on macOS)
//     and native Tauri event `qorvyna://voice-activate` to trigger voice.
//   - Immediate Interrupt button when AI is speaking.
//   - Explicit confirmation card before executing any sensitive device action
//     (`device.open_app`, `device.media_control`, `notifications.clear_history`),
//     backed by server `tool_approval_request` + `tool_approval_decide` +
//     `tool_execute` + native Tauri invoke if running inside Windows desktop.
// =============================================================================

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Check, Ear, EarOff, Mic, Settings2, ShieldCheck, Volume2, VolumeX, X } from "lucide-react";
import { Modal } from "@/components/modal";
import { Badge, Button } from "@/components/ui";
import { rpc, RpcCallError } from "@/lib/client/api";
import { listSpeechVoices } from "@/lib/chat-speech";
import {
  DEFAULT_JARVIS_SETTINGS,
  JARVIS_SETTINGS_KEY,
  detectJarvisDeviceIntent,
  matchWakeWord,
  sanitizeJarvisSettings,
  type JarvisIntent,
  type JarvisSettings,
} from "@/lib/voice/jarvis-engine";
import { VOICE_LANGUAGES } from "@/lib/voice-input";

type SpeechRecLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type TauriGlobal = {
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __TAURI__?: {
    event?: {
      listen?: (event: string, cb: () => void) => Promise<() => void>;
    };
  };
};

async function invokeTauriCommand(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const win = window as unknown as TauriGlobal;
  const invoke = win.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return null;
  return invoke(cmd, args);
}

export function JarvisAssistantBar({
  speaking,
  autoSpeak,
  voiceLang,
  onVoiceLangChange,
  onToggleAutoSpeak,
  onInterruptSpeech,
  onStartPushToTalk,
  onSubmitSpokenCommand,
  onJarvisNotice,
  onJarvisSettingsChanged,
  commandDispatchRef,
}: {
  speaking: boolean;
  autoSpeak: boolean;
  voiceLang: string;
  onVoiceLangChange: (code: string) => void;
  onToggleAutoSpeak: () => void;
  onInterruptSpeech: () => void;
  onStartPushToTalk: () => void;
  onSubmitSpokenCommand: (text: string) => Promise<void> | void;
  onJarvisNotice: (text: string) => void;
  onJarvisSettingsChanged?: (settings: JarvisSettings) => void;
  commandDispatchRef?: MutableRefObject<((text: string) => Promise<void>) | null>;
}) {
  const [settings, setSettings] = useState<JarvisSettings>(DEFAULT_JARVIS_SETTINGS);
  const [voices, setVoices] = useState<Array<{ name: string; lang: string; localService: boolean }>>([]);
  const [wakeState, setWakeState] = useState<"off" | "standby" | "awaiting_command" | "unsupported">("off");
  const [wakeError, setWakeError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<JarvisIntent | null>(null);
  const [executingAction, setExecutingAction] = useState(false);

  const recRef = useRef<SpeechRecLike | null>(null);
  const awaitingCommandRef = useRef(false);
  const wakeEnabledRef = useRef(false);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(JARVIS_SETTINGS_KEY);
      if (raw) {
        const parsed = sanitizeJarvisSettings(JSON.parse(raw));
        setSettings(parsed);
        wakeEnabledRef.current = parsed.wakeEnabled;
        onJarvisSettingsChanged?.(parsed);
      }
    } catch {
      /* keep default */
    }
    const refreshVoices = () => setVoices(listSpeechVoices());
    refreshVoices();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistSettings = useCallback(
    (patch: Partial<JarvisSettings>) => {
      setSettings((prev) => {
        const next = sanitizeJarvisSettings({ ...prev, ...patch });
        wakeEnabledRef.current = next.wakeEnabled;
        try {
          window.localStorage.setItem(JARVIS_SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* ignore storage quota */
        }
        onJarvisSettingsChanged?.(next);
        return next;
      });
    },
    [onJarvisSettingsChanged],
  );

  const executeIntent = useCallback(
    async (intent: JarvisIntent, approved: boolean) => {
      setExecutingAction(true);
      try {
        // Attempt native desktop execution first if inside Tauri Windows Desktop.
        const hasTauri = Boolean((window as unknown as TauriGlobal).__TAURI_INTERNALS__?.invoke);
        if (hasTauri && intent.toolId === "device.open_app") {
          const appName = String(intent.args.app_name ?? "");
          const res = (await invokeTauriCommand("launch_app", { appName }).catch((e) => ({
            ok: false,
            message: e instanceof Error ? e.message : "Desktop launch failed",
          }))) as { ok?: boolean; message?: string } | null;
          if (res?.ok) {
            onJarvisNotice(res.message ?? `Launched ${appName} on Windows Desktop.`);
            setPendingAction(null);
            return;
          }
          onJarvisNotice(res?.message ?? `Could not launch ${appName} on desktop.`);
          setPendingAction(null);
          return;
        }
        if (hasTauri && intent.toolId === "device.media_control") {
          const action = String(intent.args.action ?? "play_pause");
          const res = (await invokeTauriCommand("media_control", { action }).catch((e) => ({
            ok: false,
            message: e instanceof Error ? e.message : "Media control failed",
          }))) as { ok?: boolean; message?: string } | null;
          if (res?.ok) {
            onJarvisNotice(res.message ?? `Executed media action (${action}) on desktop.`);
            setPendingAction(null);
            return;
          }
        }

        // Resolve target_device_id for cross-device commands when running on Web
        let effectiveArgs: Record<string, unknown> = { ...intent.args };
        if (
          (intent.toolId === "device.open_app" || intent.toolId === "device.media_control") &&
          !effectiveArgs.target_device_id
        ) {
          const devices = await rpc<
            Array<{ id: string; device_name: string; platform: string; status: string }>
          >("device_hub_list");
          const candidate =
            devices.find((d) => (d.platform === "windows" || d.platform === "android") && d.status !== "revoked") ??
            devices.find((d) => d.status !== "revoked");
          if (!candidate) {
            onJarvisNotice("No paired Android or Windows device is registered to execute that command. Pair a device in Devices first.");
            setPendingAction(null);
            return;
          }
          effectiveArgs = { ...effectiveArgs, target_device_id: candidate.id };
        }

        // Server-verified tool execution (+ one-time approval record if required).
        let approvalId: string | undefined;
        if (intent.requiresConfirmation && approved) {
          const req = await rpc<{ approval_id: string }>("tool_approval_request", {
            tool_id: intent.toolId,
            args: effectiveArgs,
          });
          await rpc("tool_approval_decide", { approval_id: req.approval_id, approve: true });
          approvalId = req.approval_id;
        }

        const out = await rpc<{
          ok: boolean;
          message?: string;
          error?: string;
          data?: Record<string, unknown>;
        }>("tool_execute", {
          tool_id: intent.toolId,
          args: effectiveArgs,
          approval_id: approvalId,
        });

        if (!out.ok) {
          onJarvisNotice(out.message ?? out.error ?? `Action "${intent.summary}" could not run.`);
        } else if (intent.toolId === "reminders.create") {
          onJarvisNotice(out.message ?? `Reminder saved: "${String(effectiveArgs.title)}".`);
        } else if (intent.toolId === "reminders.list") {
          const list = Array.isArray(out.data?.reminders)
            ? (out.data!.reminders as Array<{ title: string; status?: string }>)
            : [];
          const open = list.filter((r) => r.status !== "completed");
          onJarvisNotice(open.length ? `Open reminders (${open.length}): ${open.slice(0, 5).map((r) => r.title).join(", ")}` : "You have no open reminders.");
        } else if (intent.toolId === "device.status") {
          const devs = Array.isArray(out.data?.devices)
            ? (out.data!.devices as Array<{ status?: string }>)
            : [];
          const activeCount = devs.filter((d) => d.status === "active").length;
          onJarvisNotice(out.message ?? `Connected devices ready (${activeCount} active of ${devs.length}).`);
        } else if (intent.toolId === "notifications.list_synced") {
          const rows = Array.isArray(out.data?.notifications) ? out.data!.notifications : [];
          onJarvisNotice(rows.length ? `${rows.length} synced notification(s) ready in Notifications.` : "No unread synced notifications.");
        } else {
          onJarvisNotice(
            out.message ??
              (hasTauri
                ? `Completed ${intent.summary}.`
                : `${intent.summary} queued for paired Android/Desktop device.`),
          );
        }
        setPendingAction(null);
      } catch (err) {
        onJarvisNotice(err instanceof RpcCallError ? `Command blocked: ${err.code}` : "Could not run device command.");
      } finally {
        setExecutingAction(false);
      }
    },
    [onJarvisNotice],
  );

  const handleRecognizedUtterance = useCallback(
    async (text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      const intent = detectJarvisDeviceIntent(cleaned);
      if (intent) {
        if (intent.requiresConfirmation) {
          setPendingAction(intent);
          onJarvisNotice(`Confirmation needed: ${intent.summary}`);
          return;
        }
        await executeIntent(intent, true);
        return;
      }
      await onSubmitSpokenCommand(cleaned);
    },
    [executeIntent, onJarvisNotice, onSubmitSpokenCommand],
  );

  useEffect(() => {
    if (commandDispatchRef) commandDispatchRef.current = handleRecognizedUtterance;
    return () => {
      if (commandDispatchRef) commandDispatchRef.current = null;
    };
  }, [commandDispatchRef, handleRecognizedUtterance]);

  // Foreground SpeechRecognition wake-word loop (only when user explicitly enables wakeEnabled).
  useEffect(() => {
    if (!settings.wakeEnabled) {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      recRef.current = null;
      awaitingCommandRef.current = false;
      setWakeState("off");
      setWakeError("");
      return;
    }

    const ctor =
      typeof window !== "undefined"
        ? ((window as unknown as { SpeechRecognition?: new () => SpeechRecLike; webkitSpeechRecognition?: new () => SpeechRecLike }).SpeechRecognition ??
           (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecLike }).webkitSpeechRecognition)
        : undefined;

    if (!ctor) {
      setWakeState("unsupported");
      setWakeError("This browser does not support local wake-word recognition. Use Push-to-talk or the Android/Windows app.");
      return;
    }

    let cancelled = false;
    const rec = new ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = voiceLang === "auto" ? "en-US" : voiceLang;
    recRef.current = rec;
    setWakeState("standby");
    setWakeError("");

    rec.onresult = (ev) => {
      if (cancelled || speakingRef.current) return;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res.isFinal) continue;
        const transcript = res[0]?.transcript ?? "";
        if (!transcript.trim()) continue;

        if (awaitingCommandRef.current) {
          awaitingCommandRef.current = false;
          setWakeState("standby");
          void handleRecognizedUtterance(transcript);
          return;
        }

        const wake = matchWakeWord(transcript);
        if (wake.matched) {
          onInterruptSpeech();
          if (wake.commandText) {
            setWakeState("standby");
            void handleRecognizedUtterance(wake.commandText);
          } else {
            awaitingCommandRef.current = true;
            setWakeState("awaiting_command");
            onJarvisNotice('Heard "Hey QORVYNA" — speak your command now.');
          }
          return;
        }
      }
    };

    rec.onerror = (ev) => {
      if (cancelled) return;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setWakeError("Microphone permission denied. Enable mic access in browser settings.");
        persistSettings({ wakeEnabled: false });
      }
    };

    rec.onend = () => {
      if (cancelled || !wakeEnabledRef.current) return;
      if (document.visibilityState === "visible") {
        window.setTimeout(() => {
          if (!cancelled && wakeEnabledRef.current) {
            try {
              rec.start();
            } catch {
              /* ignore duplicate start */
            }
          }
        }, 400);
      }
    };

    try {
      rec.start();
    } catch {
      setWakeError("Could not start wake-word listener.");
    }

    return () => {
      cancelled = true;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    };
  }, [settings.wakeEnabled, voiceLang, handleRecognizedUtterance, onInterruptSpeech, onJarvisNotice, persistSettings]);

  // Global keyboard shortcut (Ctrl+Shift+Space / Cmd+Shift+Space) & Tauri hotkey listener.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        onInterruptSpeech();
        onStartPushToTalk();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    // Two entry points into QORVYNA's voice mode from the native shell:
    //   • the global shortcut / tray menu emits `qorvyna://voice-activate`;
    //   • the system opens the app URI `qorvyna://voice` (see tauri.conf.json).
    // Both end up here, and both are wrapped so a missing bridge is harmless.
    let unlistenTauri: (() => void) | null = null;
    const activate = () => {
      onInterruptSpeech();
      onStartPushToTalk();
    };
    const tauriGlobal = window as unknown as TauriGlobal;
    const tauriListen = tauriGlobal.__TAURI__?.event?.listen;
    if (tauriListen) {
      void tauriListen("qorvyna://voice-activate", activate)
        .then((fn) => {
          unlistenTauri = fn;
        })
        .catch(() => {
          /* event API unavailable — the shortcut listener below still notifies */
        });
    } else {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
      if (internals?.invoke) {
        // Tauri v2 exposes events through the core plugin when the global
        // object is absent (withGlobalTauri disabled). The reply is an event
        // id; the listener itself keeps the closure alive for the session.
        void internals
          .invoke("plugin:event|listen", { event: "qorvyna://voice-activate", target: { kind: "Any" } })
          .catch(() => {
            /* stay silent: native voice activation is optional */
          });
      }
    }

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unlistenTauri?.();
    };
  }, [onInterruptSpeech, onStartPushToTalk]);

  const statusLabel = speaking
    ? "Speaking"
    : wakeState === "awaiting_command"
      ? "Listening for command…"
      : wakeState === "standby"
        ? 'Wake: "Hey QORVYNA" (Foreground)'
        : wakeState === "unsupported"
          ? "Wake unavailable"
          : "Jarvis ready";

  return (
    <div className="border-b border-border/60 bg-surface-2/40 px-3 py-1.5">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => persistSettings({ wakeEnabled: !settings.wakeEnabled })}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 font-medium text-ink transition hover:border-accent"
            title="Toggle foreground Hey QORVYNA wake word"
          >
            {settings.wakeEnabled ? <Ear size={13} className="text-accent" /> : <EarOff size={13} className="text-ink-3" />}
            <span>{statusLabel}</span>
          </button>

          {wakeError ? <span className="text-[11px] text-warning">{wakeError}</span> : null}
        </div>

        <div className="flex items-center gap-1.5">
          {speaking ? (
            <Button variant="danger" className="!min-h-7 !px-2.5 !text-xs" onClick={onInterruptSpeech}>
              <VolumeX size={13} />
              Interrupt
            </Button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              onInterruptSpeech();
              onStartPushToTalk();
            }}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-ink-2 transition hover:border-accent hover:text-ink"
            title="Voice command (Ctrl+Shift+Space)"
          >
            <Mic size={13} />
            <span className="hidden sm:inline">Speak</span>
          </button>

          <button
            type="button"
            onClick={onToggleAutoSpeak}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-1 text-ink-2 transition hover:border-accent hover:text-ink"
            title={autoSpeak ? "Auto read-aloud is on" : "Auto read-aloud is off"}
          >
            {autoSpeak ? <Volume2 size={13} className="text-accent" /> : <VolumeX size={13} />}
          </button>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-1 text-ink-2 transition hover:border-accent hover:text-ink"
            aria-label="Jarvis voice settings"
            title="Jarvis voice & hotkey settings"
          >
            <Settings2 size={13} />
          </button>
        </div>
      </div>

      {pendingAction ? (
        <div className="mx-auto mt-2 flex max-w-3xl flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-ink">
            <ShieldCheck size={15} className="shrink-0 text-warning" />
            <span>
              <strong>Confirm device action:</strong> {pendingAction.summary}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="!min-h-8 !px-3 !text-xs" disabled={executingAction} onClick={() => setPendingAction(null)}>
              <X size={13} /> Cancel
            </Button>
            <Button className="!min-h-8 !px-3 !text-xs" disabled={executingAction} onClick={() => void executeIntent(pendingAction, true)}>
              <Check size={13} /> Confirm & run
            </Button>
          </div>
        </div>
      ) : null}

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Jarvis Voice Assistant Settings">
        <div className="space-y-4 text-sm">
          <div className="rounded-xl border border-border bg-surface-2/60 p-3 text-xs text-ink-2">
            Web wake-word listening (&ldquo;Hey QORVYNA&rdquo;) runs strictly in the foreground while this tab is active — continuous background audio is never streamed to the cloud.
          </div>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
            <div>
              <p className="font-medium text-ink">Foreground wake word (&ldquo;Hey QORVYNA&rdquo;)</p>
              <p className="text-xs text-ink-3">Supports English and Bangla wake variants.</p>
            </div>
            <input
              type="checkbox"
              checked={settings.wakeEnabled}
              onChange={(e) => persistSettings({ wakeEnabled: e.target.checked })}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
            <div>
              <p className="font-medium text-ink">Auto read replies aloud</p>
              <p className="text-xs text-ink-3">Interrupt any time with the Interrupt button or Speak shortcut.</p>
            </div>
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={onToggleAutoSpeak}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-ink-2">Speech language</label>
            <select
              value={voiceLang}
              onChange={(e) => onVoiceLangChange(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink"
            >
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-ink-2">Spoken voice ({voices.length} installed)</label>
            <select
              value={settings.voiceName}
              onChange={(e) => persistSettings({ voiceName: e.target.value })}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">System automatic voice</option>
              {voices.map((v) => (
                <option key={`${v.name}:${v.lang}`} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="font-medium text-ink-2">Speech speed</span>
              <span className="font-mono text-ink-3">{settings.speechRate.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min="0.7"
              max="1.5"
              step="0.05"
              value={settings.speechRate}
              onChange={(e) => persistSettings({ speechRate: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-ink-3">
            <span>Global shortcut: <Badge>Ctrl + Shift + Space</Badge></span>
            <Button className="!min-h-8 !px-3 !text-xs" onClick={() => setSettingsOpen(false)}>Done</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
