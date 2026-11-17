// =============================================================================
// Voice message → transcription → automatic send, exactly once
//
// The reported bug: the recording was transcribed but the message sat in the
// composer until Send was clicked again. These tests pin the contract:
//
//   • stopping a recording (default mode) MEANS send — one action, not two;
//   • a transcript is dispatched exactly once per recording, however many
//     times the Send/Retry path is triggered;
//   • a dispatch that failed is released again so the recording can be retried;
//   • the chat wires the recording panel's Send button to that path, and the
//     text-only path is an explicit opt-out.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createVoiceTurnLedger, voiceStopIntent } from "@/lib/voice-input";

describe("stopping a recording sends the message", () => {
  it("the default microphone mode auto-sends after transcription", () => {
    expect(voiceStopIntent("dictate")).toBe("send");
    expect(voiceStopIntent(undefined)).toBe("send");
  });

  it("hands-free keeps its own send path", () => {
    expect(voiceStopIntent("hands_free")).toBe("hands_free_send");
  });
});

describe("one recording produces one message", () => {
  it("claims a turn once and refuses every later claim", () => {
    const ledger = createVoiceTurnLedger();
    expect(ledger.claim("turn-1")).toBe(true);
    expect(ledger.claim("turn-1")).toBe(false);
    expect(ledger.claim("turn-1")).toBe(false);
    expect(ledger.has("turn-1")).toBe(true);
    expect(ledger.size()).toBe(1);
  });

  it("tracks separate recordings independently", () => {
    const ledger = createVoiceTurnLedger();
    expect(ledger.claim("turn-1")).toBe(true);
    expect(ledger.claim("turn-2")).toBe(true);
    expect(ledger.has("turn-1")).toBe(true);
    expect(ledger.has("turn-2")).toBe(true);
  });

  it("releases a turn that never actually went out, so Retry works", () => {
    const ledger = createVoiceTurnLedger();
    expect(ledger.claim("turn-1")).toBe(true);
    ledger.release("turn-1");
    expect(ledger.has("turn-1")).toBe(false);
    // The retry of the same recording is allowed — once.
    expect(ledger.claim("turn-1")).toBe(true);
    expect(ledger.claim("turn-1")).toBe(false);
  });

  it("ignores empty ids", () => {
    const ledger = createVoiceTurnLedger();
    expect(ledger.claim("")).toBe(false);
    expect(ledger.size()).toBe(0);
  });

  it("forgets everything when the conversation is replaced", () => {
    const ledger = createVoiceTurnLedger();
    ledger.claim("turn-1");
    ledger.clear();
    expect(ledger.size()).toBe(0);
    expect(ledger.claim("turn-1")).toBe(true);
  });
});

describe("chat wiring", () => {
  const source = readFileSync("src/components/chat-client.tsx", "utf8");

  it("the recording panel's primary button goes through the auto-send intent", () => {
    expect(source).toContain("onStopVoice={() => void finishVoice(voiceStopIntent(voiceModeRef.current))}");
  });

  it("every send of a recorded turn is guarded by the ledger", () => {
    expect(source).toContain("if (!sentVoiceTurnsRef.current.claim(turnId)) return;");
    expect(source).toContain("sentVoiceTurnsRef.current.release(turnId)");
    // The voice bubble stays retired once its turn is sent.
    expect(source).toContain("voiceDraftsRef.current.has(turn) && !sentVoiceTurnsRef.current.has(turn)");
  });

  it("transcribing without sending is a separate, explicit action", () => {
    expect(source).toContain('onDictateOnly={() => void finishVoice("transcribe")}');
  });

  it("a failed transcription keeps the recording and offers a retry", () => {
    // The draft is only dropped on success; a failure marks the bubble failed
    // and leaves the draft in place for "Try again".
    expect(source).toContain('voice_status: "failed"');
    expect(source).toContain("onRetryVoice");
  });
});
