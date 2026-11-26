/**
 * The wire pieces of a served Rust brain that the loopback-TCP wire test does not reach (src/core/rust-engine/served/,
 * docs/designs/rust-engine/multi-user-server.md "M1 as built"): the length-prefixed frame reader and its byte budget,
 * the binary tail, TLS between a client and the listener, and the client's `owner_busy` retry.
 *
 * 1. Protects: a frame split or glued by TCP reads back whole; the server's memory is bounded before a frame is
 *    buffered and the shared budget returns to zero; a large vector crosses as raw bytes and comes back byte for
 *    byte; no token is sent to a server whose certificate is not trusted; a plain-TCP listener on a public address
 *    never opens; a busy owner costs a caller a retry and, at its own deadline, a `timeout`, never a raw `owner_busy`.
 * 2. Fails on: a frame lost or merged across chunk boundaries; a header over the cap that is buffered; a budget that
 *    leaks or overshoots; a tail that is mis-sliced or an out-of-range tail that is accepted; a bearer token sent
 *    before the certificate check; a non-loopback plain listener; a busy refusal that is not retried.
 * 3. Existing coverage: rust-served-wire.test.ts covers the hello, request ids, positions, callbacks and
 *    transactions over loopback TCP; nothing covered TLS, the frame reader on its own, or the busy retry.
 * 4. Seam: encodeLengthFrame/readLengthFrames on a socket stand-in; a recording fake engine on a real owner
 *    server behind a real TLS listener on 127.0.0.1 with a throwaway openssl certificate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { connectServed, parseServedUrl, type ServedConnection } from '../src/core/rust-engine/served/client.ts';
import {
  byteBudget, encodeLengthFrame, extractTail, readLengthFrames, restoreTail, TAIL_MIN_BYTES,
  type ByteBudget, type LengthFrameOptions,
} from '../src/core/rust-engine/served/framing.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import { decodeValue, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { withReadDeadline } from '../src/core/read-deadline.ts';
import type { ServedServerOptions } from '../src/core/rust-engine/served/session.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Frame reader, byte budget and binary tail (no network)
// ---------------------------------------------------------------------------------------------------------------------

/** A socket stand-in: `readLengthFrames` only listens for `data` and calls `destroy`. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): this { this.destroyed = true; return this; }
  push(chunk: Buffer): void { this.emit('data', chunk); }
}

interface Reader {
  socket: FakeSocket;
  frames: Array<{ header: Record<string, unknown>; tail: Buffer | null; bytes: number }>;
  bad: string[];
  budget: ByteBudget;
  release: () => void;
  peak: () => number;
}

function reader(opts: { maxFrameBytes?: number; budgetBytes?: number } = {}): Reader {
  const socket = new FakeSocket();
  const inner = byteBudget(opts.budgetBytes ?? 1 << 30);
  let peak = 0;
  const budget: ByteBudget = {
    tryReserve: n => { const ok = inner.tryReserve(n); peak = Math.max(peak, inner.held); return ok; },
    release: n => inner.release(n),
    get held() { return inner.held; },
  };
  const frames: Reader['frames'] = [];
  const bad: string[] = [];
  const options: LengthFrameOptions = {
    maxFrameBytes: () => opts.maxFrameBytes ?? 1 << 20,
    budget,
    onFrame: (header, tail, bytes) => { frames.push({ header, tail, bytes }); },
    onBad: why => { bad.push(why); },
  };
  const release = readLengthFrames(socket as unknown as Socket, options);
  return { socket, frames, bad, budget, release, peak: () => peak };
}

/** A raw frame with a header this test controls byte for byte. */
function rawFrame(json: string, tail?: Buffer): Buffer {
  const body = Buffer.from(json, 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body, ...(tail ? [tail] : [])]);
}

