// =============================================================================
// MATRIX AI — Export my data (spec §40)
// Generates a JSON export of the user's own data, stores it in the private
// `exports` bucket with a short-lived signed URL, and logs a security event.
// Never includes auth secrets, tokens, or internal configuration.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, handleCors } from "../_shared/cors.ts";

const SIGNED_URL_TTL = 60 * 60 * 24 * 7; // 7 days

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

    // Collect the user's own data (safe fields only — no auth secrets).
    const [profile, conversations, memories, progress, attempts, certificates, settings, analyses, reports, events] =
      await Promise.all([
        sb.from("profiles").select("id, full_name, email, date_of_birth, age_verified, school_name, class_grade, country, phone, created_at, updated_at").eq("id", userId).maybeSingle(),
        sb.from("conversations").select("id, title, is_temporary, summary, archived_at, created_at, updated_at, conversation_messages(role, content, created_at)").eq("user_id", userId).neq("is_temporary", true),
        sb.from("user_memories").select("memory, source, created_at").eq("user_id", userId),
        sb.from("course_progress").select("lesson_id, status, progress, completed_at, updated_at").eq("user_id", userId),
        sb.from("quiz_attempts").select("quiz_id, score_percent, passed, completed_at").eq("user_id", userId),
        sb.from("certificates").select("certificate_id, course_id, issued_at, verification_status").eq("user_id", userId),
        sb.from("user_security_settings").select("memory_enabled, chat_history_enabled, notifications_email, notifications_push, notifications_security_alerts").eq("user_id", userId).maybeSingle(),
        sb.from("security_analyses").select("analysis_type, risk_level, confidence, recommendation, created_at").eq("user_id", userId),
        sb.from("scam_reports").select("category_id, platform, description, money_lost, account_compromised, personal_information_shared, country, status, created_at").eq("user_id", userId),
        sb.from("security_events").select("event_type, metadata, created_at").eq("user_id", userId),
      ]);

    const exportPayload = {
      platform: "MATRIX AI",
      generated_at: new Date().toISOString(),
      user: {
        id: profile.data?.id,
        full_name: profile.data?.full_name,
        email: profile.data?.email,
        date_of_birth: profile.data?.date_of_birth,
        age_verified: profile.data?.age_verified,
        school_name: profile.data?.school_name,
        class_grade: profile.data?.class_grade,
        country: profile.data?.country,
        phone: profile.data?.phone,
        created_at: profile.data?.created_at,
      },
      conversations: conversations.data ?? [],
      memories: memories.data ?? [],
      course_progress: progress.data ?? [],
      quiz_attempts: attempts.data ?? [],
      certificates: certificates.data ?? [],
      security_settings: settings.data ?? null,
      security_analyses: analyses.data ?? [],
      scam_reports: reports.data ?? [],
      security_events: events.data ?? [],
    };

    const fileName = `export-${new Date().toISOString().slice(0, 10)}.json`;
    const path = `${userId}/${fileName}`;
    const { error: upErr } = await sb.storage
      .from("exports")
      .upload(path, JSON.stringify(exportPayload, null, 2), { contentType: "application/json", upsert: true });
    if (upErr) return jsonResponse({ error: "EXPORT_UPLOAD_FAILED", detail: upErr.message }, 500);

    const { data: signed, error: signErr } = await sb.storage
      .from("exports")
      .createSignedUrl(path, SIGNED_URL_TTL);
    if (signErr || !signed) return jsonResponse({ error: "EXPORT_SIGN_FAILED" }, 500);

    // Log event + notification.
    await sb.from("security_events").insert({ user_id: userId, event_type: "data_exported", metadata: { file: fileName } });
    await sb.from("notifications").insert({
      user_id: userId, type: "info", title: "Data export ready",
      body: "Your data export is ready. The download link expires in 7 days.",
      link: "/settings?tab=privacy",
    });

    return jsonResponse({ url: signed.signedUrl, expires_at: new Date(Date.now() + SIGNED_URL_TTL * 1000).toISOString(), file: fileName });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal error";
    return jsonResponse({ error: "INTERNAL", detail: msg.slice(0, 300) }, 500);
  }
});
