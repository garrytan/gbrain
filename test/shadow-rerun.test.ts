/**
 * The stable-generation barrier of the shadow rerun (plan a2, decision 7; review F2) on PGLite. A real serving process
 * (supervisor, follower, ask handler) joined to a real shadow child whose Rust engine and follow store are fakes the test
 * pauses and fails at chosen points. The rerun outcomes themselves are in test/helpers/shadow-checks-scenarios.ts.
 *
 * Protects: the barrier waits out a multi-chunk batch paused after its first chunk and a batch that names several
 * relations; a reconcile call between the barrier and the Rust read moves the stamp so the read does not run; sustained
 * writes end in `busy`, a child that is gone or an epoch that moved ends the rerun: all leave the sample inconclusive.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeAskHandler } from '../src/shadow/checks.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { FollowChild } from '../src/shadow/follow-child.ts';
import { writeSeedRecord } from '../src/shadow/seed.ts';
import { batch, gate, sample, SEED, sleep, startRig, until, type Rig, type RigOptions } from './helpers/shadow-stable-harness.ts';

let engine: PGLiteEngine;
let dataDir: string;
const rigs: Rig[] = [];
const keys = (n: number) => Array.from({ length: n }, (_, i) => [`k${i}`]);
const rows = (rig: Rig, n = 1) => rig.finish(n);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-rerun-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir } as never);
  await engine.initSchema();
  await engine.putPage('open/a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '' });
}, 120_000);
afterAll(async () => {
  for (const r of rigs.splice(0)) r.cleanup();
  await engine.disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A seeded rig whose first Rust answer (the sample) differs from the primary's and whose later answers agree with it. */
async function mismatching(o: Partial<RigOptions> = {}): Promise<Rig> {
  const rig = await startRig({ primary: engine, ...o });
  rigs.push(rig);
  let calls = 0;
  rig.rust.listPages = async () => (++calls === 1 ? [] : engine.listPages({ limit: 100 }));
  return rig;
}

describe('the barrier', () => {
  const pending = (rig: Rig) => rig.attached.follower!;
  const open = (n: number) => ({ kind: 'rows', relation: 'config', selector: { key: 'x' }, before_keys: keys(n) });

  test('a multi-chunk batch paused after its first chunk holds the barrier until its last chunk is applied', async () => {
    const hold = gate();
    const rerunAsk = gate();
    let chunks = 0;
    const rig = await mismatching({ store: { replaceRelationRows: async (_i, relation, _g, k) => { rig.applied.push({ relation: String(relation), keys: (k as unknown[]).length }); if (++chunks === 1) await hold.wait; return { upserted: 0, deleted: 1, skipped_older: 0, displaced: 0, dropped: 0, unmapped_columns: [], losses: {} }; } } });
    await rig.settled();
    const supervisor = rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } };
    const real = supervisor.o.onAsk;
    supervisor.o.onAsk = async (ask) => { if (ask.kind === 'rerun') await rerunAsk.wait; return real(ask); }; // the sample compared while nothing was pending
    await sample(rig);
    await sleep(50);
    pending(rig).publish(batch(1, [open(600)])); // 600 keys: two chunks of 500 and 100
    await until(() => rig.applied.length === 1);
    rerunAsk.open();
    await sleep(150);
    expect(rig.rows()).toHaveLength(0); // the sample waits for its rerun, and the barrier has not been acknowledged
    hold.open();
    expect((await rows(rig))[0]).toMatchObject({ outcome: 'inconclusive', rerun: 'matched' });
    expect(rig.applied.map((a) => a.keys)).toEqual([500, 100]);
  });

  test('a batch that names several relations is applied in full before the barrier is acknowledged', async () => {
    const rig = await mismatching({ store: { seedPlan: async () => ({ relations: [{ relation: 'config', key: ['key'], removable: true }, { relation: 'pages', key: ['id'], removable: true }], carried: [], not_copied: [], gap_columns: [] }) as never } });
    await rig.settled();
    pending(rig).publish(batch(1, [open(2), { kind: 'rows', relation: 'pages', selector: { id: '1' }, before_keys: [['1']] }]));
    await sample(rig);
    expect((await rows(rig))[0]).toMatchObject({ rerun: 'matched' });
    expect(rig.applied.map((a) => a.relation).sort()).toEqual(['config', 'pages']);
  });

  test('a reconcile call that runs between the barrier and the Rust read moves the stamp, so the read does not run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-barrier-'));
    writeSeedRecord(dir, SEED);
    const store = { replaceRelationRows: async () => ({}), replaceInterval: async () => ({ upserted: 0, deleted: 0, displaced: 0 }), seedPlan: async () => ({ relations: [] }) } as never;
    const child = new FollowChild({ dir, store: async () => store, owner: () => true, writeControl: () => {} });
    const lines: Array<Record<string, unknown>> = [];
    (child as unknown as { o: { writeControl: (l: string) => void } }).o.writeControl = (l) => lines.push(JSON.parse(l));
    child.handle({ t: 'rpc', id: 1, method: 'watermark', args: { valid: true, since: Date.now() + 1 } });
    child.handle({ t: 'rpc', id: 2, method: 'barrier', args: {} });
    await until(() => lines.length === 2);
    const stamp = (lines[1]!.value as { stamp: number }).stamp;
    let ran = 0;
    expect(await child.exclusive(stamp, async () => ++ran)).toBe(1); // nothing moved: the read runs
    child.handle({ t: 'rpc', id: 3, method: 'replaceInterval', args: { relation: 'pages', generation: 1, rows: [], digests: [] } });
    expect(await child.exclusive(stamp, async () => ++ran)).toBeNull(); // a reconcile call ran in between
    expect(ran).toBe(1);
    await child.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('sustained writes end in busy, a child that is gone ends the rerun, and an old epoch is refused: all inconclusive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-busy-'));
    const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: null, comparator_version: 2, adapter_version: 'a', capability_set_hash: null, readiness_policy_hash: 'p' });
    const ask = { id: 1, kind: 'rerun', op: 'listPages', args: [], access: {}, epoch_id: epoch.epoch_id };
    let clock = 0;
    const handler = (idle: boolean, rpc: () => Promise<unknown>) => makeAskHandler({ engine, reads: {} as never, dir, rpc: rpc as never, now: () => (clock += 20_000),
      follower: { idle: () => idle, settle: async () => {}, published: 0, lastInvalidatedAt: 0 } as never });
    await expect(handler(false, async () => ({ stamp: 1 }))(ask)).rejects.toMatchObject({ code: 'busy' }); // writes never stop: the 30 s deadline passes
    await expect(handler(true, async () => { throw Object.assign(new Error('gone'), { code: 'child_unavailable' }); })(ask)).rejects.toMatchObject({ code: 'child_unavailable' });
    await expect(handler(true, async () => ({ stamp: 1 }))({ ...ask, epoch_id: 'old' })).rejects.toMatchObject({ code: 'epoch_changed' });
    rmSync(dir, { recursive: true, force: true });
  });
});
