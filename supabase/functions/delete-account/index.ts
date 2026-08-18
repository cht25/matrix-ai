// =============================================================================
// MATRIX AI — Delete my account (spec §41)
//
// Flow: re-authenticate (done client-side) → confirm ("DELETE") → server-side
// workflow: remove/anonymize applicable records → remove private storage →
// disable account (admin.deleteUser removes auth identity, cascading deletes).
//
// Scam reports are fully deleted for user privacy (a deliberate policy choice:
// the aggregated scam library lives in scam_articles, not in user reports).
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, handleCors } from "../_shared/cors.ts";

const PRIVATE_BUCKETS = ["chat-attachments", "security-screenshots", "identity-documents", "certificates", "exports", "avatars"];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: userData } = await sb.auth.getUser(token);
    const user = userData.user;
    if (!user) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);
    const userId = user.id;

    // Confirmation gate (client re-authenticates before calling).
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "DELETE") return jsonResponse({ error: "CONFIRMATION_REQUIRED" }, 400);

    // 1. Remove all private storage objects owned by the user.
    for (const bucket of PRIVATE_BUCKETS) {
      const { data: objects } = await sb.storage.from(bucket).list(userId, { limit: 1000 });
      if (objects && objects.length > 0) {
        await sb.storage.from(bucket).remove(objects.map((o) => `${userId}/${o.name}`));
      }
    }

    // 2. Remove/anonymize applicable records (RLS bypassed via service role).
    // Conversations cascade-delete their messages and summaries.
    await Promise.all([
      sb.from("conversations").delete().eq("user_id", userId),
      sb.from("user_memories").delete().eq("user_id", userId),
      sb.from("attachments").delete().eq("user_id", userId),
      sb.from("security_analyses").delete().eq("user_id", userId),
      sb.from("scam_reports").delete().eq("user_id", userId),
      sb.from("quiz_attempts").delete().eq("user_id", userId),
      sb.from("course_progress").delete().eq("user_id", userId),
      sb.from("certificates").delete().eq("user_id", userId),
      sb.from("identity_verifications").delete().eq("user_id", userId),
      sb.from("guardian_consents").delete().eq("user_id", userId),
      sb.from("notifications").delete().eq("user_id", userId),
      sb.from("security_events").delete().eq("user_id", userId),
      sb.from("user_sessions").delete().eq("user_id", userId),
      sb.from("ai_usage_logs").delete().eq("user_id", userId),
      sb.from("oauth_profiles").delete().eq("user_id", userId),
      sb.from("user_security_settings").delete().eq("user_id", userId),
    ]);

    // 3. Audit (actor is gone after delete; log before).
    await sb.from("audit_logs").insert({ actor_id: null, action: "account_deleted", target_type: "user", target_id: userId, reason: "user requested deletion", metadata: { self_service: true } });

    // 4. Disable/remove the account (auth.users cascades to profiles).
    const { error: delErr } = await sb.auth.admin.deleteUser(userId);
    if (delErr) return jsonResponse({ error: "ACCOUNT_DELETE_FAILED", detail: delErr.message }, 500);

    return jsonResponse({ ok: true, message: "Account deleted" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    return jsonResponse({ error: "INTERNAL", detail: msg.slice(0, 300) }, 500);
  }
});