describe('length frames', () => {
  test('a frame round-trips whole, with and without a binary tail', () => {
    const r = reader();
    const tail = Buffer.from([1, 2, 3, 250, 251, 252]);
    r.socket.push(encodeLengthFrame({ t: 'call', id: 1, member: 'getPage' })!);
    r.socket.push(encodeLengthFrame({ t: 'result', id: 2 }, tail)!);
    expect(r.bad).toEqual([]);
    expect(r.frames).toHaveLength(2);
    expect(r.frames[0]!.header).toEqual({ t: 'call', id: 1, member: 'getPage' });
    expect(r.frames[0]!.tail).toBeNull();
    expect(r.frames[1]!.header).toEqual({ t: 'result', id: 2, tail_len: tail.length });
    expect(r.frames[1]!.tail!.equals(tail)).toBe(true);
    expect(r.frames[1]!.bytes).toBe(4 + Buffer.byteLength(JSON.stringify({ t: 'result', id: 2, tail_len: tail.length })) + tail.length);
  });

  test('a frame over the encoder cap does not encode', () => {
    expect(encodeLengthFrame({ t: 'x', pad: 'y'.repeat(200) }, null, 100)).toBeNull();
    expect(encodeLengthFrame({ t: 'x' }, Buffer.alloc(200), 100)).toBeNull();
  });

  test('frames split at every possible byte boundary read back the same frames', () => {
    const tail = Buffer.from(Array.from({ length: 37 }, (_, i) => (i * 7) % 256));
    const stream = Buffer.concat([
      encodeLengthFrame({ t: 'a', n: 1 })!,
      encodeLengthFrame({ t: 'b', n: 2, text: 'héllo wörld \u{1F600}' }, tail)!,
      encodeLengthFrame({ t: 'c', n: 3 })!,
    ]);
    for (let cut = 1; cut < stream.length; cut++) {
      const r = reader();
      r.socket.push(Buffer.from(stream.subarray(0, cut)));
      r.socket.push(Buffer.from(stream.subarray(cut)));
      expect(r.bad).toEqual([]);
      expect(r.frames.map(f => f.header.t)).toEqual(['a', 'b', 'c']);
      expect(r.frames[1]!.header.text).toBe('héllo wörld \u{1F600}');
      expect(r.frames[1]!.tail!.equals(tail)).toBe(true);
      expect(r.budget.held).toBe(0);
    }
  });

  test('frames fed one byte at a time, and in random chunk sizes, read back whole', () => {
    const tail = Buffer.alloc(300, 9);
    const stream = Buffer.concat([encodeLengthFrame({ t: 'one' }, tail)!, encodeLengthFrame({ t: 'two' })!, encodeLengthFrame({ t: 'three' }, tail)!]);
    const bytewise = reader();
    for (let i = 0; i < stream.length; i++) bytewise.socket.push(Buffer.from(stream.subarray(i, i + 1)));
    expect(bytewise.frames.map(f => f.header.t)).toEqual(['one', 'two', 'three']);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let round = 0; round < 50; round++) {
      const r = reader();
      for (let at = 0; at < stream.length;) { const n = 1 + (rnd() % 40); r.socket.push(Buffer.from(stream.subarray(at, at + n))); at += n; }
      expect(r.bad).toEqual([]);
      expect(r.frames.map(f => f.header.t)).toEqual(['one', 'two', 'three']);
      expect(r.frames[2]!.tail!.equals(tail)).toBe(true);
      expect(r.budget.held).toBe(0);
    }
  });

  test('several frames coalesced in one chunk are all handed on, in order', () => {
    const r = reader();
    const frames = Array.from({ length: 25 }, (_, i) => encodeLengthFrame({ t: 'f', i }, i % 3 === 0 ? Buffer.alloc(i + 1, i) : null)!);
    r.socket.push(Buffer.concat(frames));
    expect(r.bad).toEqual([]);
    expect(r.frames.map(f => f.header.i)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(r.frames[3]!.tail!.equals(Buffer.alloc(4, 3))).toBe(true);
    expect(r.budget.held).toBe(0);
  });

  test('a declared header over maxFrameBytes is refused as frame_too_large before any of it is buffered', () => {
    const r = reader({ maxFrameBytes: 1024 });
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(1025, 0);
    r.socket.push(prefix);
    expect(r.bad).toEqual(['frame_too_large']);
    expect(r.socket.destroyed).toBe(true);
    expect(r.frames).toEqual([]);
    expect(r.budget.held).toBe(0);
    // Only the 4 prefix bytes were ever held: nothing of the declared 1025 bytes was reserved.
    expect(r.peak()).toBeLessThanOrEqual(4);
    // A refused connection reads nothing more.
    r.socket.push(rawFrame('{"t":"late"}'));
    expect(r.frames).toEqual([]);
    expect(r.bad).toEqual(['frame_too_large']);
  });

  test('a huge declared header (4 GiB) is refused, and so is header plus tail over the cap', () => {
    const huge = reader({ maxFrameBytes: 1 << 20 });
    huge.socket.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(huge.bad).toEqual(['frame_too_large']);
    expect(huge.peak()).toBeLessThanOrEqual(4);
    const both = reader({ maxFrameBytes: 100 });
    both.socket.push(rawFrame('{"t":"x","tail_len":200}'));
    expect(both.bad).toEqual(['frame_too_large']);
    expect(both.frames).toEqual([]);
    expect(both.budget.held).toBe(0);
  });

  test('malformed JSON, a non-object header, and an invalid tail_len are refused as malformed_frame', () => {
    const cases: Array<[string, string]> = [
      ['not json', '{"t":'],
      ['an array', '[1,2,3]'],
      ['null', 'null'],
      ['a string', '"hello"'],
      ['a fractional tail_len', '{"t":"x","tail_len":1.5}'],
      ['a negative tail_len', '{"t":"x","tail_len":-1}'],
      ['a string tail_len', '{"t":"x","tail_len":"4"}'],
      ['a null tail_len', '{"t":"x","tail_len":null}'],
      ['an unsafe-integer tail_len', '{"t":"x","tail_len":1e300}'],
    ];
    for (const [name, json] of cases) {
      const r = reader();
      r.socket.push(rawFrame(json));
      expect({ name, bad: r.bad, frames: r.frames.length, destroyed: r.socket.destroyed, held: r.budget.held })
        .toEqual({ name, bad: ['malformed_frame'], frames: 0, destroyed: true, held: 0 });
    }
  });

  test('the shared budget is never exceeded; a frame that does not fit ends only its own connection', () => {
    const budget = byteBudget(1000);
    const mk = () => {
      const socket = new FakeSocket();
      const frames: unknown[] = []; const bad: string[] = [];
      const release = readLengthFrames(socket as unknown as Socket, { maxFrameBytes: () => 1 << 20, budget, onFrame: h => { frames.push(h); }, onBad: w => { bad.push(w); } });
      return { socket, frames, bad, release };
    };
    const a = mk(); const b = mk();
    const big = encodeLengthFrame({ t: 'big' }, Buffer.alloc(600))!;
    // Each connection holds the front of a partial frame; together they may not pass the limit.
    a.socket.push(Buffer.from(big.subarray(0, 500)));
    expect(budget.held).toBe(500);
    b.socket.push(Buffer.from(big.subarray(0, 400)));
    expect(budget.held).toBeLessThanOrEqual(1000);
    b.socket.push(Buffer.from(big.subarray(400)));
    expect(b.bad).toEqual(['budget_exhausted']);
    expect(b.socket.destroyed).toBe(true);
    expect(budget.held).toBeLessThanOrEqual(1000);
    expect(budget.held).toBe(500);
    // The other connection is unharmed and finishes its frame; the budget is then empty.
    a.socket.push(Buffer.from(big.subarray(500)));
    expect(a.bad).toEqual([]);
    expect(a.frames).toHaveLength(1);
    expect(budget.held).toBe(0);
  });

  test('the budget returns to 0 after frames are handed on, and after a connection closes mid-frame', () => {
    const budget = byteBudget(1 << 20);
    const socket = new FakeSocket();
    let handed = 0;
    const release = readLengthFrames(socket as unknown as Socket, { maxFrameBytes: () => 1 << 20, budget, onFrame: () => { handed++; }, onBad: () => {} });
    const whole = encodeLengthFrame({ t: 'w' }, Buffer.alloc(5000, 1))!;
    socket.push(Buffer.from(whole));
    expect(handed).toBe(1);
    expect(budget.held).toBe(0);
    // A second frame arrives only in part; its bytes are reserved until the connection closes.
    const part = encodeLengthFrame({ t: 'p' }, Buffer.alloc(5000, 2))!;
    socket.push(Buffer.from(part.subarray(0, 3000)));
    expect(budget.held).toBe(3000);
    release();
    expect(budget.held).toBe(0);
    release();
    expect(budget.held).toBe(0);
    // Two readers on one budget: closing one does not free the other's bytes.
    const other = new FakeSocket();
    const releaseOther = readLengthFrames(other as unknown as Socket, { maxFrameBytes: () => 1 << 20, budget, onFrame: () => {}, onBad: () => {} });
    other.push(Buffer.from(part.subarray(0, 2000)));
    expect(budget.held).toBe(2000);
    releaseOther();
    expect(budget.held).toBe(0);
  });

  test('a frame refused for a bad header frees what it held', () => {
    const budget = byteBudget(10_000);
    const socket = new FakeSocket();
    const bad: string[] = [];
    readLengthFrames(socket as unknown as Socket, { maxFrameBytes: () => 1 << 20, budget, onFrame: () => {}, onBad: w => { bad.push(w); } });
    socket.push(Buffer.concat([rawFrame('{"t":"x","tail_len":-5}'), Buffer.alloc(100)]));
    expect(bad).toEqual(['malformed_frame']);
    expect(budget.held).toBe(0);
  });

  test('the cap can be lowered after the first frame (the pre-hello cap)', () => {
    let cap = 64;
    const socket = new FakeSocket();
    const got: string[] = []; const bad: string[] = [];
    readLengthFrames(socket as unknown as Socket, { maxFrameBytes: () => cap, budget: byteBudget(1 << 20), onFrame: h => { got.push(String(h.t)); }, onBad: w => { bad.push(w); } });
    socket.push(encodeLengthFrame({ t: 'hello' })!);
    cap = 1 << 20;
    socket.push(encodeLengthFrame({ t: 'call', pad: 'z'.repeat(500) })!);
    expect(got).toEqual(['hello', 'call']);
    expect(bad).toEqual([]);
  });
});

