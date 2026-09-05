"use client";

// =============================================================================
// Project URL management, environment variables and the asset library
// (§7, §8, §19, §20, §27, §28, §35)
//
// Every affordance here is gated by what the connected provider can really do:
//   • generated aliases are created only when a live site exists to mirror;
//   • a custom hostname stays "pending" until the DNS challenge *and* the
//     hostname probe both succeed — never shown as connected before that;
//   • "Set primary" is disabled for addresses that cannot serve traffic;
//   • environment values are documented as public because the static host has
//     no server runtime that could hold a secret.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  Check, Copy, Eye, EyeOff, FolderOpen, Globe2, Image as ImageIcon, Link2, Plus, ShieldAlert, Star, Trash2, X,
} from "lucide-react";
import type { ProjectUrl, UrlKind } from "@/lib/deploy/urls";
import { openableUrlOf, prepareNewUrl, urlErrorCopy, urlLabel } from "@/lib/deploy/urls";
import { absoluteUrl, copyToClipboard, formatBytes, relativeTime, shortUrl } from "@/lib/deploy/format";
import { rpc } from "@/lib/client/api";
import { Alert, Button, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// §8 / §19 URL management
// ---------------------------------------------------------------------------

export function UrlManager({
  projectId,
  urls,
  origin,
  onChanged,
  isLive,
}: {
  projectId: string;
  urls: ProjectUrl[];
  origin: string;
  onChanged: () => void;
  isLive: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setMessage(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setMessage({ tone: "danger", text: describeUrlError(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <Globe2 size={14} className="text-accent" />
        <p className="eyebrow flex-1 text-ink-3">Project URLs</p>
        <button type="button" onClick={() => setAdding(true)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-accent hover:bg-surface-2">
          <Plus size={12} /> Add URL
        </button>
      </header>

      {urls.length ? (
        <ul className="divide-y divide-border">
          {urls.map((item) => {
            const openable = openableUrlOf(item, origin);
            return (
              <li key={item.id} className="px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("text-[13px]", item.primary ? "text-success" : "text-ink-3")} aria-hidden="true">
                    {item.primary ? "●" : "○"}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                    {item.primary ? "Primary" : urlLabel(item.kind)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                    {openable ? (
                      <a href={absoluteUrl(openable)} target="_blank" rel="noreferrer noopener" className="hover:text-accent">
                        {shortUrl(item.url, 60)}
                      </a>
                    ) : (
                      <span className="text-ink-2">{shortUrl(item.url, 60)}</span>
                    )}
                  </span>
                  {item.status === "pending_dns" ? (
                    <span className="rounded-full border border-warning/40 bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning">DNS pending</span>
                  ) : item.status === "verifying" ? (
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-ink-3">Verifying</span>
                  ) : item.status === "revoked" ? (
                    <span className="rounded-full border border-danger/40 bg-danger-soft px-2 py-0.5 text-[10px] text-danger">Removed</span>
                  ) : null}
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    <MiniAction label="Copy" icon={<Copy size={11} />} onClick={() => void copyToClipboard(absoluteUrl(item.url))} />
                    {openable ? (
                      <a
                        href={absoluteUrl(openable)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
                      >
                        <Link2 size={11} /> Open
                      </a>
                    ) : null}
                    {item.kind !== "preview" && !item.primary ? (
                      <MiniAction label="Set primary" icon={<Star size={11} />} onClick={() => void act(item.id, () => rpc("url_set_primary", { project_id: projectId, url_id: item.id }))} disabled={busy === item.id || (item.kind === "custom" && item.status !== "active")} />
                    ) : null}
                    {item.kind === "custom" ? (
                      <MiniAction
                        label="Check DNS"
                        icon={<ShieldAlert size={11} />}
                        onClick={() =>
                          void act(item.id, async () => {
                            const result = await rpc<{ status: string; detail?: string }>("url_verify_domain", { project_id: projectId });
                            setMessage({
                              tone: result.status === "verified" ? "success" : "info",
                              text:
                                result.status === "verified"
                                  ? "Verified — the hostname serves this project."
                                  : `Still waiting (${result.status}). ${result.detail ?? "Add the CNAME and the challenge file, then check again."}`,
                            });
                          })
                        }
                        disabled={busy === item.id}
                      />
                    ) : null}
                    {!item.primary ? (
                      <MiniAction label="Remove" icon={<Trash2 size={11} />} danger onClick={() => void act(item.id, () => rpc("url_remove", { project_id: projectId, url_id: item.id }))} disabled={busy === item.id} />
                    ) : null}
                  </span>
                </div>
                {item.detail ? <p className="mt-1 pl-6 text-[11px] leading-snug text-ink-3">{item.detail}</p> : null}
                {busy === item.id ? <p className="mt-1 pl-6 text-[11px] text-accent"><Spinner className="mr-1 inline h-3 w-3" />Working…</p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-[12px] text-ink-3">No addresses yet — publish the project to create its first URL.</p>
      )}

      {message ? (
        <div className="px-3.5 pb-3">
          <Alert tone={message.tone === "danger" ? "danger" : message.tone === "success" ? "success" : "info"}>{message.text}</Alert>
        </div>
      ) : null}

      {!isLive ? (
        <p className="border-t border-border px-3.5 py-2 text-[11px] text-ink-3">
          Extra generated addresses mirror a live deployment, so publish first — MATRIX never creates an address that would 404.
        </p>
      ) : null}

      {adding ? (
        <AddUrlDialog
          projectId={projectId}
          origin={origin}
          existing={urls}
          allowCustom
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function MiniAction({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40",
        danger && "hover:text-danger",
      )}
    >
      {icon} {label}
    </button>
  );
}

export function AddUrlDialog({
  projectId,
  origin,
  existing,
  allowCustom = true,
  onCancel,
  onAdded,
}: {
  projectId: string;
  origin: string;
  existing: ProjectUrl[];
  allowCustom?: boolean;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<UrlKind>("generated");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  const preview = value.trim() ? prepareNewUrl({ raw: value, kind, origin, projectId, existing }) : null;
  const invalid = preview && !preview.ok ? urlErrorCopy(preview.code) : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await rpc("url_add", { project_id: projectId, value, kind });
      onAdded();
    } catch (err) {
      setError(urlErrorCopy(err instanceof Error ? err.message.replace(/^RpcCallError:\s*/, "") : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[92] flex items-end justify-center p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Add project URL">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} aria-label="Cancel" tabIndex={-1} />
      <div className="fade-in relative w-full max-w-md rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2">
          <p className="eyebrow flex-1 text-ink-3">Add project URL</p>
          <button type="button" onClick={onCancel} className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <fieldset className="mt-3">
          <legend className="text-[12px] font-medium text-ink-2">Type</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(["generated", "custom", "preview"] as UrlKind[]).map((option) => (
              <label
                key={option}
                className={cn(
                  "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12px]",
                  option === kind ? "border-accent/50 bg-accent-soft text-ink" : "border-border text-ink-2",
                  option === "custom" && !allowCustom && "cursor-not-allowed opacity-40",
                )}
              >
                <input
                  type="radio"
                  name="url-kind"
                  className="sr-only"
                  disabled={option === "custom" && !allowCustom}
                  checked={option === kind}
                  onChange={() => setKind(option)}
                />
                <span className={cn("h-1.5 w-1.5 rounded-full", option === kind ? "bg-accent" : "bg-ink-3/40")} aria-hidden="true" />
                {option === "generated" ? "Generated" : option === "custom" ? "Custom domain" : "Preview"}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-3 block text-[12px] font-medium text-ink-2">
          {kind === "generated" ? "Address" : kind === "custom" ? "Domain" : "Preview URL"}
          <Input
            className="mt-1"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={kind === "generated" ? "my-cool-site" : kind === "custom" ? "app.mycompany.com" : "preview"}
            autoFocus
          />
        </label>
        {kind === "preview" ? <p className="mt-1 text-[11px] text-ink-3">Preview addresses are always the same-origin sandbox for this project.</p> : null}
        {invalid ? (
          <Alert tone="danger">
            <span className="block font-semibold">{invalid.title}</span>
            <span className="mt-0.5 block text-[12px]">{invalid.detail}</span>
          </Alert>
        ) : preview?.ok ? (
          <p className="mt-1.5 text-[11.5px] text-ink-3">
            Will be added as <span className="font-mono text-ink-2">{preview.url}</span>
            {kind === "custom" ? " — verification still needs the DNS challenge plus a reachable hostname." : ""}
          </p>
        ) : null}
        {error ? <div className="mt-2"><Alert tone="danger">{error.detail}</Alert></div> : null}

        <div className="mt-3.5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !value.trim() || Boolean(invalid)}>
            {busy ? <Spinner /> : <Check size={15} />} Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function describeUrlError(err: unknown): string {
  const code = err instanceof Error ? err.message.replace(/^RpcCallError:\s*/, "") : "";
  const known = urlErrorCopy(code);
  if (code && known.title !== "Could not add that address") return `${known.title} — ${known.detail}`;
  if (code === "NO_LIVE_SITE") return "Publish the project first — an address must serve something.";
  if (code === "URL_PRIMARY_REQUIRED") return "The primary address cannot be removed. Set another one as primary first.";
  if (code === "URL_NOT_PRIMARY") return "Preview addresses cannot become the primary URL.";
  if (code === "DOMAIN_NOT_VERIFIED") return "That domain has not verified yet, so it cannot become primary.";
  return "This could not be completed right now. Check the address and try again.";
}

// ---------------------------------------------------------------------------
// §35 environment configuration
// ---------------------------------------------------------------------------

export type EnvPanelProps = {
  projectId: string;
  env: Record<string, string>;
  onChanged: () => void;
};

export function EnvPanel({ projectId, env, onChanged }: EnvPanelProps) {
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const entries = Object.entries(env ?? {});

  async function save(next: Record<string, string>) {
    setBusy(true);
    try {
      const result = await rpc<{ env: Record<string, string>; rejected: string[] }>("project_set_env", { project_id: projectId, env: next });
      setNotice(
        result.rejected?.length
          ? `Not stored: ${result.rejected.join(", ")} look like secrets. This host serves static files, so anything here is public to visitors.`
          : null,
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <ShieldAlert size={14} className="text-warning" />
        <p className="eyebrow flex-1 text-ink-3">Environment · Production</p>
        <button type="button" onClick={() => setDraft({ key: "", value: "" })} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-accent hover:bg-surface-2">
          <Plus size={12} /> Add variable
        </button>
      </header>

      {entries.length ? (
        <ul className="divide-y divide-border">
          {entries.map(([key, value]) => (
            <li key={key} className="flex items-center gap-2 px-3.5 py-2 text-[12px]">
              <span className="font-mono text-ink">{key}</span>
              <span className="ml-auto font-mono text-ink-2">{revealed ? value || "(empty)" : "•".repeat(Math.min(12, Math.max(6, value.length || 6)))}</span>
              <MiniAction label="Remove" icon={<Trash2 size={11} />} danger onClick={() => void save(Object.fromEntries(entries.filter(([name]) => name !== key)))} disabled={busy} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3.5 py-3 text-[12px] text-ink-3">No variables yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
        <button type="button" onClick={() => setRevealed((value) => !value)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-ink-2 hover:bg-surface-2">
          {revealed ? <EyeOff size={12} /> : <Eye size={12} />} {revealed ? "Hide values" : "Reveal values"}
        </button>
        <p className="text-[11px] text-ink-3">
          Values are injected into the published page as <span className="font-mono">window.MATRIX_ENV</span> — public by design, never deployment credentials.
        </p>
      </div>
      {notice ? <div className="px-3.5 pb-3"><Alert tone="warning">{notice}</Alert></div> : null}

      {draft ? (
        <div className="border-t border-border px-3.5 py-3">
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-0 flex-1 font-mono"
              placeholder="SITE_NAME"
              value={draft.key}
              onChange={(event) => setDraft({ ...draft, key: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })}
              autoFocus
            />
            <Input className="min-w-0 flex-1" placeholder="value" value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
            <Button
              onClick={() => {
                const key = draft.key.trim();
                if (!key) return;
                void save({ ...env, [key]: draft.value });
                setDraft(null);
              }}
              disabled={busy || !draft.key.trim()}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-3">Uppercase letters, numbers and underscores. Keys that look like secrets are refused.</p>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// §27 / §28 project asset library
// ---------------------------------------------------------------------------

export type AssetRow = { path: string; kind: string; bytes: number; updated_at: string; generated: boolean };

export function AssetLibrary({ projectId, onOpenFile }: { projectId: string; onOpenFile?: (path: string) => void }) {
  const [assets, setAssets] = useState<{ images: AssetRow[]; files: AssetRow[]; generatedCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAssets(await rpc<{ images: AssetRow[]; files: AssetRow[]; generatedCount: number }>("project_assets", { project_id: projectId }));
      setError(null);
    } catch {
      setError("Assets could not be loaded.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <ImageIcon size={14} className="text-accent" />
        <p className="eyebrow flex-1 text-ink-3">Assets</p>
        <button type="button" onClick={() => void load()} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-ink-2 hover:bg-surface-2">
          <FolderOpen size={12} /> Refresh
        </button>
      </header>
      {error ? <div className="px-3.5 py-3"><Alert tone="danger">{error}</Alert></div> : null}
      {!assets && !error ? <p className="px-3.5 py-3 text-[12px] text-ink-3"><Spinner className="mr-1.5 inline h-3 w-3" />Reading project files…</p> : null}
      {assets ? (
        <div className="grid gap-3 p-3.5 sm:grid-cols-2">
          <div>
            <p className="eyebrow text-ink-3">Images {assets.images.length ? `· ${assets.images.length}` : ""}</p>
            {assets.images.length ? (
              <ul className="mt-1.5 grid gap-1.5">
                {assets.images.map((asset) => (
                  <li key={asset.path}>
                    <button
                      type="button"
                      onClick={() => onOpenFile?.(asset.path)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2 py-1.5 text-left hover:border-accent/40"
                    >
                      {/* The in-app preview route streams the stored bytes, so the
                          thumbnail is the real asset, never a placeholder image. */}
                      <img
                        src={`/api/projects/${projectId}/preview/${asset.path}`}
                        alt=""
                        loading="lazy"
                        className="h-8 w-8 shrink-0 rounded object-cover"
                        onError={(event) => {
                          (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11.5px] text-ink">{asset.path}</span>
                        <span className="block text-[10.5px] text-ink-3">
                          {formatBytes(asset.bytes)} · {relativeTime(asset.updated_at)}
                        </span>
                      </span>
                      {asset.generated ? <span className="shrink-0 rounded-full border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-accent">AI</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11.5px] text-ink-3">No images in this project yet.</p>
            )}
          </div>
          <div>
            <p className="eyebrow text-ink-3">Fonts &amp; media</p>
            {assets.files.length ? (
              <ul className="mt-1.5 grid gap-1">
                {assets.files.map((asset) => (
                  <li key={asset.path}>
                    <button type="button" onClick={() => onOpenFile?.(asset.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{asset.path}</span>
                      <span className="shrink-0 text-[10.5px] text-ink-3">{formatBytes(asset.bytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[11.5px] text-ink-3">No fonts or media files.</p>
            )}
            {assets.generatedCount ? <p className="mt-2 text-[11px] text-ink-3">{assets.generatedCount} asset{assets.generatedCount === 1 ? "" : "s"} generated by Together AI for this project — reused, never regenerated for the same prompt.</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
