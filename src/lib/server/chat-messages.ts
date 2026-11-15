// =============================================================================
// Conversation message operations (owner-scoped).
//
//   · Regenerate REPLACES the previous assistant reply in place and keeps the
//     earlier answers as versions on the same document — a regenerated turn
//     never becomes a second assistant message after a reload.
//   · Edit & resend rewrites a user message (the original text is kept once).
//   · Delete removes exactly one message the owner chose.
//
// Conversation IDs never change and nothing here touches another user's data:
// every function re-checks ownership against the conversation document.
// =============================================================================

import "server-only";
import { type Db, nowTs } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";
import { isOwnedChatAudioPath } from "@/lib/ai/audio";
import { deletePrivateAudio } from "@/lib/server/cloudinary";
import { millis } from "@/lib/server/sort";

/** Current answer + this many earlier answers are kept per assistant message. */
export const MAX_REPLY_VERSIONS = 5;
/** Firestore documents are capped at 1 MiB; old versions are stored trimmed. */
const MAX_VERSION_CHARS = 40_000;
export const MAX_MESSAGE_CHARS = 12_000;

export type ReplyVersion = {
  content: string;
  created_at: string;
  model?: string;
  provider?: string;
  duration_ms?: number;
};

function isoOf(value: unknown): string {
  const ms = typeof value === "number" ? value : millis(value);
  return new Date(ms > 0 ? ms : Date.now()).toISOString();
}

function isVersion(value: unknown): value is ReplyVersion {
  return Boolean(value) && typeof value === "object" && typeof (value as ReplyVersion).content === "string";
}

/**
 * Versions to store on an assistant message that is about to be overwritten by
 * a regenerated answer: everything already kept, plus the answer being replaced.
 */
export function nextReplyVersions(existing: Record<string, unknown>): ReplyVersion[] {
  const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
  const prior = Array.isArray(metadata.versions) ? metadata.versions.filter(isVersion) : [];
  const content = typeof existing.content === "string" ? existing.content : "";
  if (!content.trim()) return prior.slice(-(MAX_REPLY_VERSIONS - 1));
  const version: ReplyVersion = {
    content: content.slice(0, MAX_VERSION_CHARS),
    created_at: isoOf(existing.updated_at ?? existing.created_at),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.provider === "string" ? { provider: metadata.provider } : {}),
    ...(typeof metadata.duration_ms === "number" ? { duration_ms: metadata.duration_ms } : {}),
  };
  return [...prior, version].slice(-(MAX_REPLY_VERSIONS - 1));
}

/**
 * A regenerate may only overwrite a plain assistant answer. A reply that
 * records real execution (a build run, a deployment, a pending Agent task) is
 * history, not a draft — it is never replaced.
 */
export function isReplaceableReply(data: Record<string, unknown> | undefined): boolean {
  if (!data || data.role !== "assistant") return false;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  return !metadata.build && !metadata.deployment && !metadata.agent_task;
}

async function ownedConversation(d: Db, uid: string, conversationId: string) {
  const ref = d.collection("conversations").doc(conversationId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.user_id !== uid || snap.data()?.deleted_at) throw new RpcError("NOT_FOUND", 404);
  return ref;
}

/** Delete one message. A voice message also releases its private recording. */
export async function deleteConversationMessage(d: Db, uid: string, conversationId: string, messageId: string) {
  const conversation = await ownedConversation(d, uid, conversationId);
  const ref = conversation.collection("messages").doc(messageId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data() ?? {};
  const assetId = typeof data.metadata?.audio_asset_id === "string" ? data.metadata.audio_asset_id : "";
  let audioDeleted = false;
  if (assetId && /^[a-f0-9-]{36}$/i.test(assetId)) {
    // Best-effort: a storage hiccup must not keep the message the owner asked
    // to remove, and a recording that belongs to someone else is never touched.
    try {
      const assetRef = d.collection("chat_audio_assets").doc(assetId);
      const asset = (await assetRef.get()).data();
      const publicId = typeof asset?.storage_public_id === "string" ? asset.storage_public_id : "";
      if (asset?.user_id === uid && isOwnedChatAudioPath(uid, publicId)) {
        audioDeleted = await deletePrivateAudio(publicId);
        if (audioDeleted) await assetRef.delete();
      }
    } catch {
      audioDeleted = false;
    }
  }
  await ref.delete();
  return { deleted: true, id: messageId, role: data.role === "assistant" ? "assistant" : "user", audio_deleted: audioDeleted };
}

/**
 * Rewrite the text of a user message (Edit & resend, or correcting a voice
 * transcript). The first original is preserved in metadata so an edit never
 * silently destroys what the user actually sent.
 */
export async function editUserMessage(d: Db, uid: string, conversationId: string, messageId: string, content: string) {
  const text = content.trim();
  if (!text) throw new RpcError("MESSAGE_REQUIRED", 400);
  if (text.length > MAX_MESSAGE_CHARS) throw new RpcError("MESSAGE_TOO_LONG", 400);
  const conversation = await ownedConversation(d, uid, conversationId);
  const ref = conversation.collection("messages").doc(messageId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data() ?? {};
  if (data.role !== "user") throw new RpcError("MESSAGE_NOT_EDITABLE", 409);
  const previous = typeof data.content === "string" ? data.content : "";
  const editedAt = new Date().toISOString();
  if (previous === text) return { id: messageId, content: text, edited_at: null, changed: false };
  const metadata = { ...((data.metadata ?? {}) as Record<string, unknown>) };
  if (typeof metadata.original_content !== "string") metadata.original_content = previous.slice(0, MAX_MESSAGE_CHARS);
  metadata.edited_at = editedAt;
  metadata.edit_count = (typeof metadata.edit_count === "number" ? metadata.edit_count : 0) + 1;
  await ref.update({ content: text, metadata, updated_at: nowTs() });
  return { id: messageId, content: text, edited_at: editedAt, changed: true };
}