describe('binary tail', () => {
  const big = TAIL_MIN_BYTES + 100;
  const bytesOf = (v: unknown): Buffer => {
    const a = v as ArrayBufferView;
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  };

  test('Buffer, Uint8Array, Float32Array and Float64Array values larger than TAIL_MIN_BYTES move to the tail and come back byte for byte', () => {
    const buf = Buffer.alloc(big); for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) % 256;
    const u8 = new Uint8Array(big); for (let i = 0; i < u8.length; i++) u8[i] = (i * 17 + 3) % 256;
    const f32 = new Float32Array(big / 4 + 10); for (let i = 0; i < f32.length; i++) f32[i] = Math.sin(i) * 1e3;
    const f64 = new Float64Array(big / 8 + 10); for (let i = 0; i < f64.length; i++) f64[i] = Math.cos(i) * 1e-3;
    const value = { page: { embedding: f32, nested: [{ raw: buf }, [u8]] }, list: [f64], label: 'kept', n: 7, nothing: null };
    const wire = encodeValue(value);
    const { value: moved, tail } = extractTail(wire);
    expect(tail).not.toBeNull();
    const json = JSON.stringify(moved);
    expect(json).not.toContain('"v":"');          // no base64 left in the header
    expect(json.match(/"\$t":"tail"/g)).toHaveLength(4);
    expect(tail!.length).toBe(buf.length + u8.length + f32.byteLength + f64.byteLength);
    // The original wire value is not modified in place.
    expect(JSON.stringify(wire)).toContain('"$t":"f32"');
    const restored = restoreTail(JSON.parse(json) as Wire, tail);
    const back = decodeValue(restored) as typeof value;
    expect(Buffer.isBuffer(back.page.nested[0] && (back.page.nested[0] as { raw: unknown }).raw)).toBe(true);
    expect(bytesOf((back.page.nested[0] as { raw: Buffer }).raw).equals(buf)).toBe(true);
    const backU8 = (back.page.nested[1] as Uint8Array[])[0]!;
    expect(backU8).toBeInstanceOf(Uint8Array);
    expect(bytesOf(backU8).equals(bytesOf(u8))).toBe(true);
    expect(back.page.embedding).toBeInstanceOf(Float32Array);
    expect(bytesOf(back.page.embedding).equals(bytesOf(f32))).toBe(true);
    expect(back.list[0]).toBeInstanceOf(Float64Array);
    expect(bytesOf(back.list[0]).equals(bytesOf(f64))).toBe(true);
    expect(back.label).toBe('kept'); expect(back.n).toBe(7); expect(back.nothing).toBeNull();
  });

  test('a tail crosses a real frame: encode, split, read, restore', () => {
    const f32 = new Float32Array(2048).map((_, i) => i / 3);
    const { value, tail } = extractTail(encodeValue({ vec: f32, note: 'x' }));
    const frame = encodeLengthFrame({ t: 'result', id: 1, ok: true, value }, tail)!;
    const r = reader();
    for (let at = 0; at < frame.length; at += 1000) r.socket.push(Buffer.from(frame.subarray(at, at + 1000)));
    expect(r.frames).toHaveLength(1);
    const out = decodeValue(restoreTail(r.frames[0]!.header.value as Wire, r.frames[0]!.tail)) as { vec: Float32Array; note: string };
    expect(Array.from(out.vec)).toEqual(Array.from(f32));
    expect(out.note).toBe('x');
  });

  test('arrays at or under the threshold stay inline and no tail is made', () => {
    const small = { a: new Float32Array(10), b: Buffer.from('hello'), c: new Uint8Array(100), d: new Float64Array(20), e: new Float32Array(TAIL_MIN_BYTES / 4 - 8) };
    const wire = encodeValue(small);
    const { value, tail } = extractTail(wire);
    expect(tail).toBeNull();
    expect(JSON.stringify(value)).toBe(JSON.stringify(wire));
    expect(decodeValue(value)).toEqual(small);
  });

  test('a large and a small array in one value: only the large one moves, and the offsets stay consistent', () => {
    const large = new Float64Array(2000).map((_, i) => i * 1.5);
    const smallU8 = new Uint8Array([9, 8, 7]);
    const { value, tail } = extractTail(encodeValue({ smallU8, large, again: [large] }));
    expect(tail!.length).toBe(large.byteLength * 2);
    const refs = JSON.stringify(value).match(/"off":(\d+),"len":(\d+)/g)!;
    expect(refs).toHaveLength(2);
    const back = decodeValue(restoreTail(JSON.parse(JSON.stringify(value)) as Wire, tail)) as { smallU8: Uint8Array; large: Float64Array; again: Float64Array[] };
    expect(Array.from(back.smallU8)).toEqual([9, 8, 7]);
    expect(Array.from(back.large)).toEqual(Array.from(large));
    expect(Array.from(back.again[0]!)).toEqual(Array.from(large));
  });

  test('restoreTail throws on a reference that is out of range, negative, non-integer, unknown, or has no tail', () => {
    const tail = Buffer.alloc(100, 1);
    const ref = (over: Record<string, unknown>) => ({ v: { $t: 'tail', of: 'u8', off: 0, len: 10, ...over } }) as unknown as Wire;
    for (const bad of [{ off: 95, len: 10 }, { off: 101, len: 0 }, { off: -1, len: 5 }, { off: 0, len: -5 }, { off: 0.5, len: 5 }, { off: 0, len: 1.5 },
      { off: 'x' }, { len: undefined }, { of: 'nope' }, { of: 5 }, { off: Number.MAX_SAFE_INTEGER, len: Number.MAX_SAFE_INTEGER }]) {
      expect(() => restoreTail(ref(bad), tail)).toThrow();
    }
    expect(() => restoreTail(ref({}), null)).toThrow();
    expect(() => restoreTail({ deep: [{ v: { $t: 'tail', of: 'f32', off: 0, len: 4 } }] } as unknown as Wire, null)).toThrow();
    // A valid reference at the very end of the tail restores.
    expect(() => restoreTail(ref({ off: 90, len: 10 }), tail)).not.toThrow();
    expect(() => restoreTail(ref({ off: 100, len: 0 }), tail)).not.toThrow();
    // A value with no reference needs no tail.
    expect(restoreTail({ a: 1, b: [2, 'x'] } as unknown as Wire, null)).toEqual({ a: 1, b: [2, 'x'] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TLS and the owner_busy retry on a real owner server
// ---------------------------------------------------------------------------------------------------------------------

const OWNER_TOKEN = 'gbrain_owner_tls_test_token';
const ownerInfo = { principal: { kind: 'legacy_token', id: 'tok-1' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null, expiresAt: Math.floor(Date.now() / 1000) + 3600 };

let dir: string;
let tls: { cert: Buffer; key: Buffer };
let verifyCalls = 0;
let gate: Promise<void> | null = null;
let started = 0;
const owners: OwnerEngineServer[] = [];
const listeners: ServedListener[] = [];
const conns: ServedConnection[] = [];

const fake = {
  kind: 'rust', capabilities: new Set<string>(['persistence_journal']),
  getConfig: async (key: string) => key === OWNER_TOKEN_IDS_CONFIG_KEY ? JSON.stringify(['tok-1']) : null,
  getPage: async (slug: unknown) => ({ slug, title: 'T' }),
  // Echoes its argument back, so a large vector crosses the wire in both directions.
  putPage: async (slug: unknown, body: unknown) => { started++; if (gate) await gate; return { slug, body }; },
} as unknown as BrainEngine;

const servedOpts = (): ServedServerOptions => ({
  verify: {
    verify: async (_engine, token) => {
      verifyCalls++;
      if (token === OWNER_TOKEN) return { ...ownerInfo };
      throw new Error('Invalid token');
    },
  },
  positions: async () => ({ sequence: 1, index: 0, exact: true }),
  helloTimeoutMs: 2_000,
  log: () => {},
});

async function host(opts: { tls?: boolean; permits?: number; maxQueued?: number; listenHost?: string } = {}): Promise<{ server: OwnerEngineServer; listener: ServedListener }> {
  const server = (await serveOwnerEngine(fake, join(dir, `owner-${owners.length}.sock`), {
    served: servedOpts(),
    ...(opts.permits !== undefined ? { permits: opts.permits } : {}),
    ...(opts.maxQueued !== undefined ? { maxQueued: opts.maxQueued } : {}),
  }))!;
  owners.push(server);
  const listener = await listenServed(server, { host: opts.listenHost ?? '127.0.0.1', port: 0, ...(opts.tls === false ? {} : { tls }) });
  listeners.push(listener);
  return { server, listener };
}

async function connect(url: string, opts: Parameters<typeof connectServed>[1] = {}): Promise<ServedConnection> {
  const c = await connectServed(url, { token: OWNER_TOKEN, ...opts });
  conns.push(c);
  return c;
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; reason?: string; message: string });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-served-tls-test-'));
  // The throwaway certificate of the served arm (test/engine-parity/rust-arm.ts): CN and SAN localhost, one day.
  const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`openssl could not make the test certificate: ${run.stderr.toString()}`);
  tls = { cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) };
});

afterEach(() => { for (const c of conns.splice(0)) c.close(); gate = null; });

afterAll(async () => {
  for (const c of conns.splice(0)) c.close();
  for (const l of listeners.splice(0)) await l.close();
  for (const s of owners.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TLS', () => {
  test('a client that trusts the certificate connects over gbrain+tls://localhost and a call with a large vector crosses by binary tail both ways', async () => {
    const { listener } = await host();
    expect(listener.tls).toBe(true);
    const c = await connect(`gbrain+tls://localhost:${listener.port}`, { ca: tls.cert });
    expect(c.network).toBe(true);
    expect(c.hello.version).toBe(3);
    expect(c.caps.has('binary_tail')).toBe(true);
    expect(await c.request('call', 'getPage', ['a'])).toEqual({ slug: 'a', title: 'T' });
    const vec = new Float32Array(16_384).map((_, i) => Math.fround(Math.sin(i) * 100));
    const payload = Buffer.alloc(40_000); for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) % 256;
    const out = await c.request('call', 'putPage', ['v', { embedding: vec, raw: payload, small: new Float32Array([1, 2]) }]) as
      { slug: string; body: { embedding: Float32Array; raw: Buffer; small: Float32Array } };
    expect(out.slug).toBe('v');
    expect(out.body.embedding).toBeInstanceOf(Float32Array);
    expect(Buffer.from(out.body.embedding.buffer, out.body.embedding.byteOffset, out.body.embedding.byteLength)
      .equals(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength))).toBe(true);
    expect(Buffer.from(out.body.raw).equals(payload)).toBe(true);
    expect(Array.from(out.body.small)).toEqual([1, 2]);
  });

  test('a client that does not trust the certificate gets owner_unavailable tls_untrusted and no token reaches the server', async () => {
    const { listener } = await host();
    const before = verifyCalls;
    const error = await failure(connectServed(`gbrain+tls://localhost:${listener.port}`, { token: OWNER_TOKEN }));
    expect({ code: error?.code, reason: error?.reason }).toEqual({ code: 'owner_unavailable', reason: 'tls_untrusted' });
    expect(error!.message).not.toContain(OWNER_TOKEN);
    await Bun.sleep(100);
    expect(verifyCalls).toBe(before);
  });

  test('a host name the certificate does not name (127.0.0.2, or a CA that is some other certificate) is tls_untrusted and sends no token', async () => {
    const { listener } = await host({ listenHost: '127.0.0.2' });
    const before = verifyCalls;
    // 127.0.0.2 (this machine's loopback, where the listener is) reaches this machine's loopback, but the certificate names only DNS:localhost.
    const mismatch = await failure(connectServed(`gbrain+tls://127.0.0.2:${listener.port}`, { token: OWNER_TOKEN, ca: tls.cert }));
    expect({ code: mismatch?.code, reason: mismatch?.reason }).toEqual({ code: 'owner_unavailable', reason: 'tls_untrusted' });
    // A second, unrelated certificate as the only trusted CA.
    const other = mkdtempSync(join(dir, 'other-'));
    const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(other, 'key.pem'), '-out', join(other, 'cert.pem')], { stderr: 'pipe' });
    expect(run.exitCode).toBe(0);
    const local = await host();
    const stranger = await failure(connectServed(`gbrain+tls://localhost:${local.listener.port}`, { token: OWNER_TOKEN, ca: readFileSync(join(other, 'cert.pem')) }));
    expect({ code: stranger?.code, reason: stranger?.reason }).toEqual({ code: 'owner_unavailable', reason: 'tls_untrusted' });
    await Bun.sleep(100);
    expect(verifyCalls).toBe(before);
  });

  test('a TLS client to a plain-TCP listener, and a plain client to a TLS listener, fail without running anything', async () => {
    const plain = await host({ tls: false });
    const a = await failure(connectServed(`gbrain+tls://localhost:${plain.listener.port}`, { token: OWNER_TOKEN, ca: tls.cert, timeoutMs: 1_500 }));
    expect(a?.code).toBe('owner_unavailable');
    const secure = await host();
    const before = verifyCalls;
    const b = await failure(connectServed(`gbrain+tcp://127.0.0.1:${secure.listener.port}`, { token: OWNER_TOKEN, timeoutMs: 1_500 }));
    expect(b?.code).toBe('owner_unavailable');
    expect(verifyCalls).toBe(before);
  });

  test('listenServed without TLS on a non-loopback host refuses with config_error and opens no socket', async () => {
    const server = (await serveOwnerEngine(fake, join(dir, 'owner-refuse.sock'), { served: servedOpts() }))!;
    owners.push(server);
    for (const hostName of ['0.0.0.0', '::', '192.0.2.10', 'example.com']) {
      const error = await failure(listenServed(server, { host: hostName, port: 0 }));
      expect({ host: hostName, code: error?.code }).toEqual({ host: hostName, code: 'config_error' });
    }
    // Loopback without TLS is allowed, and the same owner can still listen after the refusals.
    const ok = await listenServed(server, { host: '127.0.0.1', port: 0 });
    listeners.push(ok);
    expect(ok.tls).toBe(false);
    const c = await connect(`gbrain+tcp://127.0.0.1:${ok.port}`);
    expect(await c.request('call', 'getPage', ['z'])).toEqual({ slug: 'z', title: 'T' });
  });

  test('parseServedUrl refuses plain TCP to a non-loopback host and any URL that carries user:pass@', () => {
    for (const url of ['gbrain+tcp://10.0.0.5:4141', 'gbrain+tcp://example.com:4141', 'gbrain+tcp://0.0.0.0:4141', 'gbrain+tcp://127.0.0.1.evil.test:4141']) {
      let caught: { code?: string } | null = null;
      try { parseServedUrl(url); } catch (e) { caught = e as { code?: string }; }
      expect({ url, code: caught?.code }).toEqual({ url, code: 'config_error' });
    }
    for (const url of ['gbrain+tls://user:pass@example.com:4141', 'gbrain+tcp://user:pass@127.0.0.1:4141', 'gbrain+tls://token@example.com:4141', 'gbrain+tls://example.com', 'https://example.com:4141', 'gbrain+tls://example.com:4141/extra']) {
      let caught: { code?: string } | null = null;
      try { parseServedUrl(url); } catch (e) { caught = e as { code?: string }; }
      expect({ url, code: caught?.code }).toEqual({ url, code: 'config_error' });
    }
    expect(parseServedUrl('gbrain+tls://brain.example.com:4141')).toEqual({ kind: 'tls', host: 'brain.example.com', port: 4141 });
    expect(parseServedUrl('gbrain+tcp://127.0.0.1:4141')).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 4141 });
    expect(parseServedUrl('gbrain+tcp://localhost:4141')).toEqual({ kind: 'tcp', host: 'localhost', port: 4141 });
    expect(parseServedUrl('gbrain+tcp://[::1]:4141')).toEqual({ kind: 'tcp', host: '::1', port: 4141 });
    expect(parseServedUrl('gbrain+unix:///tmp/owner.sock')).toEqual({ kind: 'unix', path: '/tmp/owner.sock' });
  });
});

