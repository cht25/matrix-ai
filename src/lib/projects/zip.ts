// Minimal ZIP read/write (store + deflate). No third-party archive dependency.

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { assertSafeProjectPath, isImagePath, isTextPath, PROJECT_LIMITS } from "@/lib/projects/paths";

export type ZipEntry = {
  path: string;
  content: Buffer;
};

const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED = 8 * 1024 * 1024;

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const data = entry.content;
    const crc = crc32(data);
    let compressed = data;
    let method = 0;
    try {
      const deflated = deflateRawSync(data);
      if (deflated.length < data.length) {
        compressed = deflated;
        method = 8;
      }
    } catch {
      compressed = data;
      method = 0;
    }
    const local = Buffer.concat([
      Buffer.from("PK\u0003\u0004", "binary"),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\u0001\u0002", "binary"),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from("PK\u0005\u0006", "binary"),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length > MAX_ZIP_BYTES) throw new Error("ZIP_TOO_LARGE");
  const entries: ZipEntry[] = [];
  let offset = 0;
  let uncompressed = 0;

  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) throw new Error("ZIP_INVALID");
    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) throw new Error("ZIP_INVALID");
    offset = dataEnd;

    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop()?.startsWith(".")) continue;
    let path: string;
    try {
      path = assertSafeProjectPath(name);
    } catch {
      continue;
    }
    if (!isTextPath(path) && !isImagePath(path)) continue;

    let content: Buffer;
    const raw = buf.subarray(dataStart, dataEnd);
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else continue;

    uncompressed += content.length;
    if (uncompressed > MAX_UNCOMPRESSED) throw new Error("ZIP_TOO_LARGE");
    if (entries.length >= PROJECT_LIMITS.maxFilesPerProject) throw new Error("TOO_MANY_FILES");
    if (isTextPath(path) && content.length > PROJECT_LIMITS.maxTextBytes) continue;
    if (isImagePath(path) && content.length > PROJECT_LIMITS.maxImageBytes) continue;
    entries.push({ path, content });
  }

  if (!entries.length) throw new Error("ZIP_EMPTY");
  return entries;
}
