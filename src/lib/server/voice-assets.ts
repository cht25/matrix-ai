// Shared checks for sending a stored voice recording as a chat message.
//
// A recording can be attached to exactly one message, only by its owner, and
// only together with the transcript the speech service produced for it — the
// text the model answers is always the text the user can read back.

import "server-only";
import type { Db } from "@/lib/firebase/admin";

export type VoiceMessageMetadata = {
  audio_asset_id: string;
  audio_duration_ms: number;
  audio_waveform: number[];
  audio_language: string | null;
};

export type VoiceAssetCheck =
  | { ok: true; metadata: VoiceMessageMetadata }
  | { ok: false; code: "AUDIO_NOT_FOUND" | "AUDIO_TRANSCRIPT_MISMATCH" | "AUDIO_ALREADY_SENT" };

export const VOICE_ASSET_ID = /^[a-f0-9-]{36}$/i;

export async function sendableVoiceAsset(d: Db, uid: string, assetId: string, transcript: string): Promise<VoiceAssetCheck> {
  if (!VOICE_ASSET_ID.test(assetId)) return { ok: false, code: "AUDIO_NOT_FOUND" };
  const snapshot = await d.collection("chat_audio_assets").doc(assetId).get().catch(() => null);
  const saved = snapshot?.data();
  if (!snapshot?.exists || !saved || saved.user_id !== uid) return { ok: false, code: "AUDIO_NOT_FOUND" };
  if (saved.conversation_id) return { ok: false, code: "AUDIO_ALREADY_SENT" };
  if (saved.transcription_status !== "complete" || typeof saved.transcript !== "string" || saved.transcript.trim() !== transcript.trim()) {
    return { ok: false, code: "AUDIO_TRANSCRIPT_MISMATCH" };
  }
  return {
    ok: true,
    metadata: {
      audio_asset_id: assetId,
      audio_duration_ms: Number(saved.duration_ms ?? 0) || 0,
      audio_waveform: Array.isArray(saved.waveform) ? saved.waveform.slice(0, 64) : [],
      audio_language: typeof saved.detected_language === "string" ? saved.detected_language : null,
    },
  };
}
