import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ deleteAudio: vi.fn(async () => true) }));
vi.mock("@/lib/server/cloudinary", () => ({ deletePrivateAudio: mocks.deleteAudio }));
import { cleanupStaleVoiceDrafts } from "@/lib/server/voice-cleanup";
import type { Db } from "@/lib/firebase/admin";

describe("voice draft cleanup", () => {
  it("never deletes legacy or attached audio; cleans only expired unbound new-format assets", async () => {
    const deleted: string[] = [];
    const past = { toMillis: () => 1 };
    const assets = [
      { id: "legacy", data: () => ({ user_id: "u", storage_public_id: "chat-audio/u/legacy", created_at: past }) },
      { id: "attached", data: () => ({ user_id: "u", storage_public_id: "chat-audio/u/attached", transcription_status: "complete", conversation_id: "c", created_at: past }) },
      { id: "stranger", data: () => ({ user_id: "u", storage_public_id: "chat-audio/other/clip", transcription_status: "failed", created_at: past }) },
      { id: "draft", data: () => ({ user_id: "u", storage_public_id: "chat-audio/u/draft", transcription_status: "failed", created_at: past }) },
    ];
    const db = { collection: () => ({ limit: () => ({ get: async () => ({ docs: assets }) }), doc: (id: string) => ({ delete: async () => deleted.push(id) }) }) } as unknown as Db;
    expect(await cleanupStaleVoiceDrafts(db, 2 * 24 * 60 * 60_000)).toBe(1);
    expect(deleted).toEqual(["draft"]);
    expect(mocks.deleteAudio).toHaveBeenCalledWith("chat-audio/u/draft");
  });
});
