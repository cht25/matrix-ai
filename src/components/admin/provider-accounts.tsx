"use client";

// Admin → AI configuration → Provider accounts.
//
// Several Groq accounts can be connected. MATRIX sends each request to an
// account that has room, and moves to another one only after the provider has
// reported a limit or an error. This panel shows what the provider last told
// us about each account; a key is never shown again after it is saved.

import { useCallback, useEffect, useState } from "react";
import { rpc } from "@/lib/client/api";
import { errorCodeOf } from "@/lib/admin-errors";
import { Alert, Button, Card, Field, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

type ModelWindow = { model: string; limit_requests: number | null; remaining_requests: number | null; limit_tokens: number | null; remaining_tokens: number | null; cooldown_until: string | null; observed_at: string | null };
type Account = {
  id: string; label: string; source: "env" | "admin"; key_hint: string; enabled: boolean;
  state: "ready" | "rate_limited" | "paused" | "invalid" | "disabled";
  available_at: string | null; last_error: string | null; last_error_at: string | null; last_ok_at: string | null;
  requests_last_minute: number; tokens_last_minute: number; requests_total: number; rotations_away: number; models: ModelWindow[];
};
type Stored = { doc_id: string; id: string; label: string; enabled: boolean; key_hint: string; created_at: string | null; readable: boolean };
type Payload = { accounts: Account[]; stored: Stored[]; can_store: boolean };

const STATE_COPY: Record<Account["state"], { label: string; tone: string }> = {
  ready: { label: "Ready", tone: "border-success/30 bg-success-soft text-success" },
  rate_limited: { label: "At provider limit", tone: "border-warning/30 bg-warning-soft text-warning" },
  paused: { label: "Resting after errors", tone: "border-warning/30 bg-warning-soft text-warning" },
  invalid: { label: "Key rejected", tone: "border-danger/40 bg-danger-soft text-danger" },
  disabled: { label: "Disabled", tone: "border-border bg-surface-2 text-ink-3" },
};

const ERRORS: Record<string, string> = {
  PERMISSION_DENIED: "Your role does not include the system.settings permission.",
  INVALID_API_KEY: "That does not look like a Groq API key. Groq keys start with gsk_.",
  ACCOUNT_EXISTS: "This key is already connected.",
  SECRET_STORAGE_UNAVAILABLE: "Keys cannot be stored encrypted on this deployment. Set PROVIDER_SECRET_KEY, or add the key as GROQ_API_KEY_2 … GROQ_API_KEY_8 in the environment.",
};

function time(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Meter({ label, remaining, limit }: { label: string; remaining: number | null; limit: number | null }) {
  const known = remaining !== null && limit !== null && limit > 0;
  const percent = known ? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))) : 0;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-ink-3">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-ink-2">{known ? `${remaining.toLocaleString()} / ${limit.toLocaleString()}` : "not reported yet"}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`${label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={cn("h-full rounded-full", percent > 25 ? "bg-success" : percent > 0 ? "bg-warning" : known ? "bg-danger" : "bg-transparent")} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function ProviderAccounts() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await rpc<Payload>("admin_provider_accounts_list"));
      setError(null);
    } catch (cause) {
      setError(ERRORS[errorCodeOf(cause)] ?? "Provider accounts could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (id: string, action: string, payload: Record<string, unknown>) => {
    setBusy(id);
    try {
      await rpc(action, payload);
      if (action === "admin_provider_account_add") { setApiKey(""); setLabel(""); }
      await load();
    } catch (cause) {
      setError(ERRORS[errorCodeOf(cause)] ?? "That change could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  if (!data && !error) return <span className="inline-status"><Spinner /> Loading…</span>;
  const accounts = data?.accounts ?? [];
  const storedById = new Map((data?.stored ?? []).map((item) => [item.id, item]));
  const unreadable = (data?.stored ?? []).filter((item) => !item.readable);

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Card className="p-4 sm:p-5">
        <h3 className="text-[14px] font-semibold text-ink">Connected Groq accounts</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          Each request goes to one account. When Groq reports that account is at its limit, the same request continues on another connected account and the limited one is left alone until Groq says it can be used again. Limits shown are the ones Groq returned on the most recent response.
        </p>
        {accounts.length === 0 ? (
          <p className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-3 text-[12.5px] text-ink-2">No account is connected. Add a key below, or set GROQ_API_KEY in the environment.</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {accounts.map((account) => {
              const stored = storedById.get(account.id);
              const copy = STATE_COPY[account.state];
              return (
                <li key={account.id} className="rounded-xl border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{account.label}</span>
                    <span className="font-mono text-[11px] text-ink-3">{account.key_hint}</span>
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", copy.tone)}>{copy.label}</span>
                    <span className="text-[11px] text-ink-3">{account.source === "env" ? "Environment" : "Added here"}</span>
                    {stored ? (
                      <span className="ml-auto flex gap-1.5">
                        <Button variant="ghost" disabled={busy === account.id} onClick={() => void act(account.id, "admin_provider_account_update", { doc_id: stored.doc_id, enabled: !stored.enabled })}>
                          {stored.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button variant="ghost" disabled={busy === account.id} onClick={() => void act(account.id, "admin_provider_account_remove", { doc_id: stored.doc_id })}>Remove</Button>
                      </span>
                    ) : null}
                  </div>
                  <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] sm:grid-cols-4">
                    <div><dt className="text-ink-3">Requests, last minute</dt><dd className="font-mono tabular-nums text-ink">{account.requests_last_minute}</dd></div>
                    <div><dt className="text-ink-3">Tokens, last minute (est.)</dt><dd className="font-mono tabular-nums text-ink">{account.tokens_last_minute.toLocaleString()}</dd></div>
                    <div><dt className="text-ink-3">Last success</dt><dd className="font-mono tabular-nums text-ink">{time(account.last_ok_at)}</dd></div>
                    <div><dt className="text-ink-3">{account.available_at ? "Usable again" : "Moved away from"}</dt><dd className="font-mono tabular-nums text-ink">{account.available_at ? time(account.available_at) : `${account.rotations_away}×`}</dd></div>
                  </dl>
                  {account.models.length ? (
                    <div className="mt-3 grid gap-2.5">
                      {account.models.map((window) => (
                        <div key={window.model} className="rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                          <p className="truncate font-mono text-[11px] text-ink-2">{window.model}{window.cooldown_until ? <span className="ml-2 text-warning">limited until {time(window.cooldown_until)}</span> : null}</p>
                          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                            <Meter label="Requests (RPM window)" remaining={window.remaining_requests} limit={window.limit_requests} />
                            <Meter label="Tokens (TPM window)" remaining={window.remaining_tokens} limit={window.limit_tokens} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2.5 text-[11.5px] text-ink-3">No request has used this account since the server started, so Groq has not reported its limits yet.</p>
                  )}
                  {account.last_error ? <p className="mt-2 break-words text-[11.5px] text-ink-3">Last problem ({time(account.last_error_at)}): {account.last_error}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
        {unreadable.length ? (
          <div className="mt-3"><Alert tone="warning">{unreadable.length} saved key{unreadable.length === 1 ? "" : "s"} cannot be decrypted with this deployment&apos;s secret ({unreadable.map((item) => item.label).join(", ")}). Remove and add {unreadable.length === 1 ? "it" : "them"} again.</Alert></div>
        ) : null}
      </Card>

      <Card className="p-4 sm:p-5">
        <h3 className="text-[14px] font-semibold text-ink">Add an account</h3>
        {data && !data.can_store ? (
          <div className="mt-3"><Alert tone="warning">{ERRORS.SECRET_STORAGE_UNAVAILABLE}</Alert></div>
        ) : (
          <form
            className="mt-3 grid gap-3 sm:grid-cols-[1fr_1.6fr_auto] sm:items-end"
            onSubmit={(event) => { event.preventDefault(); void act("new", "admin_provider_account_add", { label, api_key: apiKey }); }}
          >
            <Field label="Name" htmlFor="provider-account-label">
              <Input id="provider-account-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Team account 2" maxLength={60} />
            </Field>
            <Field label="Groq API key" htmlFor="provider-account-key" hint="Encrypted before it is stored. It is not shown again.">
              <Input id="provider-account-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="gsk_…" />
            </Field>
            <Button type="submit" disabled={busy === "new" || apiKey.trim().length < 20}>{busy === "new" ? "Saving…" : "Add account"}</Button>
          </form>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">Only connect accounts you are entitled to use for this service. Rotation spreads load across them within each account&apos;s own limits; it does not raise or get around any limit.</p>
      </Card>
    </div>
  );
}
