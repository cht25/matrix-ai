"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rpc, signOutEverywhere } from "@/lib/client/api";
import { Alert, Button, Card } from "@/components/ui";

type Memory = { id: string; memory: string; source: string; created_at: string };

export function PrivacyPanel({ settings, memories }: { settings: { memory_enabled: boolean; chat_history_enabled: boolean } | null; memories: Memory[] }) {
  const router = useRouter();
  const [memoryEnabled, setMemoryEnabled] = useState(settings?.memory_enabled ?? true);
  const [historyEnabled, setHistoryEnabled] = useState(settings?.chat_history_enabled ?? true);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle(update: { memory_enabled?: boolean; chat_history_enabled?: boolean }) {
    await rpc("settings_update", update).catch(() => {});
    router.refresh();
  }

  async function deleteMemory(id: string) {
    await rpc("memory_delete", { id }).catch(() => {});
    router.refresh();
  }

  async function clearAllMemories() {
    if (!confirm("Clear all saved memories? This can't be undone.")) return;
    await rpc("memory_delete", { all: true }).catch(() => {});
    router.refresh();
  }

  async function exportData() {
    setBusy(true);
    setMsg(null);
    try {
      // Direct JSON download from /api/account/export (the server logs a
      // security event + notification for the export).
      const res = await fetch("/api/account/export", { credentials: "same-origin" });
      if (!res.ok) {
        setMsg({ tone: "danger", text: "Export failed. Please try again." });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `matrix-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ tone: "success", text: "Your export is downloading." });
    } finally {
      setBusy(false);
    }
  }

  async function requestDeletion() {
    if (!confirm("This will permanently delete your account, conversations, memories, certificates and files. Continue?")) return;
    const password = prompt("Re-authenticate: enter your password to confirm deletion.");
    if (!password) return;
    setBusy(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ confirm: "DELETE", password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({
          tone: "danger",
          text: body.error === "REAUTH_FAILED" ? "Re-authentication failed — deletion cancelled." : "Deletion failed. Please contact support.",
        });
        setBusy(false);
        return;
      }
    } catch {
      setMsg({ tone: "danger", text: "Deletion failed. Please contact support." });
      setBusy(false);
      return;
    }
    await signOutEverywhere().catch(() => {});
    window.location.href = "/";
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-bold text-ink">AI memory</h2>
            <p className="mt-1 text-sm text-ink-3">
              MATRIX AI can remember safe facts like "you are a beginner" to personalise help.
              It never stores passwords, codes, IDs or contact details.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={memoryEnabled}
            onClick={() => { setMemoryEnabled(!memoryEnabled); void toggle({ memory_enabled: !memoryEnabled }); }}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${memoryEnabled ? "bg-accent" : "bg-surface-3"}`}
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-surface transition-all ${memoryEnabled ? "left-6" : "left-1"}`} />
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-bold text-ink">Save chat history</h2>
            <p className="mt-1 text-sm text-ink-3">When off, new chats behave like temporary chats — nothing is kept.</p>
          </div>
          <button
            role="switch"
            aria-checked={historyEnabled}
            onClick={() => { setHistoryEnabled(!historyEnabled); void toggle({ chat_history_enabled: !historyEnabled }); }}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${historyEnabled ? "bg-accent" : "bg-surface-3"}`}
          >
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-surface transition-all ${historyEnabled ? "left-6" : "left-1"}`} />
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-ink">Saved memories ({memories.length})</h2>
          {memories.length > 0 ? (
            <Button variant="danger" onClick={() => void clearAllMemories()} className="!px-3 !py-1.5 text-xs">Clear all</Button>
          ) : null}
        </div>
        {memories.length === 0 ? (
          <p className="mt-2 text-sm text-ink-3">No memories saved yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {memories.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 rounded-xl bg-bg px-3 py-2.5 text-sm">
                <span className="text-ink-2">{m.memory}</span>
                <button onClick={() => void deleteMemory(m.id)} className="shrink-0 text-xs font-semibold text-red-500 hover:text-danger">Delete</button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="font-bold text-ink">Export my data</h2>
        <p className="mt-1 text-sm text-ink-3">
          Download everything you've created: profile, conversations, progress, certificates and settings.
          The export never includes passwords, tokens or internal secrets.
        </p>
        <Button onClick={() => void exportData()} disabled={busy} className="mt-3">{busy ? "Preparing…" : "Create export file"}</Button>
      </Card>

      <Card className="border-danger/30">
        <h2 className="font-bold text-danger">Delete my account</h2>
        <p className="mt-1 text-sm text-ink-3">
          Permanently deletes your profile, chats, memories, progress, certificates, reports and files.
          You will be asked to re-authenticate first. This cannot be undone.
        </p>
        <Button variant="danger" onClick={() => void requestDeletion()} disabled={busy} className="mt-3">{busy ? "Working…" : "Delete account"}</Button>
      </Card>

      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </div>
  );
}
