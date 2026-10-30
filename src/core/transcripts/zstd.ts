/**
 * zstd.ts — bounded reader for zstd-compressed JSONL transcripts.
 *
 * Codex (feature `local_thread_store_compression`) compresses an idle
 * rollout in place: `rollout-*.jsonl` becomes `rollout-*.jsonl.zst` (one
 * zstd frame that declares its content size; the plain file is deleted, the
 * mtime kept). The importer reads the compressed file in memory and never
 * writes a decompressed copy.
 *
 * Size discipline mirrors the plain read in codex.ts, measured on the
 * DECOMPRESSED bytes: retained output is capped at `budget`; working memory
 * is proportional to that budget plus a decompressor chunk. A
 * file that decompresses within budget is read whole; a larger one degrades
 * to the same head + tail window the plain path keeps (truncated: true), so
 * a session renders the same pages before and after Codex compresses it.
 *
 * Decompression-bomb guard: the frame and block headers are walked first
 * without decompressing (that also catches a truncated or garbled file,
 * which the streaming decompressor would otherwise end quietly on). A file
 * whose declared size (or, without one, its block-header upper bound) is
 * over ZSTD_DECOMPRESSED_CEILING_BYTES (never below the budget) is refused
 * before any decompression, and the stream is aborted the moment it passes
 * the ceiling or the declared size.
 */

import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import * as zlib from 'node:zlib';

/** Suffix Codex gives a compressed rollout. */
export const COMPRESSED_JSONL_SUFFIX = '.jsonl.zst';

/**
 * Most decompressed bytes one file may stream through. Retained output stays
 * within the budget either way; this only bounds the time a hostile file can cost.
 */
export const ZSTD_DECOMPRESSED_CEILING_BYTES = 4 * 1024 ** 3;

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const BLOCK_MAX = 128 * 1024;

export function isCompressedJsonlPath(path: string): boolean {
  return path.endsWith(COMPRESSED_JSONL_SUFFIX);
}

/** The plain `X.jsonl` a compressed `X.jsonl.zst` was made from. */
export function plainTwinPath(path: string): string {
  return path.slice(0, -'.zst'.length);
}

/** True when the sample starts with the zstd frame magic (28 B5 2F FD). */
export function hasZstdMagic(sample: Buffer): boolean {
  return sample.length >= 4 && sample.readUInt32LE(0) === ZSTD_MAGIC;
}

/**
 * When both `X.jsonl` and `X.jsonl.zst` are listed for the same session
 * (Codex mid-compression, or a hand-restored copy), keep only `X.jsonl`.
 * Order is preserved.
 */
export function preferPlainTwins<T>(items: T[], pathOf: (item: T) => string): T[] {
  const paths = new Set(items.map(pathOf));
  return items.filter((item) => {
    const p = pathOf(item);
    return !(isCompressedJsonlPath(p) && paths.has(plainTwinPath(p)));
  });
}

export interface ZstdFrameScan {
  frames: number;
  /** Sum of every frame's declared content size, or null when any frame does not declare one. */
  declaredBytes: number | null;
  /** Upper bound on the decompressed size from the block headers alone. */
  maxBytes: number;
}

/**
 * Walk the zstd frame and block headers of a file without decompressing.
 * Throws on a truncated file, an unknown magic, a reserved block type or
 * trailing garbage. Reads a few bytes per block, never the payload.
 */
