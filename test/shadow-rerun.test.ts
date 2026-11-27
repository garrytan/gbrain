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
import { readAllFaults } from '../src/shadow/ledger.ts';
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
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 10 is a sample count, not the adapter version
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
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 the number 10 on the next line is test data (a count, size, index or slice), not the adapter version
    const ask = { id: 1, kind: 'rerun', sid: samples.add({ op: 'listPages', args: [], at: Date.now() }, 10), epoch_id: epoch.epoch_id };
    const handler = (follower: Record<string, unknown>, deadlineMs?: number) => makeAskHandler({ engine, reads: {} as never, dir, samples, rpc: (async () => ({ stamp: 1 })) as never, deadlineMs, follower: { published: 0, lastInvalidatedAt: 0, ...follower } as never });
    // pendingInvalid set, nothing queued: idle() stays false and settle() resolves at once
    const started = Date.now();
    await expect(handler({ idle: () => false, blocked: () => 'apply_shed', settle: async () => {} })(ask)).rejects.toMatchObject({ code: 'invalidation_pending' });
    expect(Date.now() - started).toBeLessThan(100);
    // busy but not blocked: a timer and an I/O callback must run during the 300 ms wait
    let timers = 0;
    let turns = 0;
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 the number 10 on the next line is test data (a count, size, index or slice), not the adapter version
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
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 the number 10 on the next line is test data (a count, size, index or slice), not the adapter version
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
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 the number 10 on the next line is test data (a count, size, index or slice), not the adapter version
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

