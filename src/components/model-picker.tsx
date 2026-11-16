"use client";

// =============================================================================
// Models — the one model control for Chat and Agent.
//
// The toolbar only ever says "Models". Everything technical lives in here:
// each model's provider and identifier, what it can do, whether this
// deployment can actually reach it right now, and which ones are active.
//
//   · searchable (name, provider, identifier, strengths)
//   · Auto hands the choice to QORVYNA; otherwise pick up to `max_active`
//   · a model the provider is not offering is listed, explained and DISABLED —
//     it can never be selected or sent a request
//
// The selection is saved to the account (PUT /api/models), so it applies to
// every conversation in both modes and survives a reload. Provider routing
// itself is untouched: this only edits the user's pool preference.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Check, ChevronDown, Layers, Loader2, RefreshCw, Search, Settings2, Sparkles } from "lucide-react";
import { Popover } from "@/components/popover";
import { cn } from "@/lib/utils";
import { STRENGTH_LABEL, type ModelAvailability, type ModelStatus, type PoolPreference } from "@/lib/ai/models/types";

export type ModelPoolPayload = { models: ModelStatus[]; pool: PoolPreference; max_active: number; reveal_mode?: string };

const POOL_EVENT = "matrix:model-pool";
const CACHE_MS = 30_000;

let cached: { at: number; data: ModelPoolPayload } | null = null;
let inFlight: Promise<ModelPoolPayload | null> | null = null;

/**
 * The model pool, shared by everything on the page that needs it (the selector
 * and the chat's display preference): one request, however many callers.
 */
export function loadModelPool(options: { force?: boolean; check?: boolean } = {}): Promise<ModelPoolPayload | null> {
  if (!options.force && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.data);
  if (inFlight && !options.force) return inFlight;
  const request = fetch(`/api/models${options.check ? "?check=1" : ""}`, { credentials: "same-origin", cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return null;
      const data = (await response.json()) as ModelPoolPayload;
      if (!Array.isArray(data?.models) || !data.pool) return null;
      cached = { at: Date.now(), data };
      return data;
    })
    .catch(() => null)
    .finally(() => { if (inFlight === request) inFlight = null; });
  inFlight = request;
  return request;
}

export async function saveModelPool(pool: PoolPreference): Promise<PoolPreference> {
  const response = await fetch("/api/models", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pool) });
  const body = (await response.json().catch(() => null)) as { pool?: PoolPreference; error?: string } | null;
  if (!response.ok || !body?.pool) throw new Error(body?.error ?? "SAVE_FAILED");
  if (cached) cached = { at: cached.at, data: { ...cached.data, pool: body.pool } };
  window.dispatchEvent(new CustomEvent(POOL_EVENT, { detail: body.pool }));
  return body.pool;
}

/** Subscribe to pool changes made elsewhere on the page. */
export function onModelPoolChange(listener: (pool: PoolPreference) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<PoolPreference>).detail);
  window.addEventListener(POOL_EVENT, handler);
  return () => window.removeEventListener(POOL_EVENT, handler);
}

const AVAILABILITY: Record<ModelAvailability, { label: string; tone: string; dot: string }> = {
  available: { label: "Available", tone: "text-success", dot: "bg-success" },
  not_configured: { label: "Not configured", tone: "text-warning", dot: "bg-warning" },
  not_offered: { label: "Not offered", tone: "text-ink-3", dot: "bg-ink-3" },
  unverified: { label: "Unverified", tone: "text-warning", dot: "bg-warning" },
};

