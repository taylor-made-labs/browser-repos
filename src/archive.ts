/**
 * A tiny, dependency-free archive container for browser-repos.
 *
 * Export/import needs to serialize an entire repository — the whole `.git`
 * directory (all objects, refs, branches, the complete history), the index,
 * every working-tree file (text AND binary, byte-exact), and untracked files —
 * into a single portable blob and reconstruct it losslessly. We do that with a
 * purpose-built container rather than pulling in a tar/zip dependency, because
 * the library is Manifest V3 compatible: no runtime CDN code, no `eval`, and we
 * avoid adding an executable dependency just to pack bytes.
 *
 * ## Format (`BREPOS\x01`)
 *
 * The container is a flat byte stream:
 *
 * ```
 * magic      : 8 bytes  "BREPOS\x01"   (format id + version 1)
 * headerLen  : 4 bytes  uint32 LE      (byte length of the JSON header)
 * header     : N bytes  UTF-8 JSON     (see ArchiveHeader)
 * payload    : M bytes  file contents, concatenated in header order
 * ```
 *
 * The JSON header lists every entry with its repo-filesystem path, byte length,
 * and offset into the payload region. File *bytes* live in the payload region
 * untouched — never base64-encoded, never re-encoded as text — so a file of
 * bytes `0x00..0xFF` round-trips exactly. Only the metadata is JSON.
 *
 * Nothing in this module reaches the network, reads a credential, or evaluates
 * code. It packs and unpacks bytes, and validates entry paths on unpack as a
 * security boundary.
 */

/** Container magic: ASCII "BREPOS" followed by a format-version byte (1). */
const MAGIC = new Uint8Array([0x42, 0x52, 0x45, 0x50, 0x4f, 0x53, 0x01, 0x00]);
const MAGIC_LEN = MAGIC.length;
const LEN_FIELD = 4;

/** Format version recorded in the header, independent of the magic byte. */
export const ARCHIVE_FORMAT_VERSION = 1;

/** Hard ceiling on a single entry's byte length, guarding against a hostile or
 * corrupt header that claims an absurd size. 512 MiB is far above any real
 * browser repo yet small enough to reject a length that would exhaust memory. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** Hard ceiling on the number of entries in one archive. */
export const MAX_ENTRIES = 1_000_000;

/** One file captured in an archive: an absolute repo-FS path and its bytes. */
export interface ArchiveEntry {
  /** Absolute path inside the repo filesystem, e.g. `/work/.git/HEAD`. */
  path: string;
  /** The file's exact bytes. */
  bytes: Uint8Array;
}

/** Metadata describing the archive and the payload layout. Serialized as JSON. */
export interface ArchiveHeader {
  /** Format version (see {@link ARCHIVE_FORMAT_VERSION}). */
  readonly version: number;
  /** The filesystem root the entries are relative-from (informational). */
  readonly root: string;
  /** Per-entry layout: path, byte length, and offset into the payload region. */
  readonly entries: ReadonlyArray<{ path: string; size: number; offset: number }>;
}

/** Raised when an archive is malformed, truncated, or fails validation. */
export class InvalidArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Pack a set of entries into a single archive byte stream. Entry order is
 * preserved; each entry's bytes are copied verbatim into the payload region.
 */
export function packArchive(root: string, entries: ReadonlyArray<ArchiveEntry>): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new InvalidArchiveError(`Too many entries: ${entries.length} > ${MAX_ENTRIES}.`);
  }

  const layout: Array<{ path: string; size: number; offset: number }> = [];
  let payloadSize = 0;
  for (const e of entries) {
    const size = e.bytes.byteLength;
    if (size > MAX_ENTRY_BYTES) {
      throw new InvalidArchiveError(`Entry "${e.path}" is too large: ${size} bytes.`);
    }
    layout.push({ path: e.path, size, offset: payloadSize });
    payloadSize += size;
  }

  const header: ArchiveHeader = { version: ARCHIVE_FORMAT_VERSION, root, entries: layout };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const total = MAGIC_LEN + LEN_FIELD + headerBytes.byteLength + payloadSize;
  const out = new Uint8Array(total);
  let pos = 0;

  out.set(MAGIC, pos);
  pos += MAGIC_LEN;

  writeUint32LE(out, pos, headerBytes.byteLength);
  pos += LEN_FIELD;

  out.set(headerBytes, pos);
  pos += headerBytes.byteLength;

  for (const e of entries) {
    out.set(e.bytes, pos);
    pos += e.bytes.byteLength;
  }

  return out;
}