describe('the registry\'s memory cap holds for a rerun\'s answer', () => {
  test('charging an older entry evicts the others, newest included, until the total is at or under the cap', () => {
    const samples = new SampleRegistry(1024, 100);
    const a = samples.add({ op: 'listPages', args: [], at: 1 }, 40);
    const b = samples.add({ op: 'listPages', args: [], at: 2 }, 40);
    expect(samples.charge(a, 40)).toBe(true); // 120 > 100: b is newer than a, and goes
    expect(samples.totalBytes).toBeLessThanOrEqual(100);
    expect([samples.get(a) !== undefined, samples.get(b) !== undefined]).toEqual([true, false]);
  });

  test('an answer that would pass the cap on its own is refused and charged nothing', () => {
    const samples = new SampleRegistry(1024, 100);
    const a = samples.add({ op: 'listPages', args: [], at: 1 }, 40);
    expect(samples.charge(a, 200)).toBe(false);
    expect([samples.totalBytes, samples.get(a) !== undefined]).toEqual([40, true]);
    expect(samples.charge('unknown-id', 1000)).toBe(true); // an entry that is gone holds nothing
  });

  test('a rerun whose answer is over the cap ends as too_large and keeps nothing in memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-cap-'));
    const epoch = ensureEpoch(dir, { seed_id: 's', rust_addon_sha256: null, comparator_version: 3, adapter_version: 'a', capability_set_hash: null, readiness_policy_hash: 'p' });
    const samples = new SampleRegistry(1024, 64);
    const sample = { op: 'listPages', args: [] as unknown[], at: Date.now() };
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 the number 10 on the next line is test data (a count, size, index or slice), not the adapter version
    const sid = samples.add(sample, 10);
    const handler = makeAskHandler({ engine, reads: {} as never, dir, samples, rpc: (async () => ({ stamp: 1 })) as never,
      follower: { idle: () => true, blocked: () => null, settle: async () => {}, published: 0, lastInvalidatedAt: 0 } as never, watch: { current: () => 'lsn', live: async () => 'lsn', ready: async () => {} } });
    await expect(handler({ id: 1, kind: 'rerun', sid, epoch_id: epoch.epoch_id })).rejects.toMatchObject({ code: 'too_large' });
    expect([...((sample as { reruns?: Map<string, unknown> }).reruns?.values() ?? [])].some((r) => (r as { result?: unknown }).result !== undefined)).toBe(false);
    // pregate-literal: SHADOW_ADAPTER_VERSION=10 the number 10 on the next line is test data (a count, size, index or slice), not the adapter version
    expect(samples.totalBytes).toBe(10);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the wait for the follow lock has a deadline', () => {
  const hungApply = () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-lock-'));
    writeSeedRecord(dir, SEED);
    const hang = gate();
    const store = { replaceRelationRows: async () => { await hang.wait; return {}; }, replaceInterval: async () => ({ upserted: 0, deleted: 0, displaced: 0 }), seedPlan: async () => ({ relations: [] }) } as never;
    const child = new FollowChild({ dir, store: async () => store, owner: () => true, writeControl: () => {} });
    child.handle({ t: 'apply', seq: 1, committed_at: Date.now(), relation: 'pages', generation: 1, keys: [], rows: [{ fact: 'x' }], digests: [] } as never); // the apply never ends: it holds the chain
    return { child, hang, dir };
  };

  test('a caller behind a hung apply times out at its own deadline, its read never runs, and the callers after it time out too', async () => {
    const { child, hang, dir } = hungApply();
    let ran = 0;
    const started = Date.now();
    expect(await child.exclusive(0, async () => ++ran, { ms: 60, onTimeout: 'lock_timeout' })).toBe('lock_timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await child.exclusive(0, async () => ++ran, { ms: 60, onTimeout: 'lock_timeout' })).toBe('lock_timeout'); // the next one is not stuck behind the first
    hang.open(); // the apply ends: the abandoned reads pass through without running
    await child.pending();
    expect(ran).toBe(0);
    await child.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('through the child: a hung apply behind the barrier ends the rerun as a timeout at its deadline instead of waiting for ever', async () => {
    const hang = gate();
    let applying = false;
    const rig = await mismatching({ child: { timeoutMs: 300, random: () => 0.5, sleep: async () => undefined }, store: { replaceRelationRows: async () => { applying = true; await hang.wait; return {} as never; } } });
    try {
      await rig.settled();
      rig.rust.listPages = async () => []; // every sample differs from the primary
      const sup = (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o;
      const real = sup.onAsk;
      sup.onAsk = async (ask) => { const answer = await real(ask); if (ask.kind === 'rerun' && !applying) { rig.attached.follower!.publish(batch(1, [{ kind: 'rows', relation: 'config', selector: { key: 'x' }, before_keys: keys(1) }])); await until(() => applying); } return answer; }; // an apply arrives after the barrier and never ends
      const started = Date.now();
      await sample(rig);
      await until(() => rig.rows().some((r) => r.rerun === 'skipped:timeout'));
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(rig.rows().find((r) => r.rerun === 'skipped:timeout')).toMatchObject({ outcome: 'inconclusive' }); // unresolved and counted, never silent
    } finally { hang.open(); }
  }, 30_000);

  test('a follow-chain lock timeout makes the child unhealthy by itself: the apply stays hung, ordinary reads still answer, heartbeats stop and the supervisor restarts the child inside the watchdog window; they resume when the chain recovers', async () => {
    const hang = gate();
    let applying = false;
    const rig = await mismatching({ child: { timeoutMs: 200, heartbeatMs: 40, random: () => 0.5, sleep: async () => undefined }, supervisor: { hangMs: 500 },
      store: { replaceRelationRows: async () => { applying = true; await hang.wait; return {} as never; } } });
    try {
      await rig.settled();
      const primaryRows = await engine.listPages({ limit: 100 });
      let reads = 0;
      rig.rust.listPages = async () => (++reads === 1 ? [] : primaryRows); // the first sample differs and is rerun; later reads agree
      const heartbeats = (): number => rig.control.fromChild.filter((l) => l.includes('"hb"')).length;
      await until(() => heartbeats() >= 2); // healthy: the child heartbeats
      const sup = (rig.attached.supervisor as unknown as { o: { onAsk: (a: Record<string, unknown>) => Promise<unknown> } }).o;
      const real = sup.onAsk;
      sup.onAsk = async (ask) => { const answer = await real(ask); if (ask.kind === 'rerun' && !applying) { rig.attached.follower!.publish(batch(1, [{ kind: 'rows', relation: 'config', selector: { key: 'x' }, before_keys: keys(1) }])); await until(() => applying); } return answer; }; // an apply arrives after the barrier and never ends
      await sample(rig);
      await until(() => rig.rows().some((r) => r.rerun === 'skipped:timeout'));
      await sample(rig); // an ordinary read still answers while the apply is hung
      await until(() => rig.rows().some((r) => r.outcome === 'match'));
      const quiet = heartbeats();
      await until(() => readAllFaults(rig.dir)?.some((f) => f.kind === 'child_hung') === true, 5_000); // no heartbeat for hangMs: the supervisor kills and restarts it
      expect(heartbeats()).toBe(quiet); // none came in between
    } finally { hang.open(); }
    const before = rig.control.fromChild.filter((l) => l.includes('"hb"')).length;
    await until(() => rig.control.fromChild.filter((l) => l.includes('"hb"')).length > before, 3_000); // the chain recovered: the heartbeat is back
  }, 30_000);
});
