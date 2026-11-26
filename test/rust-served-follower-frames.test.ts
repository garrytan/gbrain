/**
 * Protocol v3 frames that carry a follower's replication (src/core/rust-engine/served/follower-frames.ts; design note
 * "M1 as built", "Follower frames"): `repl_records` carries `Follower::apply_raw(brain_id, lineage, records)` from the
 * primary to a follower, and `repl_snap_begin` / `repl_snap_chunk` / `repl_snap_end` / `repl_snap_window` carry a
 * whole-brain snapshot in chunked binary tails, with a manifest checked before any byte is accepted.
 *
 * 1. Protects: record bytes cross unchanged (I-4.v2: raw record bytes ship as they are), positions keep their u64/u32
 *    range, a snapshot is never installed from a file that is short, long, out of order or of another brain, and a
 *    receiver never writes outside its staging directory.
 * 2. Fails on: any byte of a record changed or reordered; a position past 2^53 or an index past u32; overlapping or
 *    out-of-range tail slices; a manifest of another brain or of another shape; a chunk at the wrong offset or past
 *    its file; a file name with a path; a digest mismatch; SNAPSHOT.json written before the data files.
 * 3. Existing coverage: none (new frames). The existing v2/v3 frames are pinned by rust-owner-ipc-frames.test.ts,
 *    rust-served-wire.test.ts and rust-served-tls-framing.test.ts; this file also pins that the server's hello caps
 *    did not change (the new frames are not offered).
 * 4. Seam: pure codec functions and a receiver over a temporary directory; the length framing is framing.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOLLOWER_CAP, REPL_FRAME_TYPES, SNAPSHOT_FILES, decodeReplRecords, decodeSnapshotBegin, decodeSnapshotChunk,
  encodeReplRecords, encodeSnapshotBegin, encodeSnapshotChunk, encodeSnapshotEnd, encodeSnapshotWindow,
  SnapshotReceiver, type SnapshotManifestWire,
} from '../src/core/rust-engine/served/follower-frames.ts';
import { encodeLengthFrame, readLengthFrames, byteBudget } from '../src/core/rust-engine/served/framing.ts';
import { SERVED_SERVER_CAPS } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-follower-frames-')); dirs.push(d); return d; };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Round trip through the real length framing, so tails and headers are what a socket carries. */
async function overWire(header: object, tail: Buffer | null): Promise<{ header: Record<string, unknown>; tail: Buffer | null }> {
  const stream = new PassThrough() as unknown as Socket;
  const got = new Promise<{ header: Record<string, unknown>; tail: Buffer | null }>(resolve =>
    readLengthFrames(stream, { maxFrameBytes: () => 1 << 27, budget: byteBudget(1 << 30), onFrame: (h, t) => resolve({ header: h, tail: t }), onBad: () => {} }));
  (stream as unknown as PassThrough).write(encodeLengthFrame(header, tail)!);
  return got;
}

const manifest = (over: Partial<SnapshotManifestWire> = {}): SnapshotManifestWire => ({
  version: 1, brain_id: 'brain-a', generation: 42, engine_format_version: 13, schema_version: 341, keys: 3, bytes: 900,
  tags: { '01': { keys: 2, sha256: 'a'.repeat(64) }, '0f': { keys: 1, sha256: 'b'.repeat(64) } }, created_at_us: 1_795_000_000_000_000,
  ...over,
});