function contextLabel(tokens: number): string {
  if (!tokens) return "";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K context` : `${tokens} context`;
}

/** Models matching a search across everything a person might type. */
export function filterModels(models: ModelStatus[], query: string): ModelStatus[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  const terms = needle.split(/\s+/);
  return models.filter((model) => {
    const haystack = [
      model.label, model.provider, model.model_id, model.summary, AVAILABILITY[model.availability]?.label ?? "",
      ...model.strengths.map((strength) => STRENGTH_LABEL[strength] ?? strength),
      model.tool_calling ? "tools" : "", model.streaming ? "streaming" : "", model.structured_output ? "json structured" : "",
    ].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Which model keys are active right now, given the pool and what is reachable. */
export function activeModelKeys(data: ModelPoolPayload | null): string[] {
  if (!data) return [];
  const available = data.models.filter((model) => model.availability === "available").map((model) => model.key);
  if (data.pool.auto) return available.slice(0, data.max_active);
  return data.pool.enabled.filter((key) => available.includes(key));
}

function ModelPanel({ data, setData, onReload, loadFailed }: { data: ModelPoolPayload | null; setData: (next: (current: ModelPoolPayload | null) => ModelPoolPayload | null) => void; onReload: (check: boolean) => Promise<void>; loadFailed: boolean }) {
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const pool = data?.pool ?? { auto: true, enabled: [] };
  const active = activeModelKeys(data);
  const shown = useMemo(() => filterModels(data?.models ?? [], query), [data, query]);
  const showAuto = !query.trim() || "auto automatic".includes(query.trim().toLowerCase());

  async function apply(next: PoolPreference) {
    if (!data || saving) return;
    const previous = data.pool;
    setData((current) => (current ? { ...current, pool: next } : current)); // optimistic; rolled back on failure
    setSaving(true); setError("");
    try {
      const saved = await saveModelPool(next);
      setData((current) => (current ? { ...current, pool: saved } : current));
    } catch (cause) {
      setData((current) => (current ? { ...current, pool: previous } : current));
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "MODEL_UNAVAILABLE" ? "That model is not available right now." : "Your selection couldn't be saved. Try again.");
    } finally { setSaving(false); }
  }

  function toggle(model: ModelStatus) {
    if (!data || model.availability !== "available") return;
    const base = pool.auto ? [] : pool.enabled.filter((key) => data.models.some((item) => item.key === key && item.availability === "available"));
    const next = base.includes(model.key) ? base.filter((key) => key !== model.key) : [...base, model.key];
    if (next.length > data.max_active) { setError(`Up to ${data.max_active} models can work together. Turn one off first.`); return; }
    // Turning the last model off hands the choice back to Auto.
    void apply(next.length ? { auto: false, enabled: next } : { auto: true, enabled: [] });
  }

  function rows(): HTMLElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-model-row]:not(:disabled)") ?? []);
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = rows();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") { event.preventDefault(); items[Math.min(items.length - 1, index + 1)]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); if (index <= 0) searchRef.current?.focus(); else items[index - 1]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); items[items.length - 1]?.focus(); }
  }

  return (
    <div className="flex max-h-[min(34rem,calc(82dvh-7rem))] min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 pb-2 pt-1">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search models</span>
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            ref={searchRef}
            data-autofocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); rows()[0]?.focus(); } }}
            placeholder="Search models"
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-border bg-surface-2 pl-8 pr-2 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
        </label>
        <button
          type="button"
          onClick={() => { setChecking(true); void onReload(true).finally(() => setChecking(false)); }}
          disabled={checking}
          aria-label="Check model availability again"
          title="Check availability again"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(checking && "animate-spin")} aria-hidden="true" />
        </button>
      </div>

      <div ref={listRef} onKeyDown={onListKeyDown} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1" role="group" aria-label="Models">
        {!data ? (
          loadFailed ? (
            <p className="px-3 py-6 text-center text-[13px] text-ink-2" role="alert">Models couldn&apos;t be loaded. Check your connection and press the refresh button.</p>
          ) : (
            <div className="space-y-1.5 p-1" aria-busy="true" aria-label="Loading models">
              <div className="h-14 animate-pulse rounded-xl bg-surface-2" /><div className="h-14 animate-pulse rounded-xl bg-surface-2" /><div className="h-14 animate-pulse rounded-xl bg-surface-2" />
            </div>
          )
        ) : (
          <>
            {showAuto ? (
              <button
                type="button"
                data-model-row
                role="checkbox"
                aria-checked={pool.auto}
                onClick={() => void apply({ auto: true, enabled: [] })}
                className={cn("flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none", pool.auto && "bg-accent-soft")}
              >
                <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", pool.auto ? "bg-accent-solid text-accent-ink" : "bg-surface-2 text-ink-2")} aria-hidden="true"><Sparkles size={15} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink">Auto</span>
                  <span className="block text-[12.5px] leading-snug text-ink-2">QORVYNA chooses the right models for each request.</span>
                </span>
                {pool.auto ? <Check size={17} className="mt-1.5 shrink-0 text-accent" aria-hidden="true" /> : null}
              </button>
            ) : null}

            {shown.map((model) => {
              const usable = model.availability === "available";
              const selected = usable && active.includes(model.key);
              const chosen = selected && !pool.auto;
              const state = AVAILABILITY[model.availability] ?? AVAILABILITY.unverified;
              const capabilities = [
                ...model.strengths.slice(0, 3).map((strength) => STRENGTH_LABEL[strength] ?? strength),
                model.tool_calling ? "Tools" : "", model.structured_output ? "JSON" : "", contextLabel(model.context_tokens),
              ].filter(Boolean);
              return (
                <button
                  key={model.key}
                  type="button"
                  data-model-row
                  role="checkbox"
                  aria-checked={chosen}
                  aria-disabled={!usable}
                  disabled={!usable}
                  onClick={() => toggle(model)}
                  title={usable ? undefined : model.reason || "This model is not available on this deployment."}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors focus-visible:outline-none",
                    usable ? "hover:bg-surface-2 focus-visible:bg-surface-2" : "cursor-not-allowed opacity-55",
                    chosen && "bg-accent-soft",
                  )}
                >
                  <span className={cn("mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-md border", chosen ? "border-accent-solid bg-accent-solid text-accent-ink" : "border-border-strong")} aria-hidden="true">
                    {chosen ? <Check size={13} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[14px] font-semibold text-ink">{model.label}</span>
                      {model.is_default ? <span className="rounded bg-surface-2 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-ink-2">Default</span> : null}
                      <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium", state.tone)}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", state.dot)} aria-hidden="true" />
                        {usable && selected && pool.auto ? "In use" : state.label}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-3">{model.provider} · {model.model_id}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">{usable ? model.summary : model.reason || "Not available on this deployment."}</span>
                    {usable && capabilities.length ? (
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {capabilities.map((capability) => (
                          <span key={capability} className="rounded-md border border-border px-1.5 py-px text-[10.5px] text-ink-2">{capability}</span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}

            {!shown.length && !showAuto ? <p className="px-3 py-6 text-center text-[13px] text-ink-2">No model matches “{query.trim()}”.</p> : null}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-2 pb-1 pt-2">
        <p aria-live="polite" className="px-1 pb-1.5 text-[12px] text-danger empty:hidden">{error}</p>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate px-1 text-[12px] text-ink-3">
            {saving ? <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Saving…</span>
              : data ? `${active.length} active · Chat and Agent` : ""}
          </p>
          <Link href="/models" className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            <Settings2 size={13} aria-hidden="true" /> Model settings
          </Link>
        </div>
      </div>
    </div>
  );
}

/** The toolbar control. Its label is always just "Models". */
export function ModelSelector({ className, disabled }: { className?: string; disabled?: boolean }) {
  const [data, setDataState] = useState<ModelPoolPayload | null>(cached?.data ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async (check: boolean) => {
    const next = await loadModelPool({ force: check, check });
    setLoadFailed(!next);
    if (next) setDataState(next);
  }, []);

  useEffect(() => { void reload(false); }, [reload]);
  useEffect(() => onModelPoolChange((pool) => setDataState((current) => (current ? { ...current, pool } : current))), []);
  // Availability can change while the tab is open; re-read it when the panel opens.
  useEffect(() => { if (open && (!cached || Date.now() - cached.at > CACHE_MS)) void reload(false); }, [open, reload]);

  const active = activeModelKeys(data);
  const none = Boolean(data) && active.length === 0;

  return (
    <Popover
      label="Models"
      sheetTitle="Models"
      role="dialog"
      align="left"
      open={open}
      onOpenChange={setOpen}
      panelClassName="w-[23rem] max-w-[calc(100vw-1rem)] !p-1.5"
      className={className}
      trigger={({ toggle, open: isOpen, aria }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          title="Choose which models work on your requests"
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border px-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            isOpen ? "border-border bg-surface-2 text-ink" : "border-transparent text-ink-2 hover:border-border hover:bg-surface-2 hover:text-ink",
          )}
          {...aria}
        >
          <Layers size={15} strokeWidth={1.8} className={cn("shrink-0", none && "text-warning")} aria-hidden="true" />
          <span>Models</span>
          {none ? <span className="sr-only">— no model is available</span> : null}
          <ChevronDown size={13} className={cn("shrink-0 text-ink-3 transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
        </button>
      )}
    >
      {() => <ModelPanel data={data} setData={(next) => setDataState(next)} onReload={reload} loadFailed={loadFailed} />}
    </Popover>
  );
}
