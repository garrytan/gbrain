/**
 * Frames of protocol v3 over TCP (owner-ipc/protocol.ts, "Protocol v3"): a u32 big-endian length of the JSON header,
 * the header, then `tail_len` bytes of binary tail when the header names one.
 *
 * The reader bounds memory before it buffers anything (review finding F3 of the L3 plan): the declared header size
 * is checked against the connection's current cap (64 KiB before the hello is authenticated), and every byte it
 * holds for a partial frame is reserved from one budget shared by every connection of the listener, released once
 * when the frame is handed on or the connection closes. A frame over a cap, or bytes the budget cannot hold, end the
 * connection; nothing of it is decoded.
 *
 * Binary tails: when both sides list `binary_tail`, a byte or float array larger than TAIL_MIN_BYTES crosses as a
 * `{ $t: 'tail', of, off, len }` reference into the tail instead of base64 text. A reference outside a frame that has
 * a tail, or out of the tail's range, refuses the frame.
 */
import type { Socket } from 'node:net';
import type { Wire } from '../owner-ipc/codec.ts';

/** Largest JSON header a frame may declare (the v2 frame cap). */
export const SERVED_MAX_FRAME_BYTES = 128 * 1024 * 1024;
/** Largest hello before the connection is authenticated. */
export const SERVED_PREAUTH_FRAME_BYTES = 64 * 1024;
/** Arrays at least this large go to the binary tail when the session has `binary_tail`. */
export const TAIL_MIN_BYTES = 4096;

/** A budget of parser-held bytes shared by the connections of one listener. */
export interface ByteBudget {
  tryReserve(bytes: number): boolean;
  release(bytes: number): void;
  readonly held: number;
}

export function byteBudget(limit: number): ByteBudget {
  let held = 0;
  return {
    tryReserve: (bytes) => { if (bytes < 0 || held + bytes > limit) return false; held += bytes; return true; },
    release: (bytes) => { held = Math.max(0, held - bytes); },
    get held() { return held; },
  };
}

export interface LengthFrameOptions {
  /** The largest header (and header plus tail) accepted now; lowered before the hello is authenticated. */
  maxFrameBytes: () => number;
  budget: ByteBudget;
  onFrame(header: Record<string, unknown>, tail: Buffer | null, bytes: number): void;
  onBad(why: 'frame_too_large' | 'malformed_frame' | 'budget_exhausted'): void;
}

/** Encodes one frame; null when it is over `maxBytes`. */
export function encodeLengthFrame(header: object, tail: Buffer | null = null, maxBytes = SERVED_MAX_FRAME_BYTES): Buffer | null {
  const json = Buffer.from(JSON.stringify(tail && tail.length ? { ...header, tail_len: tail.length } : header), 'utf8');
  if (json.length + (tail?.length ?? 0) > maxBytes) return null;
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(json.length, 0);
  return tail && tail.length ? Buffer.concat([prefix, json, tail]) : Buffer.concat([prefix, json]);
}

/**
 * Reads length-prefixed frames from `socket`. Returns a function that releases what the reader still holds (call it
 * on close; it is idempotent).
 */
