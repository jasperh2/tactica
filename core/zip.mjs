// core/zip.mjs — hand-rolled STORE-method ZIP writer. No dependencies, no compression.
// Pure module: no DOM, no fetch, no Date/Math.random (determinism per architecture contract §4).

/** @typedef {{ path: string, data: Uint8Array | string }} ZipEntryInput */

const CRC32_POLYNOMIAL = 0xedb88320;
const BYTE_COUNT = 256;
const BITS_PER_BYTE = 8;

/** Precomputed CRC-32 lookup table (standard polynomial 0xEDB88320), built once at module load. */
const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(BYTE_COUNT);
  for (let n = 0; n < BYTE_COUNT; n++) {
    let c = n;
    for (let k = 0; k < BITS_PER_BYTE; k++) {
      c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/**
 * Compute the CRC-32 checksum of a byte buffer (table-driven, standard polynomial).
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const tableIndex = (crc ^ bytes[i]) & 0xff;
    crc = (crc >>> 8) ^ CRC_TABLE[tableIndex];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- Fixed DOS date/time constant (determinism — no Date use anywhere in this module) ----
// DOS date/time epoch fields chosen once and frozen: 2026-01-01 00:00:00.
// DOS time: bits 15-11 hour, 10-5 minute, 4-0 second/2. DOS date: bits 15-9 year-1980, 8-5 month, 4-0 day.
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const STORE_METHOD = 0;
const UTF8_FLAG_BIT = 0x0800; // general-purpose bit 11: filename/comment are UTF-8
const VERSION_NEEDED = 20; // 2.0 — matches STORE method requirement
const VERSION_MADE_BY = 20;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** Normalize entry data to a Uint8Array of UTF-8 bytes (strings) or pass Uint8Array through. */
function toBytes(data) {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/** Build the fixed-size local file header (30 bytes) for one entry, preceding its filename+data. */
function writeLocalHeader(nameBytes, crc, size) {
  const buf = new ArrayBuffer(LOCAL_HEADER_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, UTF8_FLAG_BIT, true);
  view.setUint16(8, STORE_METHOD, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true); // compressed size == uncompressed size (STORE)
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true); // extra field length
  return new Uint8Array(buf);
}

/** Build the fixed-size central directory header (46 bytes) for one entry. */
function writeCentralHeader(nameBytes, crc, size, localHeaderOffset) {
  const buf = new ArrayBuffer(CENTRAL_HEADER_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
  view.setUint16(4, VERSION_MADE_BY, true);
  view.setUint16(6, VERSION_NEEDED, true);
  view.setUint16(8, UTF8_FLAG_BIT, true);
  view.setUint16(10, STORE_METHOD, true);
  view.setUint16(12, DOS_TIME, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true); // extra field length
  view.setUint16(32, 0, true); // comment length
  view.setUint16(34, 0, true); // disk number start
  view.setUint16(36, 0, true); // internal file attributes
  view.setUint32(38, 0, true); // external file attributes
  view.setUint32(42, localHeaderOffset, true);
  return new Uint8Array(buf);
}

/** Build the end-of-central-directory record (22 bytes, no archive comment). */
function writeEocd(entryCount, centralDirSize, centralDirOffset) {
  const buf = new ArrayBuffer(EOCD_SIZE);
  const view = new DataView(buf);
  view.setUint32(0, END_OF_CENTRAL_DIR_SIG, true);
  view.setUint16(4, 0, true); // disk number
  view.setUint16(6, 0, true); // disk with central dir start
  view.setUint16(8, entryCount, true); // entries on this disk
  view.setUint16(10, entryCount, true); // total entries
  view.setUint32(12, centralDirSize, true);
  view.setUint32(16, centralDirOffset, true);
  view.setUint16(20, 0, true); // comment length
  return new Uint8Array(buf);
}

/**
 * Build a STORE-method (uncompressed) ZIP archive from a list of entries.
 * Deterministic: fixed DOS timestamp, no Date/Math.random. UTF-8 filenames (bit 11 flag set).
 * @param {ZipEntryInput[]} entries
 * @returns {Uint8Array}
 */
export function createZip(entries) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  let centralDirSize = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const dataBytes = toBytes(entry.data);
    const crc = crc32(dataBytes);

    const localHeader = writeLocalHeader(nameBytes, crc, dataBytes.length);
    localChunks.push(localHeader, nameBytes, dataBytes);
    const localEntrySize = localHeader.length + nameBytes.length + dataBytes.length;

    const centralHeader = writeCentralHeader(nameBytes, crc, dataBytes.length, offset);
    centralChunks.push(centralHeader, nameBytes);
    centralDirSize += centralHeader.length + nameBytes.length;

    offset += localEntrySize;
  }

  const centralDirOffset = offset;
  const eocd = writeEocd(entries.length, centralDirSize, centralDirOffset);

  const totalSize = offset + centralDirSize + eocd.length;
  const output = new Uint8Array(totalSize);
  let cursor = 0;
  for (const chunk of [...localChunks, ...centralChunks, eocd]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}
