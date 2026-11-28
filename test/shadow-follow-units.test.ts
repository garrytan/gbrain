/**
 * Shadow follow without the Rust addon: the follow child against a fake store, the status builder and its state
 * words, the lag histogram, the supervisor's request channel, and the `status --json` shape.
 *
 * Protects: apply counting and lag samples, fingerprint mismatch counting (a fake store answering wrong), the
 * coverage watermark rules (first reason wins; a restore must postdate the last invalidation; a client child writes
 * nothing), epoch totals, the supervisor's resp routing and its rejection of pending calls when the child dies.
 * Regression it catches: a watermark that claims coverage after a lost write, a status that calls a dead follower
 * "following", an rpc that hangs when the child exits. Real-store scenarios: test/shadow-follow.test.ts.
 */
import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { countFingerprintMismatches, differingCodePoints, probeRecord, PROBE_CORPUS, type CharRow } from '../src/shadow/fingerprints.ts';
import { FollowChild, type FollowStore } from '../src/shadow/follow-child.ts';
import { appendPass, buildFollowStatus, lagBucket, lagP99, NOT_RUN_PROBE, readFollowerFile, type FollowStatus } from '../src/shadow/follow-status.ts';
import { openReadSource } from '../src/shadow/read-pool.ts';
import { ShadowFollower } from '../src/shadow/follower.ts';
import type { Invalidation } from '../src/shadow/invalidations.ts';
import { Reconciler } from '../src/shadow/reconcile.ts';
import { writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { SHADOW_STATE_VERSION, shadowBrainKey, shadowDirFor, writeShadowState, type ShadowState } from '../src/shadow/state.ts';
import { ShadowSupervisor } from '../src/shadow/supervisor.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-follow-units-')); dirs.push(d); return d; };

