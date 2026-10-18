/**
 * Pure-TS SHA-256 whose midstate can be saved and resumed (Wave B, spec 1.4).
 * Node and Bun hash natively but do not serialize a midstate (`Hash.copy()`
 * forks in memory only), and every segmented manifest row stores the
 * content_hash stream's state after its own bytes so an append re-hashes only
 * the appended bytes. The digest equals node:crypto's on every input.
 *
 * State layout (`exportState`, at most 103 bytes): the eight 32-bit hash words
 * big-endian (32 bytes), the total byte count as a big-endian u64 (8 bytes),
 * then the buffered partial block (`total % 64` bytes).
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const STATE_HEADER_BYTES = 40;

/** Largest `exportState()` result: header plus a 63-byte partial block. */
export const SHA256_STATE_MAX_BYTES = STATE_HEADER_BYTES + 63;

export class ResumableSha256 {
  private readonly h = new Int32Array(IV);
  private readonly buf = new Uint8Array(64);
  private readonly bufView = new DataView(this.buf.buffer);
  private readonly w = new Int32Array(64);
  private total = 0;

  update(bytes: Uint8Array): this {
    const len = bytes.length;
    let i = 0;
    let used = this.total % 64;
    this.total += len;
    if (used > 0) {
      const take = Math.min(64 - used, len);
      this.buf.set(bytes.subarray(0, take), used);
      used += take;
      i = take;
      if (used < 64) return this;
      compress(this.h, this.w, this.bufView, 0);
    }
    if (i + 64 <= len) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (; i + 64 <= len; i += 64) compress(this.h, this.w, view, i);
    }
    if (i < len) this.buf.set(bytes.subarray(i), 0);
    return this;
  }

  /** Hex digest of everything fed so far; the hasher stays usable (it pads a copy). */
  digest(): string {
    const copy = ResumableSha256.fromState(this.exportState());
    const used = copy.total % 64;
    const buf = copy.buf;
    buf[used] = 0x80;
    buf.fill(0, used + 1);
    if (used >= 56) {
      compress(copy.h, copy.w, copy.bufView, 0);
      buf.fill(0);
    }
    const hi = Math.floor(copy.total / 2 ** 29);
    const lo = (copy.total * 8) >>> 0;
    for (let k = 0; k < 4; k++) {
      buf[59 - k] = (hi >>> (8 * k)) & 0xff;
      buf[63 - k] = (lo >>> (8 * k)) & 0xff;
    }
    compress(copy.h, copy.w, copy.bufView, 0);
    let hex = '';
    for (let k = 0; k < 8; k++) hex += (copy.h[k]! >>> 0).toString(16).padStart(8, '0');
    return hex;
  }

  exportState(): Uint8Array {
    const used = this.total % 64;
    const out = new Uint8Array(STATE_HEADER_BYTES + used);
    const view = new DataView(out.buffer);
    for (let k = 0; k < 8; k++) view.setInt32(k * 4, this.h[k]!);
    view.setUint32(32, Math.floor(this.total / 2 ** 32));
    view.setUint32(36, this.total >>> 0);
    out.set(this.buf.subarray(0, used), STATE_HEADER_BYTES);
    return out;
  }

  static fromState(state: Uint8Array): ResumableSha256 {
    if (state.length < STATE_HEADER_BYTES) throw new Error(`SHA-256 state too short (${state.length} bytes)`);
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const total = view.getUint32(32) * 2 ** 32 + view.getUint32(36);
    if (state.length !== STATE_HEADER_BYTES + (total % 64)) {
      throw new Error(`SHA-256 state length ${state.length} does not match its byte count ${total}`);
    }
    const out = new ResumableSha256();
    for (let k = 0; k < 8; k++) out.h[k] = view.getInt32(k * 4);
    out.total = total;
    out.buf.set(state.subarray(STATE_HEADER_BYTES), 0);
    return out;
  }
}

/**
 * One 64-byte block. Words load through DataView.getInt32 (faster than four
 * byte loads on Bun); the padding is written by hand in `digest` so this call
 * site only ever sees DataViews over input or the block buffer.
 */
function compress(h: Int32Array, w: Int32Array, view: DataView, o: number): void {
  for (let t = 0; t < 16; t++, o += 4) w[t] = view.getInt32(o);
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15]!;
    const y = w[t - 2]!;
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
  }
  let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
  for (let t = 0; t < 64; t++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (hh + S1 + (g ^ (e & (f ^ g))) + K[t]! + w[t]!) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) | (c & (a | b)))) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
  h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
}
