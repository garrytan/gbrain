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
import { requestSignal, withRequestSignal } from '../src/core/request-signal.ts';
import { ShadowSupervisor } from '../src/shadow/supervisor.ts';
import { makeAskHandler } from '../src/shadow/checks.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { SampleRegistry } from '../src/shadow/samples.ts';
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
    const samples = new SampleRegistry();
    const ask = { id: 1, kind: 'rerun', sid: samples.add({ op: 'listPages', args: [], at: Date.now() }, 10), epoch_id: epoch.epoch_id };
    let clock = 0;
    const handler = (idle: boolean, rpc: () => Promise<unknown>) => makeAskHandler({ engine, reads: {} as never, dir, rpc: rpc as never, samples, now: () => (clock += 20_000),
      follower: { idle: () => idle, blocked: () => null, settle: async () => {}, published: 0, lastInvalidatedAt: 0 } as never });
    await expect(handler(false, async () => ({ stamp: 1 }))(ask)).rejects.toMatchObject({ code: 'busy' }); // writes never stop: the 30 s deadline passes
    await expect(handler(true, async () => { throw Object.assign(new Error('gone'), { code: 'child_unavailable' }); })(ask)).rejects.toMatchObject({ code: 'child_unavailable' });
    await expect(handler(true, async () => ({ stamp: 1 }))({ ...ask, epoch_id: 'old' })).rejects.toMatchObject({ code: 'epoch_changed' });
    await expect(handler(true, async () => ({ stamp: 1 }))({ ...ask, sid: 'not-a-sample' })).rejects.toMatchObject({ code: 'sample_unknown' });
    rmSync(dir, { recursive: true, force: true });
  });

  test('an invalidation that cannot progress refuses at once, and the wait for a busy follower never starves the event loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-spin-'));
    const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: null, comparator_version: 2, adapter_version: 'a', capability_set_hash: null, readiness_policy_hash: 'p' });
    const samples = new SampleRegistry();
    const ask = { id: 1, kind: 'rerun', sid: samples.add({ op: 'listPages', args: [], at: Date.now() }, 10), epoch_id: epoch.epoch_id };
    const handler = (follower: Record<string, unknown>, deadlineMs?: number) => makeAskHandler({ engine, reads: {} as never, dir, samples, rpc: (async () => ({ stamp: 1 })) as never, deadlineMs, follower: { published: 0, lastInvalidatedAt: 0, ...follower } as never });
    // pendingInvalid set, nothing queued: idle() stays false and settle() resolves at once
    const started = Date.now();
    await expect(handler({ idle: () => false, blocked: () => 'apply_shed', settle: async () => {} })(ask)).rejects.toMatchObject({ code: 'invalidation_pending' });
    expect(Date.now() - started).toBeLessThan(100);
    // busy but not blocked: a timer and an I/O callback must run during the 300 ms wait
    let timers = 0;
    let turns = 0;
    const timer = setInterval(() => { timers++; }, 10);
    const io = setInterval(() => setImmediate(() => { turns++; }), 1);
    await expect(handler({ idle: () => false, blocked: () => null, settle: async () => {} }, 300)(ask)).rejects.toMatchObject({ code: 'busy' });
    clearInterval(timer);
    clearInterval(io);
    expect(timers).toBeGreaterThan(5);
    expect(turns).toBeGreaterThan(5);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('rerun attempts', () => {
  test('two reruns of one sample keep their own result and position; an unknown attempt, or none, is never proven', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-attempts-'));
    const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: null, comparator_version: 3, adapter_version: 'a', capability_set_hash: null, readiness_policy_hash: 'p' });
    const samples = new SampleRegistry();
    const sid = samples.add({ op: 'listPages', args: [], at: Date.now() }, 10);
    const real = engine.listPages.bind(engine);
    let answers = 0;
    const first = gate();
    const primary = new Proxy(engine, { get: (t, p) => (p === 'listPages' ? async (...a: never[]) => { const n = ++answers; if (n === 1) await first.wait; return n === 1 ? [{ slug: 'first-answer' }] : (real as (...x: unknown[]) => unknown)(...a); } : Reflect.get(t, p, t)) }) as never;
    const handler = makeAskHandler({ engine: primary, reads: {} as never, dir, samples, rpc: (async () => ({ stamp: 1 })) as never, follower: { idle: () => true, blocked: () => null, settle: async () => {}, published: 0, lastInvalidatedAt: 0 } as never,
      watch: { current: () => 'lsn', live: async () => `lsn-${answers}`, ready: async () => {} } });
    const ask = { id: 1, kind: 'rerun', sid, epoch_id: epoch.epoch_id };
    const a = handler(ask) as Promise<{ attempt: string; digest: string }>; // rerun A waits inside its primary read
    await sleep(30);
    const b = await handler(ask) as { attempt: string; digest: string }; // rerun B starts and finishes meanwhile
    first.open();
    const a1 = await a;
    expect(a1.attempt).not.toBe(b.attempt);
    expect(a1.digest).not.toBe(b.digest); // each answer is its own: B did not overwrite A's slot
    const held = samples.get(sid)!.reruns!;
    expect([held.get(a1.attempt)?.lsn, held.get(b.attempt)?.lsn]).toEqual(['lsn-0', 'lsn-1']); // and each keeps the position taken before its own read
    expect(JSON.stringify(held.get(a1.attempt)?.result)).toContain('first-answer');
    expect(JSON.stringify(held.get(b.attempt)?.result)).not.toContain('first-answer');
    // follow-up asks name an attempt: none, an unknown id and a dropped one are `moved`, never clean
    const rows = [{ payload: 'x', id: 9 }];
    for (const attempt of [undefined, 'nope']) expect(await handler({ id: 2, kind: 'privacy', sid, phase: 'rerun', attempt, rows })).toEqual({ verdict: 'privacy_check_moved', complete: false });
    await expect(handler({ id: 3, kind: 'vector', sid, phase: 'rerun', attempt: 'nope' })).rejects.toMatchObject({ code: 'moved' });
    for (let i = 0; i < 10; i++) await handler(ask); // more attempts than the sample keeps: the oldest are dropped
    expect(samples.get(sid)!.reruns!.size).toBe(8);
    expect(await handler({ id: 4, kind: 'privacy', sid, phase: 'rerun', attempt: a1.attempt, rows })).toEqual({ verdict: 'privacy_check_moved', complete: false });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the child\'s questions run in a context of their own', () => {
  test('a question asked after the request that spawned the child was cancelled does not inherit that request\'s aborted signal, and has a signal and deadline of its own', async () => {
    const seen: Array<{ aborted: boolean; own: boolean }> = [];
    const supervisor = new ShadowSupervisor({ dir: '/none', argv: [], onAsk: async () => { const s = requestSignal(); seen.push({ aborted: s?.aborted === true, own: s !== undefined }); return 'answer'; } });
    const cancelled = new AbortController();
    await withRequestSignal(cancelled.signal, async () => { // the request that spawned the child; the child's stdout callbacks inherit its context
      cancelled.abort();
      await (supervisor as unknown as { answerAsk(a: { id: number; kind: string }, from: unknown, session: string): Promise<void> }).answerAsk({ id: 1, kind: 'privacy' }, null, '');
    });
    expect(seen).toEqual([{ aborted: false, own: true }]);
  });
});
