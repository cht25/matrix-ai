export function isOwnedChatAudioPath(uid: string, publicId: string): boolean {
  const parts = publicId.split("/");
  return parts.length === 3 && parts[0] === "chat-audio" && parts[1] === uid && /^[a-zA-Z0-9._-]{1,180}$/.test(parts[2]) && parts[2] !== "." && parts[2] !== "..";
}

export function pcm16ToWav(pcm: Buffer, mimeType: string): Buffer {
  if (!/^audio\/(?:l16|pcm)(?:;|$)/i.test(mimeType) || pcm.length < 2 || pcm.length % 2 !== 0) {
    throw new Error("GEMINI_AUDIO_FORMAT_UNSUPPORTED");
  }
  const sampleRate = Number(/(?:^|;)\s*rate=(\d+)/i.exec(mimeType)?.[1] ?? 0);
  const channels = Number(/(?:^|;)\s*channels=(\d+)/i.exec(mimeType)?.[1] ?? 1);
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 || !Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error("GEMINI_AUDIO_FORMAT_UNSUPPORTED");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