describe('repl_records: apply_raw(brain_id, lineage, records)', () => {
  test('round-trips every record byte for byte, in order, through the length framing', async () => {
    const records = [
      { position: { sequence: 7, index: 0 }, bytes: randomBytes(10) },
      { position: { sequence: 7, index: 1 }, bytes: Buffer.alloc(0) },
      { position: { sequence: 2 ** 53 - 1, index: 0xffff_ffff }, bytes: randomBytes(70_000) },
    ];
    const lineage = [{ id: '0193f6a0-0000-7000-8000-000000000001', from: { sequence: 3, index: 2 } }];
    const { header, tail } = encodeReplRecords({ id: 9, seq: 1, brainId: 'brain-a', lineage, records });
    const wire = await overWire(header, tail);
    const back = decodeReplRecords(wire.header, wire.tail);
    expect(back.brainId).toBe('brain-a');
    expect(back.lineage).toEqual(lineage);
    expect(back.records.map(r => r.position)).toEqual(records.map(r => r.position));
    expect(back.records.map(r => sha(r.bytes))).toEqual(records.map(r => sha(r.bytes)));
  });

  test('the header names its layout exactly', () => {
    const { header, tail } = encodeReplRecords({ id: 1, seq: 4, brainId: 'b', lineage: [], records: [
      { position: { sequence: 5, index: 0 }, bytes: Buffer.from('ab') }, { position: { sequence: 6, index: 0 }, bytes: Buffer.from('cde') }] });
    expect(header).toEqual({ t: 'repl_records', id: 1, seq: 4, brain_id: 'b', lineage: [],
      records: [{ sequence: 5, index: 0, off: 0, len: 2 }, { sequence: 6, index: 0, off: 2, len: 3 }] });
    expect(tail!.toString()).toBe('abcde');
  });

  test('refuses positions past their range, out of order or repeated, and slices that do not tile the tail', () => {
    const tail = Buffer.from('abcdef');
    const base = { t: 'repl_records', id: 1, seq: 1, brain_id: 'b', lineage: [] };
    const bad: Array<[string, unknown[]]> = [
      ['sequence past 2^53', [{ sequence: 2 ** 53, index: 0, off: 0, len: 6 }]],
      ['index past u32', [{ sequence: 1, index: 2 ** 32, off: 0, len: 6 }]],
      ['negative', [{ sequence: -1, index: 0, off: 0, len: 6 }]],
      ['out of order', [{ sequence: 2, index: 0, off: 0, len: 3 }, { sequence: 1, index: 0, off: 3, len: 3 }]],
      ['repeated', [{ sequence: 1, index: 0, off: 0, len: 3 }, { sequence: 1, index: 0, off: 3, len: 3 }]],
      ['overlap', [{ sequence: 1, index: 0, off: 0, len: 4 }, { sequence: 2, index: 0, off: 3, len: 3 }]],
      ['gap', [{ sequence: 1, index: 0, off: 0, len: 2 }, { sequence: 2, index: 0, off: 3, len: 3 }]],
      ['short of the tail', [{ sequence: 1, index: 0, off: 0, len: 5 }]],
      ['past the tail', [{ sequence: 1, index: 0, off: 0, len: 7 }]],
    ];
    for (const [why, records] of bad) expect(() => decodeReplRecords({ ...base, records }, tail), why).toThrow();
    expect(() => decodeReplRecords({ ...base, brain_id: '', records: [{ sequence: 1, index: 0, off: 0, len: 6 }] }, tail)).toThrow();
    expect(() => decodeReplRecords({ ...base, lineage: [{ id: 'x', from: { sequence: 1.5, index: 0 } }], records: [{ sequence: 1, index: 0, off: 0, len: 6 }] }, tail)).toThrow();
    expect(() => decodeReplRecords({ ...base, records: [] }, tail)).toThrow();
  });
});

