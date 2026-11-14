import "server-only";
import type { Db } from "@/lib/firebase/admin";
import { isOwnedChatAudioPath } from "@/lib/ai/audio";
import { deletePrivateAudio } from "@/lib/server/cloudinary";

let nextSweep = 0;
/** Opportunistic bounded cleanup of *new-format*, never-attached voice drafts.
 * Legacy assets have no transcription_status and are deliberately preserved. */
export async function cleanupStaleVoiceDrafts(db: Db, now = Date.now()): Promise<number> {
  if (now < nextSweep) return 0;
  nextSweep = now + 60 * 60_000;
  const snapshot = await db.collection("chat_audio_assets").limit(50).get();
  let removed = 0;
  for (const doc of snapshot.docs) {
    if (removed >= 3) break;
    const data = doc.data();
    const created = data.created_at as { toMillis?: () => number } | undefined;
    if (!data.transcription_status || data.conversation_id || !created?.toMillis || created.toMillis() > now - 24 * 60 * 60_000) continue;
    if (!isOwnedChatAudioPath(String(data.user_id ?? ""), String(data.storage_public_id ?? ""))) continue;
    if (await deletePrivateAudio(data.storage_public_id)) {
      await db.collection("chat_audio_assets").doc(doc.id).delete();
      removed++;
    }
  }
  return removed;
}