const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as unknown as SeedRecord;
const STATE = { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'x', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' } as ShadowState;
const RESULT = { upserted: 1, deleted: 0, skipped_older: 0, displaced: 0, dropped: 0, unmapped_columns: [], losses: {} };

function fakeStore(over: Partial<FollowStore> = {}): FollowStore {
  return {
    replaceRelationRows: async () => RESULT, replaceInterval: async () => RESULT, relationDigest: async () => ({ rows: 0, digest: '' }),
    relationEntries: async () => [], allocatorCheck: async () => [], factFingerprints: async (texts) => texts.map(() => ({ fingerprint: 'a', fingerprint_v1: 'b' })),
    seedPlan: async () => ({ relations: [], carried: [], not_copied: [], gap_columns: [] }) as never, ...over,
  };
}

function childOn(dir: string, over: Partial<FollowStore> = {}, owner = true, now = () => Date.now()) {
  const lines: Array<Record<string, unknown>> = [];
  const child = new FollowChild({ dir, store: async () => fakeStore(over), owner: () => owner, writeControl: (l) => lines.push(JSON.parse(l)), now });
  return { child, lines };
}
const apply = (committed_at: number, extra: Record<string, unknown> = {}) => ({ t: 'apply' as const, seq: 1, committed_at, relation: 'pages', generation: 1, keys: [], rows: [{ fact: 'x' }], digests: [], ...extra });
const rpc = (id: number, method: string, args: Record<string, unknown> = {}) => ({ t: 'rpc' as const, id, method, args });

describe('lag histogram', () => {
  test('buckets are powers of two and p99 is the upper bound of its bucket', () => {
    expect([0, 0.5, 1, 3, 4, 1000].map(lagBucket)).toEqual([0, 0, 1, 2, 3, 10]);
    expect(lagP99([])).toBeNull();
    const counts: number[] = [];
    counts[lagBucket(3)] = 99;
    counts[lagBucket(1000)] = 1;
    expect(lagP99(counts)).toBe(4);
    counts[lagBucket(1000)] = 2;
    expect(lagP99(counts)).toBe(1024);
  });
});

describe('follow child', () => {
  test('applies rows, counts them and samples lag; the watermark advances only while valid', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    const { child, lines } = childOn(dir, {}, true, () => 10_000);
    child.handle(rpc(1, 'watermark', { valid: true, since: 9_500 })); // a pass that started before this session: refused
    child.handle(rpc(2, 'watermark', { valid: true, since: 10_500 }));
    child.handle(apply(9_000));
    await child.close();
    const file = readFollowerFile(dir)!;
    expect(file).toMatchObject({ epoch_id: 'seed-1', seed_id: 'seed-1', applied_rows: 1, last_seq: 1, watermark: { valid: true, through: new Date(9_000).toISOString() } });
    expect(file.lag.epoch[lagBucket(1000)]).toBe(1);
    expect(lines[1]).toMatchObject({ t: 'resp', id: 2, ok: true });
  });

  test('an evidence epoch that differs from the seed id still follows, digests and replaces intervals under the real seed id', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    writeFileSync(join(dir, 'follower.json'), JSON.stringify({
      version: 1, epoch_id: 'manifest-epoch', seed_id: 'seed-1', epoch_started_at: 't', updated_at: new Date().toISOString(), applied_rows: 3, queue_depth: 0, lag_ms: 0,
      last_seq: 1, watermark: { valid: true, through: null, invalidated_reason: null }, lag: { epoch: [], hours: {} }, fingerprints: { checked_rows: 0, mismatches: 0 },
      probe: { state: 'not_run', checked_at: null, server_version: null, collation: null, mismatches: 0 }, allocators: { verified: false, checked_at: null },
    }));
    const seen: string[] = [];
    const named = (name: string) => async (id: string) => { seen.push(`${name}:${id}`); return name === 'relationDigest' ? { rows: 0, digest: '' } : RESULT; };
    const { child, lines } = childOn(dir, {
      replaceRelationRows: named('replace') as never, relationDigest: named('relationDigest') as never, replaceInterval: named('interval') as never,
    });
    child.handle(apply(1));
    child.handle(rpc(1, 'relationDigest', { relation: 'pages' }));
    child.handle(rpc(2, 'replaceInterval', { relation: 'pages', generation: 1, rows: [], digests: [] }));
    await child.close();
    expect(seen).toEqual(['replace:seed-1', 'relationDigest:seed-1', 'interval:seed-1']);
    expect(lines.map((l) => l.ok)).toEqual([true, true]);
    expect(readFollowerFile(dir)).toMatchObject({ applied_rows: 5, seed_id: 'seed-1' }); // the 3 rows it kept, plus the apply and the interval
    expect(buildFollowStatus(dir, STATE).follower).toMatchObject({ applied_rows: 5 });
    expect(buildFollowStatus(dir, STATE).follower.state).not.toBe('stopped'); // a new owner session is `invalid` until a pass settles it; `stopped` would mean the file was ignored
  });

  test('a follower.json from before the seed id was written still counts as the same seed', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    writeFileSync(join(dir, 'follower.json'), JSON.stringify({
      version: 1, epoch_id: 'seed-1', epoch_started_at: 't', updated_at: new Date().toISOString(), applied_rows: 7, queue_depth: 0, lag_ms: 0, last_seq: 1,
      watermark: { valid: true, through: null, invalidated_reason: null }, lag: { epoch: [], hours: {} }, fingerprints: { checked_rows: 0, mismatches: 0 },
      probe: { state: 'not_run', checked_at: null, server_version: null, collation: null, mismatches: 0 }, allocators: { verified: false, checked_at: null },
    }));
    const { child } = childOn(dir);
    await child.close();
    expect(readFollowerFile(dir)).toMatchObject({ applied_rows: 7, seed_id: 'seed-1' });
  });

  test('a fingerprint the store computes differently is counted, per row, in the epoch totals', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    const { child } = childOn(dir);
    child.handle(apply(1, { rows: [{ fact: 'a' }, { fact: 'b' }], fp: [['a', 'b'], ['x', 'y']] }));
    await child.close();
    expect(readFollowerFile(dir)!.fingerprints).toEqual({ checked_rows: 2, mismatches: 1 });
    expect(countFingerprintMismatches([['a', 'b']], [{ fingerprint: 'a', fingerprint_v1: 'c' }])).toBe(1);
    expect(countFingerprintMismatches([['a', 'b']], [])).toBe(1);
  });

  test('a new session is invalid until a pass starts after it; a later invalidation needs a later pass; the first reason stays', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    let clock = 5_000;
    const { child, lines } = childOn(dir, { replaceRelationRows: async () => { throw Object.assign(new Error('x'), { code: 'invalid_state' }); } }, true, () => clock);
    child.handle(rpc(1, 'watermark', { valid: true, since: 4_000 })); // older than the session start
    await child.close(); // events run in order but later than the call: settle between clock changes
    clock = 6_000;
    child.handle(apply(1)); // fails: a full obligation at 6000
    child.handle(rpc(2, 'watermark', { valid: true, since: 5_500 }));
    child.handle(rpc(3, 'watermark', { valid: true, since: 6_500 }));
    child.handle({ t: 'watermark', valid: false, reason: 'later_reason' });
    child.handle(rpc(4, 'state'));
    await child.close();
    const state = (id: number) => lines.find((l) => l.id === id);
    expect(state(1)).toMatchObject({ ok: true, value: { valid: false, invalidated_reason: 'not_reconciled' } });
    expect(state(2)).toMatchObject({ value: { valid: false, invalidated_reason: 'not_reconciled' } });
    expect(state(3)).toMatchObject({ value: { valid: true, invalidated_reason: null } });
    expect(state(4)).toMatchObject({ value: { valid: false, invalidated_reason: 'later_reason' } });
  });

  test('a dirty relation is settled by a pass for it that started after it; a full pass settles everything older', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    let clock = 1_000;
    const { child, lines } = childOn(dir, {}, true, () => clock);
    child.handle(rpc(1, 'watermark', { valid: true, since: 1_500 })); // the session start
    clock = 2_000;
    child.handle({ t: 'watermark', valid: false, reason: 'relation_dirty', relation: 'pages' });
    await child.close();
    clock = 3_000;
    child.handle({ t: 'watermark', valid: false, reason: 'relation_dirty', relation: 'tags' });
    child.handle(rpc(2, 'watermark', { valid: true, since: 2_500, relations: ['pages', 'tags'] })); // tags was marked after it started
    child.handle(rpc(3, 'watermark', { valid: true, since: 3_500, relations: ['tags'] }));
    child.handle(rpc(4, 'watermark', { valid: true, since: 3_600 }));
    await child.close();
    const state = (id: number) => (lines.find((l) => l.id === id) as { value: { valid: boolean; invalidated_reason: string | null } }).value;
    expect(state(2)).toMatchObject({ valid: false, invalidated_reason: 'relation_dirty' });
    expect(state(3)).toMatchObject({ valid: true });
    expect(state(4)).toMatchObject({ valid: true });
  });

  test('every owner session starts invalid, even after a clean stop', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    const first = childOn(dir);
    first.child.handle(rpc(1, 'watermark', { valid: true, since: Date.now() + 10 }));
    await first.child.close();
    expect(readFollowerFile(dir)!.watermark.valid).toBe(true);
    const second = childOn(dir);
    second.child.tick();
    expect(readFollowerFile(dir)!.watermark).toMatchObject({ valid: false, invalidated_reason: 'follower_session_start' });
  });

  test('another process\'s child leaves lines; the owner reads them before it advances the watermark and holds a lease past them', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    let clock = 10_000;
    const owner = childOn(dir, {}, true, () => clock);
    const client = childOn(dir, {}, false, () => clock);
    owner.child.handle(rpc(1, 'watermark', { valid: true, since: 10_500 }));
    await owner.child.close();
    clock = 20_000;
    client.child.handle(apply(1)); // a client child cannot apply: it tells the owner
    await client.child.close();
    expect(readFileSync(join(dir, 'follower-invalidations.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    owner.child.handle(rpc(2, 'watermark', { valid: true, since: 20_500 })); // inside the one-second lease after the line
    await owner.child.close();
    clock = 22_000;
    owner.child.handle(rpc(3, 'watermark', { valid: true, since: 21_500 }));
    await owner.child.close();
    const state = (id: number) => (owner.lines.find((l) => l.id === id) as { value: { valid: boolean; invalidated_reason: string | null } }).value;
    expect(state(2)).toMatchObject({ valid: false });
    expect(state(3)).toMatchObject({ valid: true });
  });

  test('a malformed line or an unreadable invalidations file leaves the watermark waiting for a full pass', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    const file = join(dir, 'follower-invalidations.jsonl');
    let clock = 10_000;
    const { child, lines } = childOn(dir, {}, true, () => clock);
    const state = (id: number) => (lines.find((l) => l.id === id) as { value: { valid: boolean; invalidated_reason: string | null } }).value;
    child.handle(rpc(1, 'watermark', { valid: true, since: 10_500 })); // no file yet: nothing to read
    await child.close();
    expect(state(1)).toMatchObject({ valid: true });
    clock = 20_000;
    writeFileSync(file, 'not json\n');
    child.handle(rpc(2, 'watermark', { valid: true, since: 15_000 }));
    await child.close();
    expect(state(2)).toMatchObject({ valid: false, invalidated_reason: 'full_required' });
    child.handle(rpc(3, 'watermark', { valid: true, since: 20_500 }));
    await child.close();
    expect(state(3)).toMatchObject({ valid: true });
    clock = 30_000;
    rmSync(file);
    mkdirSync(file); // present but not readable as a file
    child.handle(rpc(4, 'watermark', { valid: true, since: 25_000 }));
    await child.close();
    expect(state(4)).toMatchObject({ valid: false, invalidated_reason: 'full_required' });
  });

  test('rows the store displaced make the relation dirty, and the parent is told', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    let clock = 1_000;
    const { child, lines } = childOn(dir, { replaceRelationRows: async () => ({ ...RESULT, displaced: 1 }) }, true, () => clock);
    child.handle(rpc(1, 'watermark', { valid: true, since: 1_500 }));
    await child.close();
    clock = 2_000;
    child.handle(apply(1_900, { relation: 'content_chunks' }));
    child.handle(rpc(2, 'watermark', { valid: true, since: 2_500, relations: ['tags'] }));
    child.handle(rpc(3, 'watermark', { valid: true, since: 2_600, relations: ['content_chunks'] }));
    await child.close();
    expect(lines.find((l) => l.t === 'dirty')).toEqual({ t: 'dirty', relation: 'content_chunks' });
    expect(lines.find((l) => l.id === 2)).toMatchObject({ value: { valid: false, invalidated_reason: 'relation_dirty' } });
    expect(lines.find((l) => l.id === 3)).toMatchObject({ value: { valid: true } });
  });

  test('a child that does not own the store answers not_owner and writes nothing', async () => {
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    const { child, lines } = childOn(dir, {}, false);
    child.handle(apply(1));
    child.handle(rpc(1, 'relationDigest', { relation: 'pages' }));
    await child.close();
    expect(lines[0]).toMatchObject({ ok: false, error: { code: 'not_owner' } });
    expect(readFollowerFile(dir)).toBeNull();
  });
});

