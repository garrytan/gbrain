/**
 * A follower whose log holds records its primary never had (a diverged tail; rust/docs/store/commit-log.md, "Diverged
 * tail recovery") on the follower side of the wire (src/core/rust-engine/served/follower-apply.ts).
 *
 * 1. Protects: with `divergedTailExport` set, a `diverged_tail` refusal writes the tail to that directory once
 *    (against the primary's lineage from its newest records frame), permits one install over it, and retries the
 *    install once; the records refusal still goes back to the primary unchanged, so it answers with a snapshot.
 *    Without the option, or with an export already on disk, nothing new is written.
 * 2. Fails on: an install over a diverged tail with no export; a second export over an existing one; a refusal turned
 *    into success; an install retried more than once; an export against a lineage the primary never sent.
 * 3. Existing coverage: the store's export, permit and install are rust/crates/gbrain-store/tests/follower.rs and
 *    `--lib diverged_tail`; the napi calls are rust-follower-napi.test.ts.
 * 4. Seam: a fake `FollowerNapi` whose apply and install refuse `diverged_tail` as the store does; the frames are the
 *    real codec and snapshot receiver.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowerApplier, type FollowerNapi } from '../src/core/rust-engine/served/follower-apply.ts';
import {
  encodeReplRecords, encodeSnapshotBegin, encodeSnapshotChunk, encodeSnapshotEnd, type SnapshotManifestWire,
} from '../src/core/rust-engine/served/follower-frames.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-diverged-')); dirs.push(d); return d; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const BRAIN = 'brain-a';
const THEIRS = [{ id: '0193f6a0-0000-7000-8000-00000000000a', from: { sequence: 0, index: 0 } }];
const diverged = () => Object.assign(new Error('the follower holds records the primary never had'), { code: 'diverged_tail' });

/** The store's behavior: refuses while diverged, until an install is permitted over an export. */
function fakeFollower() {
  const calls: string[] = [];
  const state = { permitted: false, installs: 0 };
  const napi: FollowerNapi = {
    applyRaw: async () => { calls.push('apply'); throw diverged(); },
    installSnapshot: async () => {
      calls.push('install'); state.installs++;
      if (!state.permitted) throw diverged();
      state.permitted = false;
      return { sequence: 42, index: 0 };
    },
    exportDivergedTail: async (dir, lineage) => { calls.push(`export:${lineage[0]?.id}`); mkdirSync(dir); return { records: 3 }; },
    allowInstallOver: async () => { calls.push('allow'); state.permitted = true; return null; },
  };
  return { napi, calls, state };
}

function snapshotFrames() {
  const manifest: SnapshotManifestWire = {
    version: 1, brain_id: BRAIN, generation: 42, engine_format_version: 13, schema_version: 341, keys: 1, bytes: 4,
    tags: { '01': { keys: 1, sha256: 'a'.repeat(64) } }, created_at_us: 1_795_000_000_000_000,
  };
  const files = [
    { name: 'records.redb', bytes: Buffer.from('redb') },
    { name: 'FORMAT', bytes: Buffer.from('13\n') },
    { name: 'SNAPSHOT.json', bytes: Buffer.from(JSON.stringify(manifest)) },
  ];
  return {
    begin: encodeSnapshotBegin({ id: 1, xfer: 'x1', manifest, files: files.map(f => ({ name: f.name, bytes: f.bytes.length, sha256: sha(f.bytes) })) }),
    chunks: files.map(f => encodeSnapshotChunk({ id: 1, xfer: 'x1', file: f.name, off: 0, bytes: f.bytes })),
    end: encodeSnapshotEnd({ id: 1, xfer: 'x1' }),
  };
}

async function install(applier: FollowerApplier) {
  const s = snapshotFrames();
  await applier.onFrame(s.begin, null);
  for (const c of s.chunks) await applier.onFrame(c.header, c.tail);
  return (await applier.onFrame(s.end, null))[0]!.header;
}

const records = (seq: number) => encodeReplRecords({ id: 1, seq, brainId: BRAIN, lineage: THEIRS, records: [{ position: { sequence: 5, index: 0 }, bytes: Buffer.from('r') }] });

describe('a diverged tail on the follower side of the wire', () => {
  test('records refused diverged_tail: the tail is exported against the primary lineage, the refusal still goes back, and the snapshot installs once', async () => {
    const { napi, calls } = fakeFollower();
    const exportDir = join(tmp(), 'tail');
    const applier = new FollowerApplier(napi, { brainId: BRAIN, stagingDir: tmp(), maxBytes: 1 << 20, divergedTailExport: exportDir });
    const r = records(1);
    const [ack] = await applier.onFrame(r.header, r.tail);
    expect(ack!.header).toMatchObject({ t: 'repl_ack', seq: 1, ok: false });
    expect((ack!.header.error as Record<string, unknown> | undefined)).toBeDefined();
    expect(JSON.stringify(ack!.header.error)).toContain('diverged_tail');
    expect(await install(applier)).toMatchObject({ t: 'repl_ack', ok: true, cursor: { sequence: 42, index: 0 } });
    expect(calls).toEqual(['apply', `export:${THEIRS[0]!.id}`, 'allow', 'install']);
  });

  test('without divergedTailExport the refusal stands and nothing is written', async () => {
    const { napi, calls } = fakeFollower();
    const applier = new FollowerApplier(napi, { brainId: BRAIN, stagingDir: tmp(), maxBytes: 1 << 20 });
    const r = records(1);
    await applier.onFrame(r.header, r.tail);
    expect(await install(applier)).toMatchObject({ ok: false });
    expect(calls).toEqual(['apply', 'install']);
  });

  test('an export already on disk is never written over: the install is permitted from it (after a restart)', async () => {
    const { napi, calls } = fakeFollower();
    const exportDir = join(tmp(), 'tail');
    mkdirSync(exportDir);
    const applier = new FollowerApplier(napi, { brainId: BRAIN, stagingDir: tmp(), maxBytes: 1 << 20, divergedTailExport: exportDir });
    expect(await install(applier)).toMatchObject({ ok: true });
    expect(calls).toEqual(['install', 'allow', 'install']);
  });

  test('a snapshot first, with no records frame seen, cannot export (no primary lineage) and stays refused', async () => {
    const { napi, calls } = fakeFollower();
    const applier = new FollowerApplier(napi, { brainId: BRAIN, stagingDir: tmp(), maxBytes: 1 << 20, divergedTailExport: join(tmp(), 'tail') });
    expect(await install(applier)).toMatchObject({ ok: false });
    expect(calls).toEqual(['install']);
  });

  test('an install still refused after the permit is retried only once', async () => {
    const { napi, calls, state } = fakeFollower();
    napi.allowInstallOver = async () => { calls.push('allow'); return null; }; // permit that does not take
    const applier = new FollowerApplier(napi, { brainId: BRAIN, stagingDir: tmp(), maxBytes: 1 << 20, divergedTailExport: join(tmp(), 'tail') });
    const r = records(1);
    await applier.onFrame(r.header, r.tail);
    expect(await install(applier)).toMatchObject({ ok: false });
    expect(state.installs).toBe(2);
  });
});
