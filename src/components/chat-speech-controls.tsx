"use client";

import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSpeechSupported } from "@/lib/chat-speech";

export function AutoSpeakToggle({
  on,
  onToggle,
  onLabel,
  offLabel,
}: {
  on: boolean;
  onToggle: () => void;
  onLabel: string;
  offLabel: string;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(isSpeechSupported());
  }, []);
  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={on ? onLabel : offLabel}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
        on ? "border-border bg-surface-2 text-ink" : "border-border text-ink-3 hover:border-border-strong hover:bg-surface-2 hover:text-ink",
      )}
    >
      {on ? <Volume2 size={13} /> : <VolumeX size={13} />}
      <span className="hidden sm:inline">{on ? onLabel : offLabel}</span>
    </button>
  );
}

export function ListenButton({
  speaking,
  onClick,
  disabled,
  listenLabel,
  stopLabel,
}: {
  speaking: boolean;
  onClick: () => void;
  disabled?: boolean;
  listenLabel: string;
  stopLabel: string;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(isSpeechSupported());
  }, []);
  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={speaking ? stopLabel : listenLabel}
      className="min-h-8 min-w-8 font-medium uppercase tracking-wide transition-colors hover:text-ink-2 disabled:opacity-40"
    >
      {speaking ? stopLabel : listenLabel}
    </button>
  );
}
