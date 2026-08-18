// =============================================================================
// MATRIX AI — Auth events webhook (spec §34, §47)
//
// Receives Supabase Auth webhook events (login, logout, password changes,
// identity creation) and records them as security_events + user_sessions.
// The webhook secret is verified server-side (HMAC-SHA256).
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, handleCors } from "../_shared/cors.ts";

function sha256Hex(data: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)).then((buf) => {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });
}

async function verifyWebhook(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("SUPABASE_WEBHOOK_SECRET") ?? "";
  if (!secret) return false;

  // Legacy header: x-supabase-webhook-secret
  if (req.headers.get("x-supabase-webhook-secret") === secret) return true;

  // Modern header: x-supabase-webhook-signature: t=<ts>,v1=<hmac-sha256-hex>
  const sigHeader = req.headers.get("x-supabase-webhook-signature") ?? "";
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => {
    const [k, ...v] = p.split("=");
    return [k, v.join("=")];
  }));
  if (!parts.t || !parts.v1) return false;
  const expected = await sha256Hex(`${parts.t}.${rawBody}`);
  return expected === parts.v1.toLowerCase();
}

function hashIp(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",")[0].trim();
  if (!ip) return Promise.resolve("");
  return sha256Hex(ip).then((h) => h.slice(0, 16));
}

// Map Supabase Auth events to our security event vocabulary.
const EVENT_MAP: Record<string, { event: string; session: boolean }> = {
  "user.signed_in": { event: "login", session: true },
  "user.signed_out": { event: "logout", session: true },
  "user.password_recovery_requested": { event: "password_reset", session: false },
  "user.password_updated": { event: "password_changed", session: false },
  "user.updated": { event: "email_changed", session: false },
  "user.identity_created": { event: "new_device", session: true },
  "user.identity_linked": { event: "new_device", session: false },
  "user.deleted": { event: "account_locked", session: false },
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const rawBody = await req.text();
    if (!(await verifyWebhook(req, rawBody))) {
      return jsonResponse({ error: "INVALID_SIGNATURE" }, 401);
    }

    const body = JSON.parse(rawBody) as {
      type?: string;
      table?: string;
      record?: { id?: string; user_id?: string; email?: string; created_at?: string };
      old_record?: Record<string, unknown>;
    };

    const userId = body.record?.id ?? body.record?.user_id;
    if (!userId) return jsonResponse({ ok: false, reason: "no_user" }, 200);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

    const ipHash = await hashIp(req);
    const ua = (req.headers.get("user-agent") ?? "").slice(0, 300);

    if (body.type === "user.deleted") {
      await sb.from("audit_logs").insert({ actor_id: null, action: "auth_user_deleted", target_type: "user", target_id: userId });
      return jsonResponse({ ok: true }, 200);
    }

    const mapping = EVENT_MAP[body.type ?? ""];
    if (!mapping) return jsonResponse({ ok: false, reason: "unmapped_event" }, 200);

    if (mapping.session) {
      await sb.from("user_sessions").insert({
        user_id: userId,
        session_ref: `evt-${body.record?.created_at ?? Date.now()}`,
        device_name: ua.slice(0, 60),
        ip_hash: ipHash,
        user_agent: ua,
      });
    }

    await sb.from("security_events").insert({
      user_id: userId,
      event_type: mapping.event,
      metadata: { source: "auth_webhook", event: body.type },
      ip_hash: ipHash,
    });

    // Login alert notification (spec §47).
    if (mapping.event === "login") {
      await sb.from("notifications").insert({
        user_id: userId, type: "security", title: "New login",
        body: "Your account was signed in from a new session. If that was you, great — if not, change your password.",
        link: "/security",
      });
    }

    return jsonResponse({ ok: true }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    return jsonResponse({ error: "INTERNAL", detail: msg.slice(0, 300) }, 500);
  }
});