describe('reconciler schedule', () => {
  // A full pass starts with 'state' again (its barrier) and stops at seedPlan here.
  async function firstCheck(o: { valid: boolean; lastFullAgoMs?: number; lastFullAt?: string; progress?: boolean; ready?: () => Promise<void> }) {
    const dir = tmp();
    if (o.lastFullAgoMs !== undefined || o.lastFullAt !== undefined) {
      const at = o.lastFullAt ?? new Date(Date.now() - o.lastFullAgoMs!).toISOString();
      appendPass(dir, { id: 'p', kind: 'full', started_at: at, finished_at: at, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 });
    }
    if (o.progress) { mkdirSync(join(dir, 'reconcile'), { recursive: true }); writeFileSync(join(dir, 'reconcile', 'progress.json'), JSON.stringify({ version: 1 })); }
    const calls: string[] = [];
    const rpc = (async (method: string) => {
      calls.push(method);
      if (method === 'state') return { valid: o.valid, through: null, invalidated_reason: null };
      throw Object.assign(new Error('stop here'), { code: 'stopped' });
    }) as never;
    const reconciler = new Reconciler({ dir, rpc, ready: o.ready, reads: { pauseMs: 0, read: async () => { throw new Error('no reads'); }, close: async () => undefined } });
    reconciler.startNightly();
    return { calls, reconciler };
  }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  test('a process that stays up checks the watermark five seconds after start (a short serve session lasts 10-20 s) and runs a full pass if it is invalid', async () => {
    jest.useFakeTimers();
    try {
      for (const valid of [false, true]) {
        const { calls, reconciler } = await firstCheck({ valid, lastFullAgoMs: 60_000 });
        jest.advanceTimersByTime(4_000);
        await flush();
        expect(calls).toEqual([]);
        jest.advanceTimersByTime(2_000);
        await flush();
        expect(calls.includes('seedPlan')).toBe(!valid);
        reconciler.stop();
      }
    } finally { jest.useRealTimers(); }
  });

  test('a valid watermark still gets a full pass at the first check when none ran, the last is 24 h old, or one was left half done', async () => {
    jest.useFakeTimers();
    try {
      for (const o of [{ valid: true }, { valid: true, lastFullAgoMs: 25 * 3_600_000 }, { valid: true, lastFullAgoMs: 60_000, progress: true }]) {
        const { calls, reconciler } = await firstCheck(o);
        jest.advanceTimersByTime(6_000);
        await flush();
        expect(calls.includes('seedPlan')).toBe(true);
        reconciler.stop();
      }
    } finally { jest.useRealTimers(); }
  });

  test('a last full pass that finished in the future (a clock set back) or at an unreadable time makes a full pass due, at the first check and at the 15-minute tick', async () => {
    jest.useFakeTimers();
    try {
      const times = [new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString(), 'not-a-time'];
      for (const lastFullAt of times) {
        const first = await firstCheck({ valid: true, lastFullAt });
        jest.advanceTimersByTime(6_000);
        await flush();
        expect({ lastFullAt, at: 'first check', ran: first.calls.includes('seedPlan') }).toEqual({ lastFullAt, at: 'first check', ran: true });
        first.reconciler.stop();
        // The tick on its own: the first check never gets past its wait.
        const tick = await firstCheck({ valid: true, lastFullAt, ready: () => new Promise<void>(() => undefined) });
        jest.advanceTimersByTime(15 * 60_000 + 1_000);
        await flush();
        expect({ lastFullAt, at: 'tick', ran: tick.calls.includes('seedPlan') }).toEqual({ lastFullAt, at: 'tick', ran: true });
        tick.reconciler.stop();
      }
    } finally { jest.useRealTimers(); }
  });

  test('the first check waits for the seal confirmation, and a process stopped before it runs nothing', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const { calls, reconciler } = await firstCheck({ valid: false, ready: () => ready });
      jest.advanceTimersByTime(6_000);
      await flush();
      expect(calls).toEqual([]);
      release();
      await flush();
      expect(calls.includes('seedPlan')).toBe(true);
      reconciler.stop();
      const second = await firstCheck({ valid: false, ready: () => ready });
      second.reconciler.stop();
      jest.advanceTimersByTime(6_000);
      await flush();
      expect(second.calls).toEqual([]);
    } finally { jest.useRealTimers(); }
  });
});