describe('owner_busy', () => {
  test('a busy owner is retried by the client: the second call resolves once the first finishes', async () => {
    const { listener } = await host({ permits: 1, maxQueued: 0 });
    let open!: () => void;
    gate = new Promise<void>(r => { open = r; });
    started = 0;
    const first = await connect(`gbrain+tls://localhost:${listener.port}`, { ca: tls.cert });
    const second = await connect(`gbrain+tls://localhost:${listener.port}`, { ca: tls.cert });
    const a = first.request('call', 'putPage', ['one', 'A']);
    for (let i = 0; i < 100 && started < 1; i++) await Bun.sleep(10);
    expect(started).toBe(1);
    // The owner has one permit and no queue: the second call is refused owner_busy on the server, and retried.
    let settled = false;
    const b = second.request('call', 'putPage', ['two', 'B']).finally(() => { settled = true; });
    await Bun.sleep(300);
    expect(settled).toBe(false);
    expect(started).toBe(1);
    gate = null;
    open();
    expect(await a).toEqual({ slug: 'one', body: 'A' });
    expect(await b).toEqual({ slug: 'two', body: 'B' });
    expect(started).toBe(2);
  });

  // Decision R: a busy owner is retried until the caller's deadline, and then the caller sees `timeout`.
  test('with a short read deadline the busy caller ends with a timeout code, never owner_busy, and the call never ran', async () => {
    const { listener } = await host({ permits: 1, maxQueued: 0 });
    let open!: () => void;
    gate = new Promise<void>(r => { open = r; });
    started = 0;
    const first = await connect(`gbrain+tls://localhost:${listener.port}`, { ca: tls.cert });
    const second = await connect(`gbrain+tls://localhost:${listener.port}`, { ca: tls.cert });
    const a = first.request('call', 'putPage', ['hold', 'A']);
    for (let i = 0; i < 100 && started < 1; i++) await Bun.sleep(10);
    expect(started).toBe(1);
    try {
      const startedAt = Date.now();
      const error = await failure(withReadDeadline(Date.now() + 400, () => second.request('call', 'getPage', ['late'])));
      const waited = Date.now() - startedAt;
      expect(error?.code).toBe('timeout');
      // It waited about its own deadline (plus the client's 2 s grace at most), not the 60 s default.
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(6_000);
      expect(started).toBe(1);
    } finally { open(); await a; }
  });
});
