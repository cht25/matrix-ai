"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Github, GitPullRequestArrow, Link2, Loader2, LogOut, ShieldCheck } from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { Button, Input, Select } from "@/components/ui";

export type GithubStatus = {
  configured: boolean;
  connected: boolean;
  connection?: { login: string; name: string; avatarUrl: string; connectedAt: string } | null;
};

type Repo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  permissions: { push: boolean };
};

export function GithubConnection({ files = [], showPush = false }: { files?: AgentFile[]; showPush?: boolean }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("Apply MATRIX Agent changes");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitUrl, setCommitUrl] = useState<string | null>(null);

  const selectedRepo = useMemo(() => repos.find((repo) => repo.fullName === repository), [repos, repository]);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/github/status", { cache: "no-store" });
      if (!response.ok) throw new Error("status");
      setStatus((await response.json()) as GithubStatus);
    } catch {
      setStatus({ configured: true, connected: false });
      setNotice("GitHub status could not be loaded. Try again.");
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (!showPush || !status?.connected) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/github/repos", { cache: "no-store" });
        if (!response.ok) throw new Error("repos");
        const data = (await response.json()) as { repositories?: Repo[] };
        if (cancelled) return;
        const next = data.repositories ?? [];
        setRepos(next);
        if (next[0]) {
          setRepository((value) => value || next[0].fullName);
          setBranch((value) => value || next[0].defaultBranch);
        }
      } catch {
        if (!cancelled) setNotice("Your repositories could not be loaded. Reconnect GitHub and try again.");
      }
    })();
    return () => { cancelled = true; };
  }, [showPush, status?.connected]);

  useEffect(() => {
    if (selectedRepo) setBranch(selectedRepo.defaultBranch);
  }, [selectedRepo]);

  async function disconnect() {
    if (!confirm("Disconnect GitHub from MATRIX? Generated files will not be deleted.")) return;
    setBusy(true);
    setNotice(null);
    try {
      await fetch("/api/github/status", { method: "DELETE" });
      setStatus((current) => ({ configured: current?.configured ?? true, connected: false }));
      setRepos([]);
    } catch {
      setNotice("GitHub could not be disconnected. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    if (!reviewed || !repository || !branch || !message.trim() || !files.length) return;
    if (!confirm(`Push ${files.length} reviewed file${files.length === 1 ? "" : "s"} to ${repository} on ${branch}?`)) return;
    setBusy(true);
    setNotice(null);
    setCommitUrl(null);
    try {
      const response = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "agent",
          repository,
          branch,
          message: message.trim(),
          files,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; commitUrl?: string; commitSha?: string };
      if (!response.ok || !data.commitUrl) throw new Error(data.error || "push");
      setCommitUrl(data.commitUrl);
      setNotice(`Pushed commit ${data.commitSha?.slice(0, 7) ?? "successfully"}.`);
      setReviewed(false);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice(code.includes("409") ? "The branch changed before the push. Refresh the repository and try again." : "Nothing was pushed. Check repository access and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <div className="flex items-center gap-2 py-4 text-sm text-ink-3"><Loader2 className="animate-spin" size={15} /> Checking GitHub connection…</div>;
  }

  if (!status.configured) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning-soft p-4">
        <p className="text-sm font-semibold text-warning">GitHub connection is not configured</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">The site administrator must add the GitHub OAuth and token-encryption environment variables before direct push can be enabled.</p>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border-strong bg-surface"><Github size={18} /></span>
          <div>
            <p className="text-sm font-semibold text-ink">Connect GitHub</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">Authorise repository access to push files you have reviewed in Agent mode. MATRIX encrypts the OAuth token server-side and never sends it to the AI model.</p>
          </div>
        </div>
        <a href="/api/github/connect" className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-medium text-bg hover:bg-ink-2">
          <Github size={15} /> Continue with GitHub
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {status.connection?.avatarUrl ? <img src={status.connection.avatarUrl} alt="" className="h-8 w-8 rounded-full" /> : <Github size={18} />}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">@{status.connection?.login}</p>
            <p className="flex items-center gap-1 text-[11px] text-success"><ShieldCheck size={11} /> Connected securely</p>
          </div>
        </div>
        <button type="button" onClick={() => void disconnect()} disabled={busy} className="grid h-9 w-9 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger" aria-label="Disconnect GitHub" title="Disconnect GitHub">
          <LogOut size={14} />
        </button>
      </div>

      {showPush ? (
        <div className="space-y-3">
          <div>
            <label htmlFor="agent-repository" className="mb-1.5 block text-xs font-medium text-ink-2">Repository</label>
            <Select id="agent-repository" value={repository} onChange={(event) => setRepository(event.target.value)} disabled={busy || repos.length === 0}>
              {repos.length === 0 ? <option value="">No writable repositories found</option> : repos.map((repo) => <option key={repo.id} value={repo.fullName}>{repo.fullName}{repo.private ? " · private" : ""}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="agent-branch" className="mb-1.5 block text-xs font-medium text-ink-2">Branch</label>
            <Input id="agent-branch" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy} placeholder="main" />
          </div>
          <div>
            <label htmlFor="agent-commit" className="mb-1.5 block text-xs font-medium text-ink-2">Commit message</label>
            <Input id="agent-commit" value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} maxLength={160} />
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-xs leading-relaxed text-ink-2">
            <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} className="mt-0.5 accent-current" />
            <span>I reviewed all {files.length} generated file{files.length === 1 ? "" : "s"} and approve this commit.</span>
          </label>
          <Button onClick={() => void push()} disabled={busy || !reviewed || !files.length || !repository || !branch || !message.trim()} className="w-full">
            {busy ? <Loader2 className="animate-spin" size={15} /> : <GitPullRequestArrow size={15} />}
            Push to GitHub
          </Button>
          {!files.length ? <p className="text-center text-xs text-ink-3">Ask Agent to create or change files before pushing.</p> : null}
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">{commitUrl ? <Check size={12} className="text-success" /> : null}{notice}</span>
          {commitUrl ? <a href={commitUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-accent hover:underline"><Link2 size={11} /> View commit</a> : null}
        </div>
      ) : null}
    </div>
  );
}