describe('probe record', () => {
  test('passes when both sides agree and fails with the mismatch count', () => {
    const sql = PROBE_CORPUS.map((): [string, string] => ['a', 'b']);
    const same = PROBE_CORPUS.map(() => ({ fingerprint: 'a', fingerprint_v1: 'b' }));
    const meta = { server_version: '17.0', collation: 'C' };
    expect(probeRecord(sql, same, meta, new Date(0))).toMatchObject({ state: 'pass', mismatches: 0, server_version: '17.0' });
    expect(probeRecord(sql, [{ fingerprint: 'z', fingerprint_v1: 'b' }, ...same.slice(1)], meta, new Date(0))).toMatchObject({ state: 'fail', mismatches: 1 });
  });
});

describe('fingerprint probe v2: per-code-point answers', () => {
  const ref = { lower: [[65, 97], [0x130, 0x69]] as Array<[number, number]>, space: [32, 0x85] };
  const same: CharRow[] = [{ cp: 65, l: 97, n: 1, sp: false }, { cp: 0x130, l: 0x69, n: 1, sp: false }, { cp: 32, l: 32, n: 1, sp: true }, { cp: 0x85, l: 0x85, n: 1, sp: true }];
  const record = (meta: Parameters<typeof probeRecord>[2]) => probeRecord(
    PROBE_CORPUS.map((): [string, string] => ['a', 'b']), PROBE_CORPUS.map(() => ({ fingerprint: 'a', fingerprint_v1: 'b' })), meta, new Date(0));

  test('a host that answers like PGLite has no differing code points', () => {
    expect(differingCodePoints(same, ref)).toEqual([]);
  });

  test('names a changed lower() answer, a missing one, a multi-character one, the sigma rule and both space differences', () => {
    const rows = same.filter((r) => r.cp !== 0x85).map((r) => (r.cp === 65 ? { ...r, l: 98 } : r)); // U+0085 gone from the class
    expect(differingCodePoints(rows, ref)).toEqual([65, 0x85]);
    expect(differingCodePoints(same.slice(1), ref)).toEqual([65]); // the host does not lower A at all
    expect(differingCodePoints([...same, { cp: 0x130, l: 0x69, n: 2, sp: false }], ref)).toEqual([0x130]); // ICU: two code points
    expect(differingCodePoints([...same, { cp: 0x3a3, l: 0, n: -1, sp: false }], ref)).toEqual([0x3a3]); // word-final sigma
    expect(differingCodePoints([...same, { cp: 0x1680, l: 0x1680, n: 1, sp: true }], ref)).toEqual([0x1680]); // extra space (glibc)
  });

  test('a stored fact holding a differing code point fails the probe; without one the probe passes and names the code points', () => {
    const meta = { differing_code_points: ['U+1680'], differing_code_points_total: 1 };
    expect(record({ ...meta, facts_with_differing_code_points: 1 })).toMatchObject({ state: 'fail', facts_with_differing_code_points: 1 });
    expect(record({ ...meta, facts_with_differing_code_points: 0 })).toMatchObject({ state: 'pass', differing_code_points: ['U+1680'], differing_code_points_total: 1 });
    expect(record({})).toMatchObject({ state: 'pass', differing_code_points: [], differing_code_points_total: 0 });
  });

  test('purge tombstones fail the probe while code points differ: they keep only a hash, so a purged claim could be saved again', () => {
    const meta = { differing_code_points: ['U+1680'], differing_code_points_total: 1, facts_with_differing_code_points: 0 };
    expect(record({ ...meta, fact_purges_unverifiable: 3 })).toMatchObject({ state: 'fail', fact_purges_unverifiable: 3 });
    expect(record({ ...meta, fact_purges_unverifiable: 0 })).toMatchObject({ state: 'pass' });
    // No differing code point: every claim hashes alike, so tombstones are checkable and do not matter.
    expect(record({ fact_purges_unverifiable: 3 })).toMatchObject({ state: 'pass' });
  });

  test('a corpus row that differs with no differing code point to explain it still fails', () => {
    expect(record({ corpus_mismatches: 2, corpus_mismatch_rows: ['seeded 0001'] })).toMatchObject({ state: 'fail', corpus_mismatches: 2 });
    expect(record({ corpus_mismatches: 2, differing_code_points_total: 3, facts_with_differing_code_points: 0 })).toMatchObject({ state: 'pass' });
  });
});

