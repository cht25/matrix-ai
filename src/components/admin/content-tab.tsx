"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Alert, Badge, Button, Card, Input, Select, Spinner, Textarea } from "@/components/ui";
import { formatDate } from "@/lib/utils";

type Article = {
  id: string; title: string; slug: string; category_id: string | null;
  status: string; last_verified: string; source_name: string;
};
type Category = { id: string; name: string };

export function ContentTab({ codes }: { codes: Set<string> }) {
  const canManage = codes.has("content.manage");
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filter, setFilter] = useState("all");
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const supabase = createClient();
    const [{ data: a }, { data: c }] = await Promise.all([
      supabase.from("scam_articles").select("id, title, slug, category_id, status, last_verified, source_name").order("title"),
      supabase.from("scam_categories").select("id, name").eq("status", "active"),
    ]);
    setArticles((a ?? []) as Article[]);
    setCategories((c ?? []) as Category[]);
  }

  useEffect(() => { if (canManage) void load(); }, [canManage]);

  async function toggleStatus(article: Article) {
    const supabase = createClient();
    const next = article.status === "active" ? "inactive" : "active";
    const { error } = await supabase.from("scam_articles").update({ status: next, last_verified: new Date().toISOString() }).eq("id", article.id);
    if (error) { setMsg(error.message); return; }
    await supabase.rpc("log_audit", { p_action: "scam_article_status_changed", p_target_type: "scam_articles", p_target_id: article.id, p_reason: `→ ${next}` });
    setMsg(`"${article.title}" is now ${next}. Audit logged.`);
    void load();
  }

  if (!canManage) {
    return <Card><p className="text-sm text-slate-500">You need the <strong>content.manage</strong> permission (content_admin / super_admin).</p></Card>;
  }
  if (!articles) return <Card className="flex items-center gap-2 text-slate-500"><Spinner /> Loading…</Card>;

  const visible = articles.filter((a) => filter === "all" || a.status === filter);

  return (
    <div className="space-y-4">
      {msg ? <Alert tone="info">{msg}</Alert> : null}
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-bold text-slate-900">Scam articles ({visible.length})</h2>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-36">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="review">Review</option>
          </Select>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Only <strong>active</strong> articles are visible to users. Changes are audited. Articles carry
          verification timestamps and source names — the AI never invents reporting guidance.
        </p>
        <ul className="mt-3 space-y-2">
          {visible.map((a) => {
            const cat = categories.find((c) => c.id === a.category_id);
            return (
              <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">{a.title}</p>
                  <p className="text-xs text-slate-400">
                    {cat?.name ?? "uncategorised"} · verified {a.last_verified?.slice(0, 10)} · {a.source_name || "no source"}
                  </p>
                </div>
                <Badge className={a.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-500"}>{a.status}</Badge>
                <Button variant="outline" onClick={() => void toggleStatus(a)} className="!px-3 !py-1.5 text-xs">
                  {a.status === "active" ? "Deactivate" : "Activate"}
                </Button>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card className="!p-4 text-sm text-slate-500">
        Course, lesson and quiz content is managed through the same content.manage permission via the
        database (or the Supabase Studio content editor). Editing UI for those lives in the database-backed
        admin API — see the README for the migration workflow.
      </Card>
    </div>
  );
}

type Grant = { id: string; target_user_id: string; scope: string; reason: string; status: string; expires_at: string; created_at: string };

export function GrantsTab({ codes }: { codes: Set<string> }) {
  const canAccess = codes.has("privacy.access");
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [targetUser, setTargetUser] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("24");
  const [msg, setMsg] = useState<string | null>(null);
  const [convList, setConvList] = useState<{ id: string; title: string; updated_at: string; is_temporary: boolean }[] | null>(null);
  const [activeGrant, setActiveGrant] = useState<string | null>(null);
  const [conversationView, setConversationView] = useState<{ role: string; content: string }[] | null>(null);

  async function load() {
    const supabase = createClient();
    const { data } = await supabase.from("admin_access_grants").select("id, target_user_id, scope, reason, status, expires_at, created_at").order("created_at", { ascending: false }).limit(20);
    setGrants((data ?? []) as Grant[]);
  }

  useEffect(() => { if (canAccess) void load(); }, [canAccess]);

  async function requestGrant() {
    if (!targetUser.trim() || reason.trim().length < 10) {
      setMsg("Enter a target user id and a reason (at least 10 characters) — both are required.");
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.rpc("request_admin_access", {
      p_target_user_id: targetUser.trim(),
      p_scope: "conversations",
      p_reason: reason.trim(),
      p_duration_hours: parseInt(duration, 10),
    });
    if (error) { setMsg(error.message); return; }
    setMsg(`Grant created (${data}). Listing the user's conversations…`);
    setActiveGrant(String(data));
    const { data: convs } = await supabase.rpc("admin_list_conversations", { p_grant_id: String(data) });
    setConvList((convs ?? []) as typeof convList);
    setGrants(null);
    void load();
  }

  async function viewConversation(grantId: string, conversationId: string) {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("admin_view_conversation", { p_grant_id: grantId, p_conversation_id: conversationId });
    if (error) { setMsg(error.message); return; }
    setConversationView((data ?? []) as { role: string; content: string }[]);
  }

  if (!canAccess) {
    return <Card><p className="text-sm text-slate-500">You need the <strong>privacy.access</strong> permission.</p></Card>;
  }

  return (
    <div className="space-y-4">
      {msg ? <Alert tone="info">{msg}</Alert> : null}

      <Card>
        <h2 className="font-bold text-slate-900">Request privileged access to a user's conversations</h2>
        <p className="mt-1 text-sm text-slate-500">
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
          <h3 className="font-bold text-slate-900">Conversations of the target user</h3>
          {convList.length === 0 ? <p className="mt-2 text-sm text-slate-500">No conversations found.</p> : (
            <ul className="mt-3 space-y-2">
              {convList.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-slate-800">{c.title} {c.is_temporary ? <Badge className="ml-1 border-amber-200 bg-amber-50 text-amber-700">temporary</Badge> : null}</p>
                    <p className="text-xs text-slate-400">{formatDate(c.updated_at)}</p>
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
          <h3 className="font-bold text-slate-900">Conversation transcript</h3>
          <div className="mt-3 space-y-2">
            {conversationView.map((m, i) => (
              <div key={i} className={`rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-brand-50 text-brand-900" : "bg-slate-50 text-slate-700"}`}>
                <span className="mr-2 text-xs font-bold uppercase text-slate-400">{m.role}</span>
                {m.content}
              </div>
            ))}
          </div>
          <button onClick={() => setConversationView(null)} className="mt-3 text-sm font-semibold text-brand-600">Close transcript</button>
        </Card>
      ) : null}

      {grants && grants.length > 0 ? (
        <Card>
          <h2 className="font-bold text-slate-900">Recent grants</h2>
          <ul className="mt-3 space-y-2">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <div>
                  <p className="font-medium text-slate-800">→ {g.target_user_id.slice(0, 8)} · {g.scope}</p>
                  <p className="text-xs text-slate-400">{g.reason} · expires {formatDate(g.expires_at)}</p>
                </div>
                <Badge className={g.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-500"}>{g.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
