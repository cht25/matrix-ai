// GET /api/account/export — GDPR-style export of the user's own data.
// Returns a JSON download (safe fields only — never auth secrets). Also
// logs a security event + notification (port of the export-data function).

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { nowTs } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const iso = (v: unknown): string => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  if (ts?.toDate) return ts.toDate().toISOString();
  return typeof v === "string" ? v : "";
};

export async function GET(_req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const d = adminDb();

  const [profile, convs, memories, progress, attempts, certificates, settings, analyses, reports, events, github] = await Promise.all([
    d.collection("profiles").doc(user.uid).get(),
    d.collection("conversations").where("user_id", "==", user.uid).where("is_temporary", "==", false).get(),
    d.collection("user_memories").where("user_id", "==", user.uid).get(),
    d.collection("course_progress").where("user_id", "==", user.uid).get(),
    d.collection("quiz_attempts").where("user_id", "==", user.uid).get(),
    d.collection("certificates").where("user_id", "==", user.uid).get(),
    d.collection("user_security_settings").doc(user.uid).get(),
    d.collection("security_analyses").where("user_id", "==", user.uid).get(),
    d.collection("scam_reports").where("user_id", "==", user.uid).get(),
    d.collection("security_events").where("user_id", "==", user.uid).get(),
    d.collection("github_connections").doc(user.uid).get(),
  ]);

  const conversations = await Promise.all(
    convs.docs.map(async (c) => {
      const messages = await c.ref.collection("messages").orderBy("created_at", "asc").get();
      return {
        id: c.id,
        title: c.data().title,
        is_temporary: c.data().is_temporary ?? false,
        mode: c.data().mode === "agent" ? "agent" : "general",
        summary: c.data().summary ?? "",
        archived_at: c.data().archived_at ? iso(c.data().archived_at) : null,
        created_at: iso(c.data().created_at),
        updated_at: iso(c.data().updated_at),
        conversation_messages: messages.docs.map((m) => ({
          role: m.data().role,
          content: m.data().content,
          metadata: m.data().metadata ?? {},
          created_at: iso(m.data().created_at),
        })),
      };
    }),
  );

  const p = profile.data();
  const payload = {
    platform: "MATRIX AI",
    generated_at: new Date().toISOString(),
    user: {
      id: profile.id,
      full_name: p?.full_name ?? "",
      email: p?.email ?? "",
      date_of_birth: p?.date_of_birth ?? "",
      age_verified: p?.age_verified ?? false,
      school_name: p?.school_name ?? "",
      class_grade: p?.class_grade ?? "",
      country: p?.country ?? "",
      phone: p?.phone ?? "",
      created_at: p ? iso(p.created_at) : "",
    },
    conversations,
    memories: memories.docs.map((m) => ({ memory: m.data().memory, source: m.data().source ?? "ai", created_at: iso(m.data().created_at) })),
    course_progress: progress.docs.map((x) => ({ lesson_id: x.data().lesson_id, status: x.data().status, progress: x.data().progress ?? 0, completed_at: x.data().completed_at ? iso(x.data().completed_at) : null, updated_at: iso(x.data().updated_at) })),
    quiz_attempts: attempts.docs.map((x) => ({ quiz_id: x.data().quiz_id, score_percent: x.data().score_percent, passed: x.data().passed, completed_at: iso(x.data().completed_at) })),
    certificates: certificates.docs.map((x) => ({ certificate_id: x.data().certificate_id, course_id: x.data().course_id, issued_at: iso(x.data().issued_at), verification_status: x.data().verification_status })),
    security_settings: settings.data()
      ? {
          memory_enabled: settings.data()!.memory_enabled ?? true,
          chat_history_enabled: settings.data()!.chat_history_enabled ?? true,
          notifications_email: settings.data()!.notifications_email ?? true,
          notifications_push: settings.data()!.notifications_push ?? false,
          notifications_security_alerts: settings.data()!.notifications_security_alerts ?? true,
        }
      : null,
    security_analyses: analyses.docs.map((x) => ({ analysis_type: x.data().analysis_type, risk_level: x.data().risk_level, confidence: x.data().confidence ?? 0, recommendation: x.data().recommendation ?? "", created_at: iso(x.data().created_at) })),
    scam_reports: reports.docs.map((x) => ({ category_id: x.data().category_id, platform: x.data().platform ?? "", description: x.data().description, money_lost: x.data().money_lost ?? 0, account_compromised: x.data().account_compromised ?? false, personal_information_shared: x.data().personal_information_shared ?? false, country: x.data().country ?? "", status: x.data().status, created_at: iso(x.data().created_at) })),
    security_events: events.docs.map((x) => ({ event_type: x.data().event_type, metadata: x.data().metadata ?? {}, created_at: iso(x.data().created_at) })),
    github_connection: github.exists
      ? { login: github.data()?.login ?? "", connected_at: iso(github.data()?.connected_at) }
      : null,
  };

  await Promise.all([
    d.collection("security_events").add({ user_id: user.uid, event_type: "data_exported", metadata: { file: "inline-download" }, ip_hash: "", created_at: nowTs() }),
    d.collection("notifications").add({ user_id: user.uid, type: "info", title: "Data export downloaded", body: "Your data export was generated and downloaded.", link: "/settings?tab=privacy", read_at: null, created_at: nowTs() }),
  ]);

  const fileName = `matrix-export-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