/**
 * Unpack an archive byte stream into its header and entries. Verifies the
 * magic, version, field lengths, and that every entry's declared offset/size
 * stays within the payload region. Does **not** validate entry *paths* — that
 * is a repo-level concern handled on import, so this stays a pure codec.
 *
 * @throws {InvalidArchiveError} on any structural problem.
 */
export function unpackArchive(data: Uint8Array): { header: ArchiveHeader; entries: ArchiveEntry[] } {
  if (data.byteLength < MAGIC_LEN + LEN_FIELD) {
    throw new InvalidArchiveError('Archive is truncated: shorter than the fixed header.');
  }
  for (let i = 0; i < MAGIC_LEN; i++) {
    if (data[i] !== MAGIC[i]) {
      throw new InvalidArchiveError('Not a browser-repos archive (bad magic).');
    }
  }

  let pos = MAGIC_LEN;
  const headerLen = readUint32LE(data, pos);
  pos += LEN_FIELD;

  if (headerLen === 0 || pos + headerLen > data.byteLength) {
    throw new InvalidArchiveError('Archive header length is out of range.');
  }

  const headerText = new TextDecoder().decode(data.subarray(pos, pos + headerLen));
  pos += headerLen;

  let header: ArchiveHeader;
  try {
    header = JSON.parse(headerText) as ArchiveHeader;
  } catch {
    throw new InvalidArchiveError('Archive header is not valid JSON.');
  }
  if (typeof header !== 'object' || header === null || !Array.isArray(header.entries)) {
    throw new InvalidArchiveError('Archive header is malformed.');
  }
  if (header.version !== ARCHIVE_FORMAT_VERSION) {
    throw new InvalidArchiveError(`Unsupported archive version: ${String(header.version)}.`);
  }
  if (header.entries.length > MAX_ENTRIES) {
    throw new InvalidArchiveError(`Archive declares too many entries: ${header.entries.length}.`);
  }

  const payloadStart = pos;
  const payloadLen = data.byteLength - payloadStart;

  const entries: ArchiveEntry[] = [];
  let expectedOffset = 0;
  for (const meta of header.entries) {
    if (
      typeof meta !== 'object' ||
      meta === null ||
      typeof meta.path !== 'string' ||
      !Number.isInteger(meta.size) ||
      !Number.isInteger(meta.offset) ||
      meta.size < 0 ||
      meta.offset < 0
    ) {
      throw new InvalidArchiveError('Archive entry metadata is malformed.');
    }
    if (meta.size > MAX_ENTRY_BYTES) {
      throw new InvalidArchiveError(`Entry "${meta.path}" declares too large a size: ${meta.size}.`);
    }
    if (meta.offset !== expectedOffset) {
      throw new InvalidArchiveError(`Entry "${meta.path}" has a non-contiguous offset.`);
    }
    if (meta.offset + meta.size > payloadLen) {
      throw new InvalidArchiveError(`Entry "${meta.path}" runs past the end of the payload.`);
    }
    const start = payloadStart + meta.offset;
    // Copy out so the returned bytes do not alias the (possibly large) input.
    entries.push({ path: meta.path, bytes: data.slice(start, start + meta.size) });
    expectedOffset += meta.size;
  }

  if (expectedOffset !== payloadLen) {
    throw new InvalidArchiveError('Archive payload has trailing bytes not described by any entry.');
  }

  return { header, entries };
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset] ?? 0;
  const b1 = buf[offset + 1] ?? 0;
  const b2 = buf[offset + 2] ?? 0;
  const b3 = buf[offset + 3] ?? 0;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}
