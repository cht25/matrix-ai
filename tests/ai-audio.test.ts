import { describe, expect, it } from "vitest";
import { isOwnedChatAudioPath } from "@/lib/ai/audio";

describe("AI speech audio framing", () => {
  it("only permits playback paths beneath the authenticated owner's audio folder", () => {
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-1/123-abc-recording")).toBe(true);
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-2/123-recording")).toBe(false);
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-1/../other/file")).toBe(false);
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-1/")).toBe(false);
  });
});
