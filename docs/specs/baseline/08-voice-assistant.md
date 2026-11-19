# Baseline 08 — Voice input and assistant experience

**Status:** Partial — dictation, hands-free mode, transcription failover,
speech synthesis, and a foreground wake word are implemented in source.
Browser support and speech-service credentials require real end-to-end checks.

**Evidence:** `src/lib/voice-input.ts`, `src/lib/voice/jarvis-engine.ts`,
`src/lib/client/{use-voice-recorder.ts,voice-dispatch.ts}`,
`src/components/voice/`, `src/app/api/voice/{transcribe/route.ts,speech/route.ts,audio/[id]/route.ts}`,
`src/lib/server/{voice-assets.ts,voice-cleanup.ts}`,
`tests/{voice-input.test.ts,voice-transcription-failover.test.ts,voice-transcribe-route.test.ts,voice-dispatch.test.ts,jarvis-mirror-device-actions.test.ts}`.

## Implemented behavior

- Default mode is **dictation**: mic → waveform/timer/preview → stop → editable
  transcript in the composer → user reviews and sends. Opt-in
  **hands-free** mode uses end-of-speech detection, auto-sends text, and can
  read the response aloud.
- Two transcription paths are implemented: browser Web Speech API where
  supported, and server upload to `/api/voice/transcribe` with provider failover
  in the documented order Groq Whisper → OpenAI Whisper → Cloudflare Workers AI
  Whisper. Language hints are normalized; an unknown hint is omitted rather
  than forcing transliteration.
- `/api/voice/speech` is an OpenAI-compatible text-to-speech endpoint requiring
  a server key and model; when unconfigured it returns
  `VOICE_TTS_NOT_CONFIGURED` and the client falls back to browser speech
  synthesis. Uploads and generated audio are stored as private assets with
  server-signed access and cleanup helpers.
- `jarvis-engine.ts` implements local, foreground wake-phrase matching
  (English/Bangla variants) and intent classification. Read-only tool intents
  can run automatically; device actions and history clearing require explicit
  confirmation. The engine is DOM-free and unit tested.
- Voice settings (mode, language, wake word, voice, rate) are stored locally
  under namespaced keys.

## Boundaries and non-goals

- No true background or wake-word listening: browsers only listen while the
  tab is open, visible, and microphone permission is granted.
- Confirmation text is not an approval token; side effects still pass through
  the Tool Gateway and its approval records where required.
- No claim is made that every browser supports recording, Web Speech, or TTS.

## Partial / planned / deprecated

- **Partial:** real browser recording/transcription/TTS matrix and speech
  provider credentials were not verified in this checkout.
- **Planned:** wake-word support on capable native devices with honest
  background/power limitations is roadmap work.