describe('follow status', () => {
  const NOW = new Date('2026-01-02T00:00:00.000Z');
  function withFile(dir: string, over: Record<string, unknown>) {
    writeSeedRecord(dir, SEED);
    const file = {
      version: 1, epoch_id: 'seed-1', epoch_started_at: SEED.finished_at, updated_at: NOW.toISOString(), applied_rows: 3, queue_depth: 0, lag_ms: 0, last_seq: 1,
      watermark: { valid: true, through: NOW.toISOString(), invalidated_reason: null }, lag: { epoch: [], hours: {} },
      fingerprints: { checked_rows: 0, mismatches: 0 }, probe: NOT_RUN_PROBE,
      allocators: { verified: false, checked_at: null }, ...over,
    };
    writeFileSync(join(dir, 'follower.json'), JSON.stringify(file));
  }

  test('the 24 hour p99 counts every hour in full, whatever the length of its histogram', () => {
    const dir = tmp();
    const hour = Math.floor(NOW.getTime() / 3_600_000);
    const slow: number[] = [];
    slow[lagBucket(1000)] = 100;
    const fast = [5]; // the current hour has only the first bucket
    for (const hours of [{ [hour - 3]: slow, [hour]: fast }, { [hour]: fast, [hour - 3]: slow }]) {
      withFile(dir, { lag: { epoch: [], hours } });
      expect(buildFollowStatus(dir, STATE, NOW).follower.lag_ms_p99_24h).toBe(1024);
    }
  });

  test('each follower state word', () => {
    const none = tmp();
    expect(buildFollowStatus(none, STATE, NOW).follower.state).toBe('not_seeded');
    const dir = tmp();
    writeSeedRecord(dir, SEED);
    expect(buildFollowStatus(dir, STATE, NOW).follower).toMatchObject({ state: 'stopped', lag_ms: null });
    withFile(dir, {});
    expect(buildFollowStatus(dir, STATE, NOW).follower.state).toBe('following');
    expect(buildFollowStatus(dir, { ...STATE, enabled: false }, NOW).follower.state).toBe('stopped');
    expect(buildFollowStatus(dir, STATE, new Date(NOW.getTime() + 61_000)).follower.state).toBe('stopped');
    withFile(dir, { queue_depth: 2 });
    expect(buildFollowStatus(dir, STATE, NOW).follower.state).toBe('behind');
    withFile(dir, { lag_ms: 40 });
    expect(buildFollowStatus(dir, STATE, NOW).follower.state).toBe('behind');
    withFile(dir, { watermark: { valid: false, through: null, invalidated_reason: 'seq_gap' }, queue_depth: 2 });
    expect(buildFollowStatus(dir, STATE, NOW).follower.state).toBe('invalid');
    withFile(dir, { epoch_id: 'another-seed', seed_id: 'another-seed' });
    expect(buildFollowStatus(dir, STATE, NOW).follower.applied_rows).toBe(0);
  });

  test('a pass is recorded once: a second record with the same pass id is not appended, so it cannot count as another clean pass', () => {
    const dir = tmp();
    withFile(dir, {});
    const at = '2026-01-01T01:00:00.000Z';
    const rec = { id: 'pass-once', kind: 'full' as const, started_at: at, finished_at: at, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 };
    appendPass(dir, rec);
    appendPass(dir, { ...rec, finished_at: '2026-01-01T02:00:00.000Z' });
    appendPass(dir, rec);
    expect(readFileSync(join(dir, 'reconcile', 'passes.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(buildFollowStatus(dir, STATE, NOW).reconcile).toMatchObject({ consecutive_clean_full_passes: 1, last_clean_full_pass_at: at });
  });

  test('reconcile fields: state, trailing clean full passes, the newest clean full pass, next full pass due', () => {
    const dir = tmp();
    withFile(dir, {});
    expect(buildFollowStatus(dir, STATE, NOW).reconcile).toEqual({ state: 'never_run', last_pass: null, consecutive_clean_full_passes: 0, last_clean_full_pass_at: null, next_full_pass_due: null });
    const pass = (kind: 'full' | 'dirty', repaired: number, at: string, error?: string) => appendPass(dir, {
      id: `p-${at}`, kind, started_at: at, finished_at: at, repaired_rows: repaired, repaired_by_relation: repaired ? { pages: repaired } : {}, follower_misses: repaired, ...(error ? { error } : {}),
    });
    pass('full', 1, '2026-01-01T01:00:00.000Z');
    pass('full', 0, '2026-01-01T02:00:00.000Z');
    pass('dirty', 4, '2026-01-01T03:00:00.000Z');
    pass('full', 0, '2026-01-01T04:00:00.000Z');
    const s = buildFollowStatus(dir, STATE, NOW).reconcile;
    expect(s).toMatchObject({ state: 'ok', consecutive_clean_full_passes: 2, next_full_pass_due: '2026-01-02T04:00:00.000Z' });
    // The finish time of the newest full pass, because it is clean; the dirty pass after a full one does not change it.
    expect(s.last_clean_full_pass_at).toBe('2026-01-01T04:00:00.000Z');
    pass('dirty', 0, '2026-01-01T04:30:00.000Z');
    expect(buildFollowStatus(dir, STATE, NOW).reconcile.last_clean_full_pass_at).toBe('2026-01-01T04:00:00.000Z');
    expect(s.last_pass).toMatchObject({ kind: 'full', repaired_rows: 0 });
    pass('full', 0, '2026-01-01T05:00:00.000Z', 'allocator_check:x');
    // A newest full pass that errored (or repaired rows) is not clean: no clean time, even though an older one was clean.
    expect(buildFollowStatus(dir, STATE, NOW).reconcile).toMatchObject({ state: 'error', consecutive_clean_full_passes: 0, last_clean_full_pass_at: null });
    pass('full', 2, '2026-01-01T06:00:00.000Z');
    expect(buildFollowStatus(dir, STATE, NOW).reconcile).toMatchObject({ state: 'repaired', consecutive_clean_full_passes: 0, last_clean_full_pass_at: null });
  });
});

describe('status --json', () => {
  test('carries every final field, with honest empty values before anything ran', async () => {
    const home = tmp();
    const out: string[] = [];
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const dir = shadowDirFor(shadowBrainKey(config)!);
      mkdirSync(dir, { recursive: true });
      writeShadowState(dir, STATE);
      writeSeedRecord(dir, SEED);
      expect(await runEngineShadow(['status', '--json'], { config: () => config, out: (l) => out.push(l) })).toBe(0);
    });
    const json = JSON.parse(out.join('\n')) as FollowStatus & Record<string, unknown>;
    expect(Object.keys(json)).toEqual(expect.arrayContaining([
      'schema_version', 'brain', 'enabled', 'state', 'directory', 'totals', 'by_op', 'serving', 'child_shed', 'children', 'recent_faults',
      'epoch_id', 'epoch_started_at', 'follower', 'reconcile', 'write_comparisons', 'fingerprints', 'seed', 'allocators', 'primary_refreshes',
    ]));
    expect(json.epoch_id).toBeNull(); // the epoch is the evidence epoch a child opens, not the seed
    expect(json.epoch_started_at).toBeNull();
    expect(json.seed).toMatchObject({ seed_id: 'seed-1' });
    expect(json.follower).toEqual({
      state: 'stopped', action: null, lag_ms: null, lag_ms_p99_24h: null, lag_ms_p99_epoch: null, queue_depth: 0, applied_rows: 0,
      coverage_watermark: { valid: false, through: null, invalidated_reason: 'not_started' },
    });
    expect(json.reconcile.state).toBe('never_run');
    expect(json.write_comparisons).toEqual({ state: 'capability_missing', sample_rate: 0.05, comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 });
    expect(json.fingerprints).toEqual({ checked_rows: 0, mismatches: 0, probe: {
      state: 'not_run', checked_at: null, server_version: null, collation: null, mismatches: 0, ctype: null, locale_provider: null, locale: null,
      differing_code_points: [], differing_code_points_total: 0, corpus_mismatches: 0, corpus_mismatch_rows: [], facts_with_differing_code_points: 0,
    } });
    expect((json as { seed: unknown }).seed).toEqual({ seed_id: 'seed-1', finished_at: SEED.finished_at, unseeded_gap_rows_total: 0, storage: null });
    expect(json.allocators).toEqual({ verified: false, checked_at: null });
    expect(json.primary_refreshes).toEqual({ nonterminal_rows: null, checked_at: null });
  });
});

/**
 * The S5a reading rules, pinned as a function so a consumer of `status --json` cannot read the fields loosely:
 * a missing field or a capability_missing write comparison is not ready, the follower must be caught up with a valid
 * watermark, no unseeded gap rows may remain, and the fingerprint probe must have run and passed.
 */
function shadowReadiness(s: Partial<FollowStatus>): 'ready' | 'not_ready' | 'follower_behind' | 'fingerprint_semantics_differ' {
  if (!s.follower || !s.write_comparisons || !s.fingerprints || !s.seed || !s.reconcile || !s.allocators || !s.primary_refreshes) return 'not_ready';
  if (s.write_comparisons.state === 'capability_missing') return 'not_ready';
  const f = s.follower;
  if ((f.lag_ms ?? 1) > 0 || f.queue_depth > 0 || !f.coverage_watermark.valid) return 'follower_behind';
  if ((s.seed.unseeded_gap_rows_total ?? 1) > 0) return 'not_ready';
  if ((s.primary_refreshes.nonterminal_rows ?? 1) > 0) return 'not_ready'; // drain refreshes first; unknown counts as open
  if (s.fingerprints.probe.state === 'fail') return 'fingerprint_semantics_differ';
  if (s.fingerprints.probe.state === 'not_run') return 'not_ready';
  return 'ready';
}

describe('shadowReadiness (the S5a reading rules)', () => {
  const good = (): FollowStatus => ({
    epoch_id: 'e', epoch_started_at: 't',
    follower: { state: 'following', action: null, lag_ms: 0, lag_ms_p99_24h: 4, lag_ms_p99_epoch: 4, queue_depth: 0, applied_rows: 1, coverage_watermark: { valid: true, through: 't', invalidated_reason: null } },
    reconcile: { state: 'ok', last_pass: null, consecutive_clean_full_passes: 1, last_clean_full_pass_at: 't', next_full_pass_due: null },
    write_comparisons: { state: 'capability_missing', sample_rate: 1, comparable: 0, unexplained_difference: 0, uncomparable: 0, capability_missing: 0 },
    fingerprints: { checked_rows: 1, mismatches: 0, probe: { ...NOT_RUN_PROBE, state: 'pass', checked_at: 't', server_version: '17', collation: 'C' } },
    seed: { seed_id: 'e', finished_at: 't', unseeded_gap_rows_total: 0 }, allocators: { verified: true, checked_at: 't' },
    primary_refreshes: { nonterminal_rows: 0, checked_at: 't' },
  });
  test('each rule', () => {
    expect(shadowReadiness(good())).toBe('not_ready'); // the write-comparison half is not built
    const ready = (s: FollowStatus) => { (s.write_comparisons as { state: string }).state = 'ok'; return s; };
    expect(shadowReadiness(ready(good()))).toBe('ready');
    expect(shadowReadiness({ ...ready(good()), seed: undefined })).toBe('not_ready');
    const behind = ready(good()); behind.follower.lag_ms = 5;
    expect(shadowReadiness(behind)).toBe('follower_behind');
    const invalid = ready(good()); invalid.follower.coverage_watermark.valid = false;
    expect(shadowReadiness(invalid)).toBe('follower_behind');
    const gap = ready(good()); gap.seed.unseeded_gap_rows_total = 2;
    expect(shadowReadiness(gap)).toBe('not_ready');
    const fail = ready(good()); fail.fingerprints.probe.state = 'fail';
    expect(shadowReadiness(fail)).toBe('fingerprint_semantics_differ');
    const notRun = ready(good()); notRun.fingerprints.probe.state = 'not_run';
    expect(shadowReadiness(notRun)).toBe('not_ready');
    const refreshing = ready(good()); refreshing.primary_refreshes.nonterminal_rows = 1;
    expect(shadowReadiness(refreshing)).toBe('not_ready');
    const unknown = ready(good()); unknown.primary_refreshes.nonterminal_rows = null;
    expect(shadowReadiness(unknown)).toBe('not_ready');
  });
});

class FakeChild extends EventEmitter {
  stdin = Object.assign(new PassThrough(), { unref() {} });
  stdout = Object.assign(new PassThrough(), { unref() {} });
  pid = 1;
  unref() {}
  kill() { return true; }
}

describe('supervisor request channel', () => {
  function harness() {
    const children: FakeChild[] = [];
    const dir = tmp();
    const sup = new ShadowSupervisor({ dir, argv: ['g'], spawn: (() => { const c = new FakeChild(); children.push(c); return c; }) as never, recordFault: () => {}, stillEnabled: () => true });
    return { sup, children };
  }
  test('a resp resolves its call, an error resp carries the code, and a large resp line is not dropped', async () => {
    const { sup, children } = harness();
    const ok = sup.request<{ n: number }>('m', { a: 1 });
    const sent = JSON.parse(String(children[0]!.stdin.read()));
    expect(sent).toMatchObject({ t: 'rpc', id: 1, method: 'm', args: { a: 1 } });
    children[0]!.stdout.write(JSON.stringify({ t: 'resp', id: 1, ok: true, value: { n: 1, pad: 'x'.repeat(200_000) } }) + '\n');
    expect((await ok).n).toBe(1);
    const bad = sup.request('m');
    children[0]!.stdout.write(JSON.stringify({ t: 'resp', id: 2, ok: false, error: { code: 'not_owner', message: 'no' } }) + '\n');
    await expect(bad).rejects.toMatchObject({ code: 'not_owner' });
  });
  test('pending calls reject when the child exits, and a call with no child rejects', async () => {
    const { sup, children } = harness();
    const pending = sup.request('m');
    children[0]!.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('child_unavailable');
    sup.stop();
    await expect(sup.request('m')).rejects.toThrow('child_unavailable');
  });
});

describe('shadow read source', () => {
  test('a failed first connection disconnects what it half opened, and a closed source never connects again', async () => {
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const connect = spyOn(PostgresEngine.prototype, 'connect').mockRejectedValue(new Error('refused'));
    const disconnect = spyOn(PostgresEngine.prototype, 'disconnect').mockResolvedValue(undefined);
    try {
      const reads = openReadSource({ capabilities: new Set(['postgres_admin']), connectedDatabaseUrl: 'postgresql://x@127.0.0.1:1/none' } as never, { pauseMs: 0 });
      await expect(reads.read(async () => 1)).rejects.toThrow('refused');
      expect(disconnect).toHaveBeenCalledTimes(1);
      await expect(reads.read(async () => 1)).rejects.toThrow('refused'); // not stuck on the failed attempt
      expect(connect).toHaveBeenCalledTimes(2);
      await reads.close();
      await expect(reads.read(async () => 1)).rejects.toThrow(/closed/);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally { connect.mockRestore(); disconnect.mockRestore(); }
  });
});

describe('the follower\'s two write counts', () => {
  const follower = () => new ShadowFollower({ reads: { pauseMs: 0, read: async () => { throw new Error('no reads'); }, close: async () => {} } as never, send: () => true, rpc: async () => { throw new Error('no child'); } });
  const batch = (seq: number, items: Invalidation[]) => ({ seq, committed_at: 0, items });
  const rows = (relation: string): Invalidation => ({ kind: 'rows', relation, selector: { id: '1' }, before_keys: null });

  test('`published` counts every batch (the stable rerun and the mirror read it); `pageLinkWrites` counts only a batch that can change a row a write comparison reads, so the process\'s own bookkeeping never moves it', async () => {
    const f = follower();
    f.publish(batch(1, [rows('persistence_effects'), { kind: 'relation', relation: 'persistence_requests', reason: 'raw_sql' }])); // journal rows
    f.publish(batch(2, [rows('link_transitions'), rows('config'), { kind: 'relation', relation: 'memory_proposals', reason: 'raw_sql' }]));
    expect([f.published, f.pageLinkWrites]).toEqual([2, 0]);
    f.publish(batch(3, [rows('pages')]));
    f.publish(batch(4, [rows('persistence_effects'), rows('links')]));
    f.publish(batch(5, [{ kind: 'relation', relation: 'pages', reason: 'raw_sql' }]));
    f.publish(batch(6, [{ kind: 'relation', relation: 'links', reason: 'raw_sql' }]));
    f.publish(batch(7, [{ kind: 'invalid', reason: 'unmapped_write:somethingNew' }])); // a write nothing can describe may have changed them: it counts
    expect([f.published, f.pageLinkWrites]).toEqual([7, 5]);
    await f.settle();
  });

  test('a batch whose only unmapped writes are journal members that write nothing a comparison reads (the protocol declaration, the counter lock, an effect\'s locks and completion) does not move `pageLinkWrites`; any other unmapped write, or a page or link row beside them, still does', async () => {
    const f = follower();
    const unmapped = (member: string): Invalidation => ({ kind: 'invalid', reason: `unmapped_write:${member}` });
    f.publish(batch(1, [unmapped('declarePersistence')])); // the effect worker looking for its next effect and finding none
    f.publish(batch(2, [unmapped('declarePersistence'), unmapped('lockPersistenceCounters'), { kind: 'relation', relation: 'persistence_requests', reason: 'raw_sql' }, { kind: 'relation', relation: 'persistence_counters', reason: 'raw_sql' }])); // a receipt true-up
    f.publish(batch(3, [unmapped('setEffectTransactionLimits'), unmapped('lockEffectGuard'), unmapped('lockEffectClaimRow'), unmapped('completeEffectRow'), rows('persistence_effects')])); // an effect that skipped
    expect([f.published, f.pageLinkWrites]).toEqual([3, 0]); // master: 3, so a link write sampled across any of them was marked moved
    f.publish(batch(4, [unmapped('declarePersistence'), unmapped('lockEffectGuard'), rows('links'), unmapped('completeEffectRow')])); // the links effect's own transaction
    f.publish(batch(5, [unmapped('declarePersistence'), unmapped('upsertWriteGateReceipt')])); // an unmapped write the sampler does not judge bookkeeping rides along
    f.publish(batch(6, [unmapped('takePageEmbeddingLease')]));
    f.publish(batch(7, [unmapped('declarePersistence'), { kind: 'invalid', reason: 'unparsable:error' }]));
    expect([f.published, f.pageLinkWrites]).toEqual([7, 4]);
    await f.settle();
  });
});
