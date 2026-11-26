/**
 * The served follower path end to end (multi-user Rust): a real Rust primary in multi-user mode with its commit log,
 * protocol v3 follower frames over the real length framing, lane L2's napi follower, and the store.
 *
 * Mode: the test turns multi-user mode and the commit log on in-run (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1
 * set after the test preload, the GBRAIN_TEST_RUST_MU mechanism), then asserts the primary's store reports
 * `multiuser: true` and `commitLog: true` and the engine reports `commit_log`. An environment variable set outside
 * would be stripped by the preload, and the run would be mode-off.
 *
 * 1. Protects: an empty follower refuses records with the store's `snapshot_required`, returned in `repl_ack`
 *    unchanged; a whole-brain snapshot crosses in chunks and installs at the primary's position; later records apply
 *    and the follower's cursor reaches the primary's newest commit; the same records again apply nothing; a snapshot
 *    behind the follower refuses with the store's `invalid_state`, returned unchanged, and moves nothing back.
 * 2. Fails on: the follower path unwired, a refusal rewritten on its way back, a cursor that does not reach the
 *    primary's, a second apply that writes again, an install that moves the follower backwards.
 * 3. Existing coverage: rust-served-follower-frames.test.ts covers the codecs alone; L2's Rust tests cover the store.
 * 4. Seam: none below the frames: real addon, real store files, real framing. Needs the addon `bun run rust:build`
 *    writes from a tree with L2's follower napi.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import type { RustStore } from '../src/core/rust-engine/store.ts';
import { encodeLengthFrame, readLengthFrames, byteBudget } from '../src/core/rust-engine/served/framing.ts';
import { decodeError, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { FollowerApplier, primaryRecordsFrame, primarySnapshotFrames, type FollowerNapi } from '../src/core/rust-engine/served/follower-apply.ts';
import { decodeReplRecords } from '../src/core/rust-engine/served/follower-frames.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

type Frame = { header: Record<string, unknown>; tail: Buffer | null };
interface FollowerHandle extends FollowerNapi {
  open(dir: string): Promise<{ cursor: unknown }>;
  close(): Promise<unknown>;
  cursor(): Promise<{ sequence: number; index: number } | null>;
}
type Addon = { Pool: new (n: number) => { shutdown(ms: number): Promise<unknown> }; Follower: new (pool: unknown) => FollowerHandle };

const saved = { mu: process.env.GBRAIN_RUST_MULTIUSER, log: process.env.GBRAIN_RUST_COMMIT_LOG };
const dirs: string[] = [];
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-follower-${name}-`)); dirs.push(d); return d; };

/** Every frame crosses the real length framing, as a socket carries it. */
async function overWire(frames: Frame[]): Promise<Frame[]> {
  const stream = new PassThrough() as unknown as Socket;
  const got: Frame[] = [];
  const done = new Promise<void>(resolve => {
    readLengthFrames(stream, { maxFrameBytes: () => 1 << 27, budget: byteBudget(1 << 30), onBad: () => {},
      onFrame: (header, tail) => { got.push({ header, tail }); if (got.length === frames.length) resolve(); } });
  });
  for (const f of frames) (stream as unknown as PassThrough).write(encodeLengthFrame(f.header, f.tail)!);
  if (frames.length) await done;
  return got;
}

/** Sends `frames` to the follower and returns every frame it answers with. */
async function deliver(applier: FollowerApplier, frames: Frame[]): Promise<Frame[]> {
  const replies: Frame[] = [];
  for (const f of await overWire(frames)) replies.push(...await applier.onFrame(f.header, f.tail));
  return overWire(replies);
}

const acks = (frames: Frame[]) => frames.filter(f => f.header.t === 'repl_ack').map(f => f.header);
const refusal = (ack: Record<string, unknown>) => decodeError(ack.error as Wire) as { code?: string; message?: string };

