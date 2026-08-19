// POST /api/account/delete — self-service account deletion (spec §41).
// Flow: client re-authenticates (password sent here and verified against
// Firebase Auth) → confirm:"DELETE" → server removes storage, deletes every
// user-owned Firestore document, writes an audit row, then deletes the Auth
// user. Scam reports are fully deleted (policy: the public library lives in
// scam_articles, not in user reports).

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb, adminBucket } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { nowTs } from "@/lib/firebase/admin";
import { env, isAiConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_FOLDERS = ["security-screenshots", "identity-documents", "chat-attachments", "exports", "avatars"];

async function deleteQuery(collection: FirebaseFirestore.CollectionReference, field: string, value: string, limit = 500) {
  let deleted = 0;
  for (let i = 0; i < 20; i++) {
    const snap = await collection.where(field, "==", value).limit(limit).get();
    if (snap.empty) break;
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
    deleted += snap.size;
    if (snap.size < limit) break;
  }
  return deleted;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { confirm?: string; password?: string };
  if (body.confirm !== "DELETE") return NextResponse.json({ error: "CONFIRMATION_REQUIRED" }, { status: 400 });
  if (!body.password || !user.email) return NextResponse.json({ error: "REAUTH_REQUIRED" }, { status: 401 });

  // Verify the password against Firebase Auth (server-side re-auth).
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.firebasePublic.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: body.password, returnSecureToken: false }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as { localId?: string; error?: { message?: string } };
    if (!res.ok || data.localId !== user.uid) {
      return NextResponse.json({ error: "REAUTH_FAILED", detail: data.error?.message ?? "" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "REAUTH_UNAVAILABLE" }, { status: 503 });
  }
  void isAiConfigured;

  const d = adminDb();
  const uid = user.uid;

  // 1. Remove private storage objects owned by the user.
  try {
    const bucket = adminBucket();
    for (const folder of PRIVATE_FOLDERS) {
      const [files] = await bucket.getFiles({ prefix: `${folder}/${uid}/`, maxResults: 500 });
      if (files.length) await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    }
  } catch {
    /* storage failures must not block account deletion */
  }

  // 2. Delete user-owned documents (conversations cascade their messages).
  const convs = await d.collection("conversations").where("user_id", "==", uid).limit(500).get();
  for (const c of convs.docs) {
    const messages = await c.ref.collection("messages").listDocuments();
    await Promise.all(messages.map((m) => m.delete()));
    await d.collection("conversation_summaries").doc(c.id).delete({ exists: false }).catch(() => {});
    await c.ref.delete();
  }
  await Promise.all([
    d.collection("profiles").doc(uid).delete(),
    d.collection("user_security_settings").doc(uid).delete(),
    d.collection("guardian_consents").doc(uid).delete(),
    d.collection("admin_role_assignments").doc(uid).delete(),
  ]);
  await Promise.all([
    deleteQuery(d.collection("user_memories"), "user_id", uid),
    deleteQuery(d.collection("attachments"), "user_id", uid),
    deleteQuery(d.collection("security_analyses"), "user_id", uid),
    deleteQuery(d.collection("scam_reports"), "user_id", uid),
    deleteQuery(d.collection("quiz_attempts"), "user_id", uid),
    deleteQuery(d.collection("course_progress"), "user_id", uid),
    deleteQuery(d.collection("certificates"), "user_id", uid),
    deleteQuery(d.collection("identity_verifications"), "user_id", uid),
    deleteQuery(d.collection("notifications"), "user_id", uid),
    deleteQuery(d.collection("security_events"), "user_id", uid),
    deleteQuery(d.collection("user_sessions"), "user_id", uid),
    deleteQuery(d.collection("ai_usage_logs"), "user_id", uid),
  ]);

  // 3. Audit (actor disappears after delete — log first).
  await d.collection("audit_logs").add({
    actor_id: null,
    action: "account_deleted",
    target_type: "user",
    target_id: uid,
    reason: "user requested deletion",
    metadata: { self_service: true },
    created_at: nowTs(),
  });

  // 4. Delete the Auth account + revoke everything.
  await adminAuth().revokeRefreshTokens(uid);
  await adminAuth().deleteUser(uid);

  const res = NextResponse.json({ ok: true, message: "Account deleted" });
  res.cookies.set("__session", "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
