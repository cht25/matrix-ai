// =============================================================================
// The voice bubble's three states, rendered as real DOM.
//
//   processing → "Uploading and transcribing…" (one request does both)
//   failed     → the reason + Try again + Discard, recording kept
//   ready      → the player and, on request, the transcript
//
// These are the surfaces the user actually sees while a voice message becomes
// an answer, so they are asserted against the rendered markup rather than the
// source.
// =============================================================================
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { VoiceMessage } from "../src/components/voice-message";
import { UserMessage } from "../src/components/user-message";
import type { ChatMessage } from "../src/lib/chat-messages";

const base = {
  src: "/api/voice/audio/8d1f6b4e-1f2a-4c3d-9e8f-0a1b2c3d4e5f",
  transcript: "turn on the lights in the kitchen",
  durationMs: 4200,
  waveform: [3, 40, 55, 21],
  language: "en",
};

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(VoiceMessage, props as never));

describe("voice message bubble states", () => {
  it("says what is happening while the recording is uploaded and transcribed", () => {
    const html = render({ ...base, status: "processing" });
    expect(html).toContain("Uploading and transcribing…");
    expect(html).toContain('role="status"');
    // The player is there from the first moment: the audio is never withheld.
    expect(html).toContain("<audio");
  });

  it("shows the real reason, keeps the recording, and offers a retry", () => {
    const html = render({
      ...base,
      status: "failed",
      error: "The speech service took too long to answer. Your recording is kept — try again.",
      onRetry: () => {},
      onDiscard: () => {},
    });
    expect(html).toContain("took too long");
    expect(html).toContain("Your recording is kept");
    expect(html).toContain("Try again");
    expect(html).toContain("Discard");
    expect(html).toContain('role="alert"');
  });

  it("falls back to an honest sentence when no reason was recorded", () => {
    const html = render({ ...base, status: "failed" });
    expect(html).toContain("could not be sent");
  });

  it("never claims success it did not have: no transcript line while processing", () => {
    const html = render({ ...base, status: "processing" });
    expect(html).not.toContain("Show transcript");
  });
});

describe("the user turn that carries the recording", () => {
  const message = (metadata: Record<string, unknown>): ChatMessage => ({
    role: "user",
    content: "turn on the lights in the kitchen",
    created_at: "2026-01-01T00:00:00.000Z",
    metadata: metadata as ChatMessage["metadata"],
  });

  const renderUser = (meta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(UserMessage, {
        message: message(meta),
        timeLabel: "12:04",
        actions: { primary: [], overflow: [] },
        editing: false,
        editMode: "transcript",
        saving: false,
        onSubmitEdit: () => {},
        onCancelEdit: () => {},
        animate: false,
        ...extra,
      } as never),
    );

  it("renders the recording inline, with its transcript attached", () => {
    const html = renderUser({
      turn_id: "turn-1",
      audio_asset_id: "8d1f6b4e-1f2a-4c3d-9e8f-0a1b2c3d4e5f",
      audio_duration_ms: 4200,
      audio_waveform: [3, 40, 55, 21],
      audio_language: "en",
      voice_status: "processing",
    });
    expect(html).toContain('data-role="user"');
    expect(html).toContain("Uploading and transcribing…");
    expect(html).toContain("/api/voice/audio/8d1f6b4e-1f2a-4c3d-9e8f-0a1b2c3d4e5f");
  });

  it("offers Try again only when the turn has a retry handler", () => {
    const meta = { turn_id: "turn-2", local_audio_url: "blob:local", voice_status: "failed", voice_error: "QORVYNA did not accept this message. Try again." };
    // The retry control is the one that re-dispatches the recording.
    expect(renderUser(meta, { onRetryVoice: () => {} })).toContain("lucide-rotate-ccw");
    expect(renderUser(meta)).not.toContain("lucide-rotate-ccw");
  });
});