export function readLengthFrames(socket: Socket, opts: LengthFrameOptions): () => void {
  let chunks: Buffer[] = [];
  let buffered = 0;
  let reserved = 0;
  let bad = false;
  // The frame being read: its header size and, once the header is parsed, the header and its tail size.
  let headerLen = -1;
  let header: Record<string, unknown> | null = null;
  let tailLen = 0;
  const releaseAll = () => { if (reserved) { opts.budget.release(reserved); reserved = 0; } };
  const fail = (why: Parameters<LengthFrameOptions['onBad']>[0]) => {
    if (bad) return;
    bad = true;
    chunks = [];
    buffered = 0;
    releaseAll();
    opts.onBad(why);
    socket.destroy();
  };
  const take = (n: number): Buffer => {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    chunks = rest.length ? [rest] : [];
    buffered = rest.length;
    return out;
  };
  const reserve = (bytes: number): boolean => {
    if (bytes <= reserved) return true;
    if (!opts.budget.tryReserve(bytes - reserved)) return false;
    reserved = bytes;
    return true;
  };
  socket.on('data', (data: Buffer | string) => {
    if (bad) return;
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    if (!chunk.length) return;
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (bad || socket.destroyed) return;
      // Every byte held for the frame being read is reserved first; a frame's size caps are checked as soon as known.
      if (!reserve(buffered)) { fail('budget_exhausted'); return; }
      if (headerLen < 0) {
        if (buffered < 4) return;
        headerLen = take(4).readUInt32BE(0);
        if (headerLen > opts.maxFrameBytes()) { fail('frame_too_large'); return; }
      }
      if (header === null) {
        if (buffered < headerLen) return;
        let parsed: unknown;
        try { parsed = JSON.parse(take(headerLen).toString('utf8')); } catch { fail('malformed_frame'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { fail('malformed_frame'); return; }
        header = parsed as Record<string, unknown>;
        const declared = header.tail_len;
        tailLen = declared === undefined ? 0 : typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : -1;
        if (tailLen < 0) { fail('malformed_frame'); return; }
        if (headerLen + tailLen > opts.maxFrameBytes()) { fail('frame_too_large'); return; }
      }
      if (buffered < tailLen) return;
      const tail = tailLen ? Buffer.from(take(tailLen)) : null;
      const frame = header;
      const size = 4 + headerLen + tailLen;
      headerLen = -1;
      header = null;
      tailLen = 0;
      // The frame is handed on; what is still buffered (the next frame's start) stays reserved.
      releaseAll();
      opts.onFrame(frame, tail, size);
      if (!buffered) return;
    }
  });
  return () => { releaseAll(); chunks = []; buffered = 0; };
}

const BYTE_TAGS = new Set(['u8', 'buf']);

/**
 * Moves large byte and float arrays of an encoded value into a tail. Returns the rewritten value and the tail
 * (null when nothing moved). The value is not modified in place.
 */
export function extractTail(value: Wire): { value: Wire; tail: Buffer | null } {
  const parts: Buffer[] = [];
  let offset = 0;
  const walk = (wire: Wire): Wire => {
    if (wire === null || typeof wire !== 'object') return wire;
    if (Array.isArray(wire)) return wire.map(walk);
    const tag = wire.$t;
    const bytesOf = (inner: Wire): Buffer | null => typeof inner === 'string' && inner.length * 3 / 4 >= TAIL_MIN_BYTES ? Buffer.from(inner, 'base64') : null;
    if (typeof tag === 'string' && BYTE_TAGS.has(tag)) {
      const bytes = bytesOf(wire.v as Wire);
      if (bytes) { const ref = { $t: 'tail', of: tag, off: offset, len: bytes.length }; parts.push(bytes); offset += bytes.length; return ref; }
      return wire;
    }
    if (tag === 'f32' || tag === 'f64') {
      const inner = wire.v as { [key: string]: Wire } | null;
      const bytes = inner && typeof inner === 'object' && !Array.isArray(inner) ? bytesOf(inner.v as Wire) : null;
      if (bytes) { const ref = { $t: 'tail', of: tag, off: offset, len: bytes.length }; parts.push(bytes); offset += bytes.length; return ref; }
      return wire;
    }
    const out: { [key: string]: Wire } = {};
    for (const key of Object.keys(wire)) Object.defineProperty(out, key, { value: walk(wire[key]!), enumerable: true, writable: true, configurable: true });
    return out;
  };
  const rewritten = walk(value);
  return { value: rewritten, tail: parts.length ? Buffer.concat(parts) : null };
}

/** The reverse of extractTail: tail references back to the codec's base64 forms. Throws on a bad reference. */
export function restoreTail(value: Wire, tail: Buffer | null): Wire {
  const walk = (wire: Wire): Wire => {
    if (wire === null || typeof wire !== 'object') return wire;
    if (Array.isArray(wire)) return wire.map(walk);
    if (wire.$t === 'tail') {
      const off = wire.off; const len = wire.len; const of = wire.of;
      if (!tail || typeof off !== 'number' || typeof len !== 'number' || !Number.isSafeInteger(off) || !Number.isSafeInteger(len)
        || off < 0 || len < 0 || off + len > tail.length || typeof of !== 'string') {
        throw new Error('A binary tail reference is outside the frame\'s tail.');
      }
      const b64 = tail.subarray(off, off + len).toString('base64');
      if (BYTE_TAGS.has(of)) return { $t: of, v: b64 };
      if (of === 'f32' || of === 'f64') return { $t: of, v: { $t: 'u8', v: b64 } };
      throw new Error('A binary tail reference names an unknown kind.');
    }
    const out: { [key: string]: Wire } = {};
    for (const key of Object.keys(wire)) Object.defineProperty(out, key, { value: walk(wire[key]!), enumerable: true, writable: true, configurable: true });
    return out;
  };
  return walk(value);
}
