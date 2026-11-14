export function isOwnedChatAudioPath(uid: string, publicId: string): boolean {
  const parts = publicId.split("/");
  return parts.length === 3 && parts[0] === "chat-audio" && parts[1] === uid && /^[a-zA-Z0-9._-]{1,180}$/.test(parts[2]) && parts[2] !== "." && parts[2] !== "..";
}

/** Browser MIME headers are user-controlled; check container signatures before storage. */
export function matchesAudioContainer(bytes: Buffer, mime: string): boolean {
  if (bytes.length < 12) return false;
  if (mime === "audio/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "audio/ogg" || mime === "audio/opus") return bytes.toString("ascii", 0, 4) === "OggS";
  if (mime === "audio/mp4" || mime === "audio/aac") return bytes.toString("ascii", 4, 8) === "ftyp" || (mime === "audio/aac" && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0);
  if (mime === "audio/wav" || mime === "audio/x-wav") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  if (mime === "audio/mpeg" || mime === "audio/mpga") return bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mime === "audio/flac") return bytes.toString("ascii", 0, 4) === "fLaC";
  if (mime === "audio/3gpp") return bytes.toString("ascii", 4, 8) === "ftyp";
  if (mime === "audio/x-aac") return bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  return false;
}