describe('snapshot transfer', () => {
  function files() {
    const records = randomBytes(300_000);
    const format = Buffer.from('{"format_version":13}');
    const m = manifest();
    const snapshotJson = Buffer.from(JSON.stringify(m));
    return { m, list: [
      { name: 'records.redb', bytes: records }, { name: 'FORMAT', bytes: format }, { name: 'SNAPSHOT.json', bytes: snapshotJson },
    ] };
  }

  function stream(list: Array<{ name: string; bytes: Buffer }>, m: SnapshotManifestWire, chunk = 64 * 1024) {
    const begin = encodeSnapshotBegin({ id: 1, xfer: 'x1', manifest: m, chunkBytes: chunk,
      files: list.map(f => ({ name: f.name, bytes: f.bytes.length, sha256: sha(f.bytes) })) });
    const chunks: Array<{ header: Record<string, unknown>; tail: Buffer }> = [];
    for (const f of list) for (let off = 0; off < f.bytes.length || (off === 0 && f.bytes.length === 0); off += chunk) {
      const piece = f.bytes.subarray(off, Math.min(f.bytes.length, off + chunk));
      chunks.push(encodeSnapshotChunk({ id: 1, xfer: 'x1', file: f.name, off, bytes: piece }));
      if (f.bytes.length === 0) break;
    }
    return { begin, chunks, end: encodeSnapshotEnd({ id: 1, xfer: 'x1' }) };
  }

  test('a whole snapshot crosses in chunks and lands byte for byte, SNAPSHOT.json last', async () => {
    const { m, list } = files();
    const { begin, chunks, end } = stream(list, m);
    const staging = tmp();
    const rx = new SnapshotReceiver({ dir: staging, expectBrainId: 'brain-a', maxBytes: 1 << 30 });
    rx.begin(decodeSnapshotBegin(begin));
    const order: string[] = [];
    for (const c of chunks) {
      const wire = await overWire(c.header, c.tail);
      rx.chunk(decodeSnapshotChunk(wire.header, wire.tail));
      order.push(String(c.header.file));
    }
    expect(existsSync(join(staging, 'SNAPSHOT.json'))).toBe(false);
    const done = rx.end(end);
    expect(done.manifest).toEqual(m);
    expect(done.dir).toBe(staging);
    for (const f of list) expect(sha(readFileSync(join(staging, f.name)))).toBe(sha(f.bytes));
    expect(readdirSync(staging).sort()).toEqual(['FORMAT', 'SNAPSHOT.json', 'records.redb']);
    expect(order.at(-1)).toBe('SNAPSHOT.json');
  });

  test('the manifest is checked before any byte: another brain, another shape, unknown fields, bad counts', () => {
    const { m, list } = files();
    const staging = tmp();
    const begin = (mm: unknown, fl = list.map(f => ({ name: f.name, bytes: f.bytes.length, sha256: sha(f.bytes) }))) =>
      ({ t: 'repl_snap_begin', id: 1, xfer: 'x1', manifest: mm, chunk_bytes: 65536, files: fl });
    const rx = () => new SnapshotReceiver({ dir: staging, expectBrainId: 'brain-a', maxBytes: 1 << 30 });
    expect(() => rx().begin(decodeSnapshotBegin(begin({ ...m, brain_id: 'brain-b' })))).toThrow();
    for (const bad of [{ ...m, version: 2 }, { ...m, extra: 1 }, { ...m, keys: 4 }, { ...m, tags: { '1': { keys: 3, sha256: 'a'.repeat(64) } } },
      { ...m, tags: { '01': { keys: 3, sha256: 'A'.repeat(64) } } }, { ...m, generation: -1 }, { ...m, bytes: 1.5 }]) {
      expect(() => decodeSnapshotBegin(begin(bad)), JSON.stringify(bad).slice(0, 80)).toThrow();
    }
    // A file list that is not exactly the snapshot's files, or that is larger than the receiver allows.
    expect(() => decodeSnapshotBegin(begin(m, [{ name: '../records.redb', bytes: 1, sha256: 'a'.repeat(64) }]))).toThrow();
    expect(() => decodeSnapshotBegin(begin(m, [{ name: 'records.redb', bytes: 1, sha256: 'a'.repeat(64) }]))).toThrow();
    expect(() => new SnapshotReceiver({ dir: staging, expectBrainId: 'brain-a', maxBytes: 1000 }).begin(decodeSnapshotBegin(begin(m)))).toThrow();
    expect(readdirSync(staging)).toEqual([]);
    expect(SNAPSHOT_FILES).toEqual(['records.redb', 'FORMAT', 'SNAPSHOT.json']);
  });

  test('a chunk at the wrong offset, past its file, of an unknown file or transfer, or a short file at the end refuses', () => {
    const { m, list } = files();
    const { begin, chunks, end } = stream(list, m);
    const mk = () => { const r = new SnapshotReceiver({ dir: tmp(), expectBrainId: 'brain-a', maxBytes: 1 << 30 }); r.begin(decodeSnapshotBegin(begin)); return r; };
    expect(() => mk().chunk(decodeSnapshotChunk({ ...chunks[1]!.header }, chunks[1]!.tail))).toThrow(); // skips offset 0
    expect(() => mk().chunk(decodeSnapshotChunk({ ...chunks[0]!.header, file: 'other' }, chunks[0]!.tail))).toThrow();
    expect(() => mk().chunk(decodeSnapshotChunk({ ...chunks[0]!.header, xfer: 'x2' }, chunks[0]!.tail))).toThrow();
    const r = mk();
    expect(() => r.chunk(decodeSnapshotChunk({ ...chunks[0]!.header }, Buffer.concat([chunks[0]!.tail, Buffer.alloc(300_000)])))).toThrow();
    const short = mk();
    short.chunk(decodeSnapshotChunk(chunks[0]!.header, chunks[0]!.tail));
    expect(() => short.end(end)).toThrow();
  });

  test('a digest that does not match refuses as soon as its file is complete; SNAPSHOT.json that is not the begin manifest refuses at the end', () => {
    const { m, list } = files();
    const tampered = list.map(f => f.name === 'records.redb' ? { ...f, bytes: Buffer.from(f.bytes) } : f);
    const { begin, chunks, end } = stream(list, m);
    tampered[0]!.bytes[5] ^= 0xff;
    const rx = new SnapshotReceiver({ dir: tmp(), expectBrainId: 'brain-a', maxBytes: 1 << 30 });
    rx.begin(decodeSnapshotBegin(begin));
    const bad = stream(tampered, m).chunks;
    expect(() => { for (const c of bad) rx.chunk(decodeSnapshotChunk(c.header, c.tail)); rx.end(end); }).toThrow(/sha256/);
    expect(existsSync(join(String((rx as unknown as { opts: { dir: string } }).opts.dir), 'SNAPSHOT.json'))).toBe(false);
    const other = { ...m, generation: 43 };
    const list2 = list.map(f => f.name === 'SNAPSHOT.json' ? { ...f, bytes: Buffer.from(JSON.stringify(other)) } : f);
    const s2 = stream(list2, m);
    const rx2 = new SnapshotReceiver({ dir: tmp(), expectBrainId: 'brain-a', maxBytes: 1 << 30 });
    rx2.begin(decodeSnapshotBegin(s2.begin));
    for (const c of s2.chunks) rx2.chunk(decodeSnapshotChunk(c.header, c.tail));
    expect(() => rx2.end(s2.end)).toThrow(/manifest/i);
  });

  test('the window frame names how far the follower has written', () => {
    expect(encodeSnapshotWindow({ id: 1, xfer: 'x1', file: 'records.redb', through: 65536 })).toEqual(
      { t: 'repl_snap_window', id: 1, xfer: 'x1', file: 'records.redb', through: 65536 });
  });
});

describe('off is identical', () => {
  test('the new frames are not offered: the server caps and the frame types of v2/v3 are unchanged', () => {
    expect([...SERVED_SERVER_CAPS]).toEqual(['request_ids', 'positions', 'whole_ops', 'binary_tail', 'remote_check', 'callbacks', 'txn']);
    expect((SERVED_SERVER_CAPS as readonly string[]).includes(FOLLOWER_CAP)).toBe(false);
    expect([...REPL_FRAME_TYPES]).toEqual(['repl_follow', 'repl_records', 'repl_ack', 'repl_snap_begin', 'repl_snap_chunk', 'repl_snap_window', 'repl_snap_end']);
  });
});