export function scanZstdFrames(path: string): ZstdFrameScan {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const hdr = Buffer.alloc(18);
    const read = (n: number, at: number, what: string): Buffer => {
      if (at + n > size) throw new Error(`zstd: truncated ${what} at byte ${at}`);
      const got = readSync(fd, hdr, 0, n, at);
      if (got !== n) throw new Error(`zstd: short read of ${what} at byte ${at}`);
      return hdr.subarray(0, n);
    };
    let pos = 0;
    let frames = 0;
    let declared: number | null = 0;
    let maxBytes = 0;
    if (size === 0) throw new Error('zstd: empty file');
    while (pos < size) {
      const magic = read(4, pos, 'frame magic').readUInt32LE(0);
      if ((magic & SKIPPABLE_MAGIC_MASK) >>> 0 === SKIPPABLE_MAGIC) {
        const len = read(4, pos + 4, 'skippable frame size').readUInt32LE(0);
        pos += 8 + len;
        if (pos > size) throw new Error('zstd: truncated skippable frame');
        continue;
      }
      if (magic !== ZSTD_MAGIC) throw new Error(`zstd: bad frame magic at byte ${pos}`);
      frames++;
      pos += 4;
      const fhd = read(1, pos, 'frame header')[0]!;
      pos += 1;
      if (fhd & 0x08) throw new Error('zstd: reserved frame header bit set');
      const fcsFlag = fhd >> 6;
      const singleSegment = (fhd >> 5) & 1;
      const checksum = (fhd >> 2) & 1;
      const didBytes = [0, 1, 2, 4][fhd & 3]!;
      let windowSize = 0;
      if (!singleSegment) {
        const wd = read(1, pos, 'window descriptor')[0]!;
        pos += 1;
        const base = 2 ** (10 + (wd >> 3));
        windowSize = base + (base / 8) * (wd & 7);
      }
      pos += didBytes;
      const fcsBytes = [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]!;
      let fcs: number | null = null;
      if (fcsBytes > 0) {
        const b = read(fcsBytes, pos, 'frame content size');
        fcs =
          fcsBytes === 1 ? b[0]! :
          fcsBytes === 2 ? b.readUInt16LE(0) + 256 :
          fcsBytes === 4 ? b.readUInt32LE(0) :
          Number(b.readBigUInt64LE(0));
        pos += fcsBytes;
      }
      if (singleSegment) windowSize = fcs ?? 0;
      const blockMax = Math.min(windowSize || BLOCK_MAX, BLOCK_MAX);
      let frameMax = 0;
      for (;;) {
        const bh = read(3, pos, 'block header');
        const v = bh[0]! | (bh[1]! << 8) | (bh[2]! << 16);
        pos += 3;
        const last = v & 1;
        const type = (v >> 1) & 3;
        const bsize = v >>> 3;
        if (type === 3) throw new Error(`zstd: reserved block type at byte ${pos - 3}`);
        // raw: bsize stored bytes; RLE: one byte repeated bsize times;
        // compressed: bsize stored bytes, at most blockMax decompressed.
        frameMax += type === 2 ? blockMax : bsize;
        pos += type === 1 ? 1 : bsize;
        if (pos > size) throw new Error('zstd: truncated block');
        if (last) break;
      }
      if (checksum) pos += 4;
      if (pos > size) throw new Error('zstd: truncated frame checksum');
      maxBytes += frameMax;
      declared = declared === null || fcs === null ? null : declared + fcs;
    }
    if (frames === 0) throw new Error('zstd: no data frame');
    return { frames, declaredBytes: declared, maxBytes };
  } finally {
    closeSync(fd);
  }
}

export interface BoundedRead {
  raw: string;
  /** Decompressed bytes kept (whole file, or head + tail when truncated). */
  bytesRead: number;
  truncated: boolean;
  /** Total decompressed size of the file. */
  decompressedBytes: number;
}

/**
 * Decompress `path` keeping at most `budget` bytes: the whole content when
 * it fits, otherwise the first `headBytes` plus the last `budget - headBytes`
 * joined by a newline (the plain codex read's exact shape). Throws on a
 * corrupt, truncated or over-ceiling file.
 */
export async function readZstdBounded(path: string, budget: number, headBytes: number): Promise<BoundedRead> {
  const createZstdDecompress = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
    .createZstdDecompress;
  if (typeof createZstdDecompress !== 'function') {
    throw new Error(
      `zstd decompression is not available in this runtime (${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}); cannot read ${path}`,
    );
  }
  const scan = scanZstdFrames(path);
  const ceiling = Math.max(ZSTD_DECOMPRESSED_CEILING_BYTES, budget);
  const limit = Math.min(scan.declaredBytes ?? scan.maxBytes, scan.maxBytes);
  if (limit > ceiling) {
    throw new Error(`zstd: ${path} would decompress to ${limit} bytes, over the ${ceiling}-byte ceiling (decompression-bomb guard)`);
  }

  const src = createReadStream(path, { highWaterMark: 256 * 1024 });
  const ds = createZstdDecompress();
  src.on('error', (e) => (ds as unknown as { destroy(e: Error): void }).destroy(e));
  src.pipe(ds as unknown as NodeJS.WritableStream);

  const tailBytes = budget - headBytes;
  let total = 0;
  let chunks: Buffer[] = [];
  let held = 0;
  let head: Buffer | null = null; // set once the content outgrows the budget
  try {
    for await (const c of ds as AsyncIterable<Buffer>) {
      total += c.length;
      if (total > limit) {
        throw new Error(`zstd: ${path} decompressed past ${limit} bytes (declared or block bound); corrupt or hostile file`);
      }
      chunks.push(c);
      held += c.length;
      if (head === null && held > budget) {
        const all = Buffer.concat(chunks);
        head = Buffer.from(all.subarray(0, headBytes));
        chunks = [all.subarray(headBytes)];
        held = all.length - headBytes;
      }
      if (head !== null) {
        while (chunks.length > 1 && held - chunks[0]!.length >= tailBytes) held -= chunks.shift()!.length;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.startsWith('zstd:') ? msg : `zstd: cannot decompress ${path}: ${msg}`);
  } finally {
    src.destroy();
  }
  if (scan.declaredBytes !== null && total !== scan.declaredBytes) {
    throw new Error(`zstd: ${path} decompressed to ${total} bytes but declares ${scan.declaredBytes}; corrupt file`);
  }
  if (head === null) {
    const all = Buffer.concat(chunks);
    return { raw: all.toString('utf8'), bytesRead: all.length, truncated: false, decompressedBytes: total };
  }
  const joined = Buffer.concat(chunks);
  const tail = joined.subarray(Math.max(0, joined.length - tailBytes));
  return {
    raw: head.toString('utf8') + '\n' + tail.toString('utf8'),
    bytesRead: head.length + tail.length,
    truncated: true,
    decompressedBytes: total,
  };
}