describeAddon('the served follower path: frames, napi and store', () => {
  let addon: Addon;
  let primary: RustEngine;
  let store: RustStore;
  let pool: { shutdown(ms: number): Promise<unknown> };
  let follower: FollowerHandle;
  let applier: FollowerApplier;
  let brainId = '';

  beforeAll(async () => {
    // Mode on in-run, after the preload (see the file note); asserted below.
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    process.env.GBRAIN_RUST_COMMIT_LOG = '1';
    addon = await loadRustArmAddon() as unknown as Addon;
    const dir = tmp('primary');
    primary = openRustEngine({ addon: addon as never, databasePath: dir });
    await primary.connect({ engine: 'rust', database_path: dir } as never);
    store = primary.openStore('follower-test');
    for (const slug of ['notes/one', 'notes/two']) {
      await primary.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' } as never);
    }
    brainId = String((await store.brain.readCommitLogRaw(null, 1) as { brainId?: string; brain_id?: string }).brainId
      ?? (await store.brain.readCommitLogRaw(null, 1) as { brain_id?: string }).brain_id);
    pool = new addon.Pool(2);
    follower = new addon.Follower(pool);
    await follower.open(join(tmp('follower'), 'brain'));
    applier = new FollowerApplier(follower, { brainId, stagingDir: tmp('staging'), maxBytes: 1 << 30 });
  }, 120_000);

  afterAll(async () => {
    await applier?.close();
    await follower?.close().catch(() => undefined);
    await pool?.shutdown(1000).catch(() => undefined);
    await primary?.disconnect().catch(() => undefined);
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); rmSync(`${d}.gbrain-owner.lock`, { force: true }); }
    if (saved.mu === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved.mu;
    if (saved.log === undefined) delete process.env.GBRAIN_RUST_COMMIT_LOG; else process.env.GBRAIN_RUST_COMMIT_LOG = saved.log;
  });

  test('the primary runs in multi-user mode with a commit log', () => {
    expect({ multiuser: store.multiuser, commitLog: store.commitLog, cap: primary.capabilities.has('commit_log' as never) })
      .toEqual({ multiuser: true, commitLog: true, cap: true });
    expect(brainId).not.toBe('');
  });

  let snapshotFrames: Frame[] = [];
  let snapshotCursor: { sequence: number; index: number } | null = null;

  test('an empty follower refuses records with the store\'s snapshot_required, unchanged in repl_ack', async () => {
    const records = await primaryRecordsFrame(store, null, 100, 1, 1);
    expect(records).not.toBeNull();
    // What the store says directly, for the very records the frame carries.
    const decoded = decodeReplRecords(records!.header, records!.tail);
    const direct = await follower.applyRaw(decoded.brainId, decoded.lineage,
      decoded.records.map(r => ({ sequence: r.position.sequence, index: r.position.index, bytes: r.bytes })))
      .then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(direct?.code).toBe('snapshot_required');
    const [ack] = acks(await deliver(applier, [records!]));
    expect(ack).toMatchObject({ t: 'repl_ack', id: 1, seq: 1, ok: false });
    // Unchanged: the same code and the same message the store gave.
    expect({ code: refusal(ack!).code, message: refusal(ack!).message }).toEqual({ code: direct!.code, message: direct!.message });
    expect(await follower.cursor()).toBeNull();
  });

  test('a whole snapshot crosses in chunks, installs, and the follower stands at the snapshot', async () => {
    snapshotFrames = await primarySnapshotFrames(store, { id: 2, xfer: 'snap-1', chunkBytes: 4096, stagingDir: tmp('primary-snap') });
    expect(snapshotFrames.filter(f => f.header.t === 'repl_snap_chunk').length).toBeGreaterThan(1);
    const replies = await deliver(applier, snapshotFrames);
    const [ack] = acks(replies);
    expect(ack).toMatchObject({ t: 'repl_ack', id: 2, seq: 0, ok: true });
    snapshotCursor = ack!.cursor as { sequence: number; index: number };
    expect(await follower.cursor()).toEqual(snapshotCursor);
    expect(replies.some(f => f.header.t === 'repl_snap_window')).toBe(true);
  });

  test('later records apply, the cursor reaches the primary\'s newest commit, and applying them again writes nothing', async () => {
    for (const slug of ['notes/three', 'notes/four']) {
      await primary.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' } as never);
    }
    const frame = await primaryRecordsFrame(store, snapshotCursor, 100, 3, 2);
    expect(frame).not.toBeNull();
    const [ack] = acks(await deliver(applier, [frame!]));
    expect(ack).toMatchObject({ t: 'repl_ack', id: 3, seq: 2, ok: true });
    expect(ack!.applied as number).toBeGreaterThan(0);
    const page = await store.brain.readCommitLogRaw(null, 1_000) as { newest: { sequence: number; index: number } | null };
    expect(await follower.cursor()).toEqual(page.newest as never);
    const [again] = acks(await deliver(applier, [{ header: { ...frame!.header, seq: 3 }, tail: frame!.tail }]));
    expect(again).toMatchObject({ ok: true, applied: 0 });
    expect(again!.skipped as number).toBe(ack!.applied as number);
  });

  test('a snapshot behind the follower refuses with the store\'s invalid_state, unchanged, and moves nothing back', async () => {
    const before = await follower.cursor();
    const replay = snapshotFrames.map(f => ({ header: { ...f.header, id: 4, xfer: 'snap-old' }, tail: f.tail }));
    const [ack] = acks(await deliver(applier, replay));
    expect(ack).toMatchObject({ t: 'repl_ack', id: 4, seq: 0, ok: false });
    expect(refusal(ack!)).toMatchObject({ code: 'invalid_state' });
    expect(String(refusal(ack!).message)).toContain('snapshot refused');
    expect(await follower.cursor()).toEqual(before);
  });
});
