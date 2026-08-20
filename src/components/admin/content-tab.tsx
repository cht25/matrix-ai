"use client";

import { useEffect, useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { Alert, Badge, Button, Card, Input, Select, Spinner, Textarea } from "@/components/ui";
import { formatDate } from "@/lib/utils";

type Article = {
  id: string; title: string; slug: string; category_id: string | null;
  status: string; last_verified: string; source_name: string;
};
type Category = { id: string; name: string };

export function ContentTab({ codes }: { codes: string[] }) {
  const canManage = codes.includes("content.manage");
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filter, setFilter] = useState("all");
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const [a, c] = await Promise.all([
        rpc<Article[]>("admin_articles"),
        rpc<Category[]>("admin_categories"),
      ]);
      setArticles(a ?? []);
      setCategories(c ?? []);
    } catch {
      setArticles([]);
      setCategories([]);
    }
  }

  useEffect(() => { if (canManage) void load(); }, [canManage]);

  async function toggleStatus(article: Article) {
    const next = article.status === "active" ? "inactive" : "active";
    try {
      await rpc("article_status", { id: article.id, status: next });
      await rpc("log_audit", { action: "scam_article_status_changed", target_type: "scam_articles", target_id: article.id, reason: `→ ${next}` }).catch(() => {});
      setMsg(`"${article.title}" is now ${next}. Audit logged.`);
    } catch (err) {
      setMsg(err instanceof RpcCallError ? err.code : "UPDATE_FAILED");
    }
    void load();
  }

  if (!canManage) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>content.manage</strong> permission (content_admin / super_admin).</p></Card>;
  }
  if (!articles) return <Card className="flex items-center gap-2 text-ink-3"><Spinner /> Loading…</Card>;

  const visible = articles.filter((a) => filter === "all" || a.status === filter);

  return (
    <div className="space-y-4">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold text-ink">Scam articles ({visible.length})</h2>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-36">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="review">Review</option>
          </Select>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          Only <strong>active</strong> articles are visible to users. Changes are audited. Articles carry
          verification timestamps and source names — the AI never invents reporting guidance.
        </p>
        <ul className="mt-3 space-y-2">
          {visible.map((a) => {
            const cat = categories.find((c) => c.id === a.category_id);
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-bg px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{a.title}</p>
                  <p className="text-xs text-ink-3">
                    {cat?.name ?? "uncategorised"} · verified {a.last_verified?.slice(0, 10)} · {a.source_name || "no source"}
                  </p>
                </div>
                <Badge className={a.status === "active" ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface text-ink-3"}>{a.status}</Badge>
                <Button variant="outline" onClick={() => void toggleStatus(a)} className="!px-3 !py-1.5 text-xs">
                  {a.status === "active" ? "Deactivate" : "Activate"}
                </Button>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card className="!p-4 text-sm text-ink-3">
        Course, lesson and quiz content is managed through the same content.manage permission via the
        database (or the Firebase console). Editing UI for those lives in the database-backed
        admin API — see the README for the migration workflow.
      </Card>
    </div>
  );
}

type Grant = { id: string; target_user_id: string; scope: string; reason: string; status: string; expires_at: string; created_at: string };

export function GrantsTab({ codes }: { codes: string[] }) {
  const canAccess = codes.includes("privacy.access");
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [targetUser, setTargetUser] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("24");
  const [msg, setMsg] = useState<string | null>(null);
  const [convList, setConvList] = useState<{ id: string; title: string; updated_at: string; is_temporary: boolean }[] | null>(null);
  const [activeGrant, setActiveGrant] = useState<string | null>(null);
  const [conversationView, setConversationView] = useState<{ role: string; content: string }[] | null>(null);

  async function load() {
    try {
      const data = await rpc<Grant[]>("admin_grants");
      setGrants(data ?? []);
    } catch {
      setGrants([]);
    }
  }

  useEffect(() => { if (canAccess) void load(); }, [canAccess]);

  async function requestGrant() {
    if (!targetUser.trim() || reason.trim().length < 10) {
      setMsg("Enter a target user id and a reason (at least 10 characters) — both are required.");
      return;
    }
    let grantId: string;
    try {
      grantId = await rpc<string>("request_admin_access", {
        target_user_id: targetUser.trim(),
        scope: "conversations",
        reason: reason.trim(),
        duration_hours: parseInt(duration, 10),
      });
    } catch (err) {
      setMsg(err instanceof RpcCallError ? err.code : "REQUEST_FAILED");
      return;
    }
    setMsg(`Grant created (${grantId}). Listing the user's conversations…`);
    setActiveGrant(String(grantId));
    try {
      const convs = await rpc<{ id: string; title: string; updated_at: string; is_temporary: boolean }[]>("admin_list_conversations", { grant_id: String(grantId) });
      setConvList(convs ?? []);
    } catch {
      setConvList([]);
    }
    setGrants(null);
    void load();
  }

  async function viewConversation(grantId: string, conversationId: string) {
    try {
      const data = await rpc<{ role: string; content: string }[]>("admin_view_conversation", { grant_id: grantId, conversation_id: conversationId });
      setConversationView(data ?? []);
    } catch (err) {
      setMsg(err instanceof RpcCallError ? err.code : "VIEW_FAILED");
    }
  }

  if (!canAccess) {
    return <Card><p className="text-sm text-ink-3">You need the <strong>privacy.access</strong> permission.</p></Card>;
  }

  return (
    <div className="space-y-4">
      {msg ? <Alert tone="info">{msg}</Alert> : null}

      <Card>
        <h2 className="font-bold text-ink">Request privileged access to a user's conversations</h2>
        <p className="mt-1 text-sm text-ink-3">
          Time-limited (default 24h), reason-required, fully audited. Conversations are never shown by default.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Input value={targetUser} onChange={(e) => setTargetUser(e.target.value)} placeholder="Target user id (UUID)" />
          <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option value="1">1 hour</option>
            <option value="24">24 hours</option>
            <option value="72">72 hours</option>
            <option value="168">7 days (max)</option>
          </Select>
        </div>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required, min 10 chars) — this is audited" rows={2} className="mt-3" />
        <Button onClick={() => void requestGrant()} className="mt-3">Request access</Button>
      </Card>

      {convList && activeGrant ? (
        <Card>
          <h3 className="font-bold text-ink">Conversations of the target user</h3>
          {convList.length === 0 ? <p className="mt-2 text-sm text-ink-3">No conversations found.</p> : (
            <ul className="mt-3 space-y-2">
              {convList.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 rounded-xl bg-bg px-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-ink">{c.title} {c.is_temporary ? <Badge className="ml-1 border-warning/30 bg-warning-soft text-warning">temporary</Badge> : null}</p>
                    <p className="text-xs text-ink-3">{formatDate(c.updated_at)}</p>
                  </div>
                  <Button variant="outline" onClick={() => void viewConversation(activeGrant, c.id)} className="!px-3 !py-1.5 text-xs">View messages</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {conversationView ? (
        <Card>
          <h3 className="font-bold text-ink">Conversation transcript</h3>
          <div className="mt-3 space-y-2">
            {conversationView.map((m, i) => (
              <div key={i} className={`rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-accent-soft text-ink" : "bg-bg text-ink-2"}`}>
                <span className="mr-2 text-xs font-bold uppercase text-ink-3">{m.role}</span>
                {m.content}
              </div>
            ))}
          </div>
          <button onClick={() => setConversationView(null)} className="mt-3 text-sm font-semibold text-accent">Close transcript</button>
        </Card>
      ) : null}

      {grants && grants.length > 0 ? (
        <Card>
          <h2 className="font-bold text-ink">Recent grants</h2>
          <ul className="mt-3 space-y-2">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-xl bg-bg px-3 py-2.5 text-sm">
                <div>
                  <p className="font-medium text-ink">→ {g.target_user_id.slice(0, 8)} · {g.scope}</p>
                  <p className="text-xs text-ink-3">{g.reason} · expires {formatDate(g.expires_at)}</p>
                </div>
                <Badge className={g.status === "active" ? "border-success/30 bg-success-soft text-success" : "border-border bg-surface text-ink-3"}>{g.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
