import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { isOwnedChatAudioPath } from "@/lib/ai/audio";
import { deletePrivateAudio, downloadPrivateAudio } from "@/lib/server/cloudinary";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const asset = await adminDb().collection("chat_audio_assets").doc(id).get();
  const data = asset.data();
  if (!asset.exists || data?.user_id !== user.uid || data.storage_provider !== "cloudinary") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const publicId = typeof data.storage_public_id === "string" ? data.storage_public_id : "";
  const format = typeof data.storage_format === "string" ? data.storage_format : "";
  if (!isOwnedChatAudioPath(user.uid, publicId) || !format) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const audio = await downloadPrivateAudio(publicId, format);
  if (!audio) return NextResponse.json({ error: "AUDIO_UNAVAILABLE" }, { status: 503 });
  const type = typeof data.mime_type === "string" && data.mime_type.startsWith("audio/") ? data.mime_type.split(";")[0] : audio.contentType;
  return new NextResponse(new Uint8Array(audio.bytes), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(audio.bytes.length),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const db = adminDb();
  const ref = db.collection("chat_audio_assets").doc(id);
  const asset = await ref.get();
  const data = asset.data();
  if (!asset.exists || data?.user_id !== user.uid || data.storage_provider !== "cloudinary") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const publicId = typeof data.storage_public_id === "string" ? data.storage_public_id : "";
  if (!isOwnedChatAudioPath(user.uid, publicId)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const deleted = await deletePrivateAudio(publicId);
  if (!deleted) return NextResponse.json({ error: "AUDIO_DELETE_FAILED" }, { status: 502 });
  if (typeof data.conversation_id === "string" && typeof data.message_id === "string") {
    await db.collection("conversations").doc(data.conversation_id).collection("messages").doc(data.message_id)
      .update({ "metadata.audio_asset_id": FieldValue.delete() }).catch(() => {});
  }
  await ref.delete();
  return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "private, no-store" } });
}
