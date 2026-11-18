// =============================================================================
// Voice-turn dispatch guard
//
// One rule, in one place: may this turn be sent right now?
//
// Why this exists (the production bug it fixes): `send()` used to read
// `recorder.state` straight out of the render closure. A voice message is
// dispatched from the click handler that stopped the recording, so that closure
// still held `"recording"` — `recorder.stop()` had already run and the hook had
// moved to `"idle"`, but the captured value never changed. `send()` therefore
// returned early, silently: the bubble appeared with its waveform and its
// transcript, and no request was ever made. The user saw a voice message with
// no answer and no error.
//
// Two invariants now encode the fix:
//
//   1. the recorder state is read from a live ref, never from a stale closure;
//   2. a voice turn's audio has already been stopped when it is dispatched, so
//      the recorder check does not apply to it at all.
//
// Every blocked dispatch carries a message that the caller shows to the user:
// nothing is dropped silently.
// =============================================================================

/**
 * How long one upload + transcription may take before the turn is abandoned
 * with an explanation. The route's own budget is 120 s (`maxDuration`).
 */
export const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** Why a turn could not be sent, with copy the UI can show verbatim. */
export type VoiceDispatchBlocker = {
  reason: "busy" | "recording";
  message: string;
};

export const VOICE_DISPATCH_BLOCKED_BUSY =
  "QORVYNA is still answering the previous message. Try again in a moment.";
export const VOICE_DISPATCH_BLOCKED_RECORDING =
  "Finish or cancel the recording before sending this message.";

/**
 * Returns the blocker for this turn, or `null` when it may be sent.
 *
 * `voiceTurn` is true for a finished recording: its microphone was released by
 * `recorder.stop()` before the turn is dispatched, so the recorder state is
 * irrelevant (and, in the closure that started it, stale).
 */
export function voiceDispatchBlocker(input: {
  /** Live recorder state, read from a ref. */
  recorderState: string;
  /** The turn is a voice message whose recording already stopped. */
  voiceTurn: boolean;
  streaming: boolean;
  uploadingImage: boolean;
  requestInFlight: boolean;
}): VoiceDispatchBlocker | null {
  if (input.streaming || input.requestInFlight) {
    return { reason: "busy", message: VOICE_DISPATCH_BLOCKED_BUSY };
  }
  if (input.uploadingImage) {
    return { reason: "busy", message: "Wait for the attachment upload to finish, then send." };
  }
  // A voice turn's recording is already stopped: never block it on the recorder.
  if (!input.voiceTurn && input.recorderState !== "idle") {
    return { reason: "recording", message: VOICE_DISPATCH_BLOCKED_RECORDING };
  }
  return null;
}
