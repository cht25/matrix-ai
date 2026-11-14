"use client";

// Compact model control for the composer (Chat and Agent share it).
// Shows how many models are active, lets the user switch each one on or off
// or hand the choice to Auto. Only friendly names appear here; the provider
// configuration lives on the Model settings page.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, Layers, Loader2, Settings2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelStatus, PoolPreference } from "@/lib/ai/models/types";

type Payload = { models: ModelStatus[]; pool: PoolPreference; max_active: number };

const POOL_EVENT = "matrix:model-pool";

export async function saveModelPool(pool: PoolPreference): Promise<PoolPreference> {
  const response = await fetch("/api/models", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pool) });
  const body = (await response.json().catch(() => null)) as { pool?: PoolPreference; error?: string } | null;
  if (!response.ok || !body?.pool) throw new Error(body?.error ?? "SAVE_FAILED");
  window.dispatchEvent(new CustomEvent(POOL_EVENT, { detail: body.pool }));
  return body.pool;
}

/** Subscribe to pool changes made elsewhere on the page. */
export function onModelPoolChange(listener: (pool: PoolPreference) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<PoolPreference>).detail);
  window.addEventListener(POOL_EVENT, handler);
  return () => window.removeEventListener(POOL_EVENT, handler);
}

export function ModelPicker({ className }: { className?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/models", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      setData((await response.json()) as Payload);
    } catch { /* the control stays in its neutral state */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onModelPoolChange((pool) => setData((current) => (current ? { ...current, pool } : current))), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Keep the panel inside the viewport on narrow screens.
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!open || !rootRef.current) return;
    const place = () => {
      const rect = rootRef.current!.getBoundingClientRect();
      const width = Math.min(304, window.innerWidth - 32);
      setShift(Math.min(0, window.innerWidth - 12 - (rect.left + width)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const available = data?.models.filter((model) => model.availability === "available") ?? [];
  const pool = data?.pool ?? { auto: true, enabled: [] };
  const activeKeys = pool.auto ? available.map((model) => model.key).slice(0, data?.max_active ?? 4) : pool.enabled.filter((key) => available.some((model) => model.key === key));
  const count = activeKeys.length;

  async function apply(next: PoolPreference) {
    if (!data) return;
    const previous = data.pool;
    setData({ ...data, pool: next }); // optimistic; rolled back on failure
    setSaving(true); setError("");
    try {
      const saved = await saveModelPool(next);
      setData((current) => (current ? { ...current, pool: saved } : current));
    } catch {
      setData((current) => (current ? { ...current, pool: previous } : current));
      setError("Couldn't save. Try again.");
    } finally { setSaving(false); }
  }

  function toggle(key: string) {
    if (!data) return;
    const base = pool.auto ? [] : pool.enabled;
    const next = base.includes(key) ? base.filter((item) => item !== key) : [...base, key];
    if (next.length > data.max_active) { setError(`Up to ${data.max_active} models can work together.`); return; }
    // Turning the last model off hands the choice back to Auto.
    void apply(next.length ? { auto: false, enabled: next } : { auto: true, enabled: [] });
  }

  const label = !data ? "Models" : count === 0 ? "No model available" : pool.auto ? `Auto · ${count}` : count === 1 ? available.find((model) => model.key === activeKeys[0])?.label ?? "1 model" : `${count} models`;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Models: ${label}`}
        title="Choose which models work on your request"
        className={cn(
          "inline-flex h-11 max-w-[9.5rem] shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-medium transition-colors duration-150",
          open ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
        )}
      >
        <Layers size={16} strokeWidth={1.7} className="shrink-0" />
        <span className="hidden truncate sm:inline">{label}</span>
        {data && count > 0 ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-surface-2 px-1 text-[10px] font-semibold text-ink-2 sm:hidden">{count}</span> : null}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-label="Active models" style={{ left: shift }} className="absolute bottom-full z-40 mb-2 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-2 shadow-xl">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <p className="text-xs font-semibold text-ink">Models{data ? <span className="font-normal text-ink-3"> · {count} active</span> : null}</p>
            {saving ? <Loader2 size={13} className="animate-spin text-ink-3" aria-label="Saving" /> : null}
          </div>
          {!data ? (
            <div className="space-y-1.5 p-1" aria-busy="true"><div className="h-10 animate-pulse rounded-xl bg-surface-2" /><div className="h-10 animate-pulse rounded-xl bg-surface-2" /></div>
          ) : (
            <ul className="space-y-0.5">
              <li>
                <button type="button" role="menuitemcheckbox" aria-checked={pool.auto} onClick={() => void apply({ auto: true, enabled: [] })} className={cn("flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-surface-2", pool.auto && "bg-accent-soft/60")}>
                  <Sparkles size={15} className={cn("mt-0.5 shrink-0", pool.auto ? "text-accent" : "text-ink-3")} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">Auto</span>
                    <span className="block text-xs text-ink-3">MATRIX picks the right models for each request.</span>
                  </span>
                  {pool.auto ? <Check size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden /> : null}
                </button>
              </li>
              {data.models.map((model) => {
                const usable = model.availability === "available";
                const on = !pool.auto && pool.enabled.includes(model.key) && usable;
                return (
                  <li key={model.key}>
                    <button type="button" role="menuitemcheckbox" aria-checked={on} disabled={!usable} onClick={() => toggle(model.key)} className={cn("flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left", usable ? "hover:bg-surface-2" : "cursor-not-allowed opacity-55")}>
                      <span className={cn("mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border", on ? "border-accent bg-accent text-white" : "border-border")} aria-hidden>{on ? <Check size={11} strokeWidth={3} /> : null}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{model.label}</span>
                        <span className="block text-xs text-ink-3">{usable ? model.summary : "Not available"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div aria-live="polite" className="px-2 text-xs text-danger empty:hidden">{error}</div>
          <Link href="/models" className="mt-1 flex items-center gap-1.5 rounded-xl px-2 py-2 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink" onClick={() => setOpen(false)}>
            <Settings2 size={13} /> Model settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}
