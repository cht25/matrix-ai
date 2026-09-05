// =============================================================================
// Minimal ZIP writer (stored / no compression) — enough for real OOXML files
// such as .xlsx. Deterministic and dependency-free so it runs in the browser
// and in Node tests alike.
// =============================================================================

export type ZipEntry = { name: string; data: Uint8Array | string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** DOS time/date from a fixed timestamp (keeps output byte-stable). */
function dosDateTime(date: Date): { time: number; dateValue: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dateValue: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive. Entries are stored uncompressed, which every ZIP reader
 * (including Excel/Word) supports.
 */
export function zipStore(entries: ZipEntry[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  const { time, dateValue } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = toBytes(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // flags: UTF-8 names
    lv.setUint16(8, 0, true);           // compression: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, dateValue, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);          // version made by
    dv.setUint16(6, 20, true);          // version needed
    dv.setUint16(8, 0x0800, true);      // flags: UTF-8 names
    dv.setUint16(10, 0, true);          // compression
    dv.setUint16(12, time, true);
    dv.setUint16(14, dateValue, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);          // extra length
    dv.setUint16(32, 0, true);          // comment length
    dv.setUint16(34, 0, true);          // disk number
    dv.setUint16(36, 0, true);          // internal attrs
    dv.setUint32(38, 0, true);          // external attrs
    dv.setUint32(42, offset, true);     // local header offset
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/**
 * TextEncoder hands back `Uint8Array<ArrayBufferLike>`, which `Blob` rejects.
 * Copy into an ArrayBuffer-backed view so built files can be downloaded.
 */
export function toBlobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

/** Test/inspection helper: list entry names in a stored ZIP archive. */
export function zipEntries(archive: Uint8Array): Array<{ name: string; crc: number; size: number; offset: number }> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const out: Array<{ name: string; crc: number; size: number; offset: number }> = [];
  let i = 0;
  while (i + 4 <= archive.length) {
    if (view.getUint32(i, true) !== 0x04034b50) break;
    const crc = view.getUint32(i + 14, true);
    const size = view.getUint32(i + 18, true);
    const nameLength = view.getUint16(i + 26, true);
    const extraLength = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(archive.subarray(i + 30, i + 30 + nameLength));
    out.push({ name, crc, size, offset: i + 30 + nameLength + extraLength });
    i += 30 + nameLength + extraLength + size;
  }
  return out;
}

/** Test/inspection helper: read one entry's bytes out of a stored archive. */
export function zipRead(archive: Uint8Array, name: string): Uint8Array | null {
  const entry = zipEntries(archive).find((item) => item.name === name);
  if (!entry) return null;
  return archive.subarray(entry.offset, entry.offset + entry.size);
}
