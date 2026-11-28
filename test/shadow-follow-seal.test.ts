/**
 * Shadow follow, carrying a clean follower from one serving process to the next (follow-child.ts "Sealing", seal.ts),
 * without the Rust addon: the follow child against a fake store, and seal.ts against a fake read source.
 *
 * Protects: a short serve session that closed cleanly hands its obligations to the next one, and that next session is
 * valid only once its serving process confirms nobody else wrote. Every doubt leaves the watermark invalid until a full
 * pass: no seal, a seal rewritten or used twice, another seed, evidence epoch or state.json start, a seal without a
 * continuity, an invalidation line left after the seal (a lost write), a seal written while a line was unread, a
 * writer or coverage gap recorded after the mark, an unreadable mark or follower.json, a broken hook, a failed read.
 * Regression it catches: a restart trusted on its own word. The real-database path: test/e2e/shadow-serve-short-sessions.test.ts.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowChild, noteLostWrite, type FollowStore } from '../src/shadow/follow-child.ts';
import * as followStatus from '../src/shadow/follow-status.ts';
import { appendPass, buildFollowStatus, readFollowerFile, readPasses } from '../src/shadow/follow-status.ts';
import type { ReadSource } from '../src/shadow/read-pool.ts';
import { ShadowFollower } from '../src/shadow/follower.ts';
import { confirmSeal, quietSince, sealMark } from '../src/shadow/seal.ts';
import { writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { SHADOW_STATE_VERSION, writeShadowState, type ShadowState } from '../src/shadow/state.ts';
import { WRITER_HOOK_TRIGGER, writerHooksManifestPath } from '../src/shadow/writer-hooks.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gbrain-follow-seal-')); dirs.push(d); return d; };

const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as unknown as SeedRecord;
const STATE = { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'state-start-1', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'postgres' } as ShadowState;
const RESULT = { upserted: 1, deleted: 0, skipped_older: 0, displaced: 0, dropped: 0, unmapped_columns: [], losses: {} };
const store = (): FollowStore => ({
  replaceRelationRows: async () => RESULT, replaceInterval: async () => RESULT, relationDigest: async () => ({ rows: 0, digest: '' }),
  relationEntries: async () => [], allocatorCheck: async () => [], factFingerprints: async (texts) => texts.map(() => ({ fingerprint: 'a', fingerprint_v1: 'b' })),
  seedPlan: async () => ({ relations: [], carried: [], not_copied: [], gap_columns: [] }) as never,
});
const rpc = (id: number, method: string, args: Record<string, unknown> = {}) => ({ t: 'rpc' as const, id, method, args });
const apply = (committed_at: number) => ({ t: 'apply' as const, seq: 1, committed_at, relation: 'pages', generation: 1, keys: [], rows: [{ fact: 'x' }], digests: [] });

interface Session { child: FollowChild; lines: Array<Record<string, unknown>>; ask: <T = Record<string, unknown>>(method: string, args?: Record<string, unknown>) => Promise<T> }
function session(dir: string, o: { clock?: () => number; epoch?: string | null } = {}): Session {
  const lines: Array<Record<string, unknown>> = [];
  const child = new FollowChild({ dir, store: async () => store(), owner: () => true, writeControl: (l) => lines.push(JSON.parse(l)), now: o.clock ?? (() => 1_000), ...(o.epoch !== undefined ? { epochId: () => o.epoch! } : {}) });
  let id = 0;
  const ask = async <T,>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const n = ++id;
    child.handle(rpc(n, method, args));
    await child.close();
    const line = lines.find((l) => l.id === n) as { value: T };
    return line.value;
  };
  return { child, lines, ask };
}

/** A brain dir whose last owner session became valid and closed with a seal (`db_at` is the mark it was given). */
async function sealed(o: { epoch?: string | null; dbAt?: string | null; refused?: string; beforeSeal?: (s: Session, dir: string) => void | Promise<void> } = {}): Promise<{ dir: string; continuity: string }> {
  const dir = tmp();
  writeSeedRecord(dir, SEED);
  writeShadowState(dir, STATE);
  const s = session(dir, { clock: () => 1_000, epoch: o.epoch });
  expect(await s.ask('watermark', { valid: true, since: 1_500 })).toMatchObject({ valid: true });
  const continuity = (await s.ask<{ continuity: string }>('state')).continuity;
  expect(typeof continuity).toBe('string');
  await o.beforeSeal?.(s, dir);
  s.child.handle(o.refused ? { t: 'seal', db_at: null, refused: o.refused } as never : { t: 'seal', db_at: o.dbAt === undefined ? 'mark-1' : o.dbAt });
  await s.child.close();
  return { dir, continuity };
}

/** What status shows about the last seal decision (follower.json `seal_outcome`, status `follower.seal`). */
const sealShown = (dir: string) => buildFollowStatus(dir, STATE, new Date(5_000)).follower.seal ?? null;

type State = { valid: boolean; invalidated_reason: string | null; continuity: string | null; pending_seal: { db_at: string | null } | null };
const next = (dir: string, epoch?: string | null): Session => session(dir, { clock: () => 5_000, epoch });

/** Asserts the session took no seal: invalid for its own start, nothing to confirm, a continuity of its own. */
async function refused(s: Session, continuity: string, reason = 'follower_session_start'): Promise<void> {
  const st = await s.ask<State>('state');
  expect(st).toMatchObject({ valid: false, invalidated_reason: reason, pending_seal: null });
  expect(st.continuity).not.toBe(continuity);
  // Confirming anyway changes nothing.
  expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: false, confirmed: false });
}

describe('a sealed close', () => {
  test('the next session takes it over, stays invalid until its serving process confirms the mark, then is valid under the same continuity', async () => {
    const { dir, continuity } = await sealed();
    expect(readFollowerFile(dir)!.seal).toMatchObject({ version: 1, continuity, db_at: 'mark-1', state_started_at: 'state-start-1' });
    const s = next(dir);
    expect(await s.ask<State>('state')).toMatchObject({ valid: false, invalidated_reason: 'follower_session_start', continuity: null, pending_seal: { db_at: 'mark-1' } });
    expect(readFollowerFile(dir)!.seal).toBeUndefined(); // consumed at the start
    expect(sealShown(dir)).toMatchObject({ outcome: 'taken', reason: null });
    expect(await s.ask('confirmSeal', { db_at: 'other-mark', ok: true })).toMatchObject({ valid: false, confirmed: false }); // not this seal's mark
    expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: true, confirmed: true });
    expect(await s.ask<State>('state')).toMatchObject({ valid: true, continuity, pending_seal: null });
    expect(sealShown(dir)).toMatchObject({ outcome: 'confirmed', reason: null });
  });

  test('a seal carries the watermark, never a reconcile pass: no pass is appended and the newest clean full pass stays the one before', async () => {
    const finished = '2026-01-01T00:02:00.000Z';
    const { dir } = await sealed({ beforeSeal: (_s, d) => { appendPass(d, { id: 'p-1', kind: 'full', started_at: '2026-01-01T00:01:30.000Z', finished_at: finished, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 }); } });
    const s = next(dir);
    expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: true, confirmed: true });
    expect(readPasses(dir).map((p) => p.id)).toEqual(['p-1']);
    // Criterion 1's 24 h rule reads this time: carrying a seal over does not make the last pass any newer.
    expect(buildFollowStatus(dir, STATE, new Date('2026-01-03T00:00:00.000Z')).reconcile).toMatchObject({ consecutive_clean_full_passes: 1, last_clean_full_pass_at: finished });
  });

  test('an obligation the sealing session still held is carried over: confirmed, the next session is still invalid until a pass', async () => {
    const { dir } = await sealed({ beforeSeal: (s) => { s.child.handle({ t: 'watermark', valid: false, reason: 'relation_dirty', relation: 'tags' }); } });
    const s = next(dir);
    expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: false, confirmed: true });
    expect(await s.ask('watermark', { valid: true, since: 6_000, relations: ['tags'] })).toMatchObject({ valid: true });
  });

  test('taking a seal over writes the provisional invalid watermark in the same first write that consumes the seal: on disk before any call or close', async () => {
    const { dir } = await sealed();
    expect(readFollowerFile(dir)!.watermark.valid).toBe(true);
    next(dir); // constructed only: no call, no close (a process killed here leaves exactly this on disk)
    const disk = readFollowerFile(dir)!;
    expect(disk.seal).toBeUndefined();
    expect(disk.watermark).toMatchObject({ valid: false, invalidated_reason: 'follower_session_start' });
    expect(disk.seal_outcome).toMatchObject({ outcome: 'taken', reason: null });
    expect(buildFollowStatus(dir, STATE, new Date(5_500)).follower.coverage_watermark.valid).toBe(false);
  });

  test('a failed first write never freshens the valid file, and leaves a blocker so a later session cannot take the seal it could not remove', async () => {
    const { dir, continuity } = await sealed();
    const before = readFollowerFile(dir)!;
    let failed = 0;
    // Every write of the taking session fails (a full disk), then it dies before any other write.
    const spy = spyOn(followStatus, 'writeFollowerFile').mockImplementation(() => { failed++; throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
    try { next(dir); } finally { spy.mockRestore(); }
    expect(failed).toBe(2); // the injected failure fired: the consuming write, then the refusal's write
    const disk = readFollowerFile(dir)!;
    expect(disk.updated_at).toBe(before.updated_at); // not freshened
    expect(disk.seal).toBeDefined(); // the seal could not be removed
    // The session that failed died without another write; the next one must not take the seal over.
    const later = next(dir);
    expect(readFollowerFile(dir)!.seal_outcome).toMatchObject({ outcome: 'refused' });
    await refused(later, continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'invalidation_after_seal' });
  });

  for (const [what, event] of [['a watermark invalidation', { t: 'watermark', valid: false, reason: 'relation_dirty', relation: 'pages' }], ['an apply', apply(900)]] as const) {
    test(`${what} right after the seal, at the same clock, removes the seal from disk before the next event: a process killed then leaves nothing to take`, async () => {
      const dir = tmp();
      writeSeedRecord(dir, SEED);
      writeShadowState(dir, STATE);
      const s = session(dir, { clock: () => 1_000 });
      expect(await s.ask('watermark', { valid: true, since: 1_500 })).toMatchObject({ valid: true });
      s.child.handle({ t: 'seal', db_at: 'mark-1' });
      await s.child.pending();
      expect(readFollowerFile(dir)!.seal).toBeDefined();
      s.child.handle(event as never);
      await s.child.pending(); // no close and no tick: the process dies here
      expect(readFollowerFile(dir)!.seal).toBeUndefined();
      const later = next(dir);
      expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'seal_revoked' });
      await refused(later, (await s.ask<{ continuity: string }>('state')).continuity);
    });
  }

  test('unconfirmed, the session\'s own full obligation is settled only by a full pass that started after the session', async () => {
    const { dir } = await sealed();
    const s = next(dir);
    expect(await s.ask('watermark', { valid: true, since: 4_000 })).toMatchObject({ valid: false });
    expect(await s.ask('watermark', { valid: true, since: 6_000, relations: ['pages'] })).toMatchObject({ valid: false });
    expect(await s.ask('watermark', { valid: true, since: 6_000 })).toMatchObject({ valid: true });
  });

  test('a seal is used once: the session after the one that took it starts invalid', async () => {
    const { dir, continuity } = await sealed();
    const s = next(dir);
    await s.ask('state');
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'no_seal' });
  });

  test('anything after the seal voids it (an apply, an invalidation, a reconcile call)', async () => {
    for (const after of [apply(1_200), { t: 'watermark' as const, valid: false as const, reason: 'x' }, rpc(99, 'state')]) {
      const dir = tmp();
      writeSeedRecord(dir, SEED);
      writeShadowState(dir, STATE);
      const s = session(dir);
      await s.ask('watermark', { valid: true, since: 1_500 });
      const continuity = (await s.ask<{ continuity: string }>('state')).continuity;
      s.child.handle({ t: 'seal', db_at: 'mark-1' });
      s.child.handle(after);
      await s.child.close();
      expect(readFollowerFile(dir)!.seal).toBeUndefined();
      await refused(next(dir), continuity, after.t === 'watermark' ? 'x' : 'follower_session_start'); // the first reason stays
    }
  });
});

describe('every doubt about a seal leaves the watermark invalid', () => {
  test('PGLite: a seal with no database mark (what a PGLite close wrote) is never taken over, with the reason shown', async () => {
    const { dir, continuity } = await sealed({ dbAt: null });
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'pglite_no_db_continuity' });
  });

  test('a close the serving process would not seal records why, and the next session shows that reason', async () => {
    const { dir, continuity } = await sealed({ refused: 'other_writer_open' });
    expect(readFollowerFile(dir)!.seal).toBeUndefined();
    expect(sealShown(dir)).toMatchObject({ outcome: 'not_sealed', reason: 'other_writer_open' });
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'other_writer_open' });
  });

  test('missing seal', async () => {
    const { dir, continuity } = await sealed();
    const file = readFollowerFile(dir)!;
    delete file.seal;
    writeFileSync(join(dir, 'follower.json'), JSON.stringify(file));
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'no_seal' });
  });

  test('follower.json written again after the seal (seal.at is not updated_at)', async () => {
    const { dir, continuity } = await sealed();
    const file = readFollowerFile(dir)!;
    file.updated_at = new Date(9_000).toISOString();
    writeFileSync(join(dir, 'follower.json'), JSON.stringify(file));
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'seal_rewritten' });
  });

  test('wrong evidence epoch', async () => {
    const { dir, continuity } = await sealed({ epoch: 'epoch-1' });
    await refused(next(dir, 'epoch-2'), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'evidence_epoch_changed' });
  });

  test('wrong seed: another seed is not this follower at all', async () => {
    const { dir, continuity } = await sealed();
    writeSeedRecord(dir, { ...SEED, seed_id: 'seed-2' } as SeedRecord);
    await refused(next(dir), continuity, 'not_reconciled');
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'follower_state_reset' });
  });

  test('state.json restarted since the seal', async () => {
    const { dir, continuity } = await sealed();
    writeShadowState(dir, { ...STATE, started_at: 'state-start-2' });
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'shadow_restarted' });
  });

  test('shadow disabled since the seal', async () => {
    const { dir, continuity } = await sealed();
    writeShadowState(dir, { ...STATE, enabled: false });
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'shadow_disabled' });
  });

  test('wrong continuity: a seal that names none', async () => {
    const { dir, continuity } = await sealed();
    const file = readFollowerFile(dir)!;
    file.seal!.continuity = '';
    writeFileSync(join(dir, 'follower.json'), JSON.stringify(file));
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'seal_no_continuity' });
  });

  test('dropped write: a line left in follower-invalidations.jsonl after the seal', async () => {
    const { dir, continuity } = await sealed();
    noteLostWrite(dir, 'published_after_close', 2_000);
    await refused(next(dir), continuity);
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'invalidation_after_seal' });
  });

  test('dropped write: a line left before the seal is carried as a full obligation, and no seal is written when the file cannot be read', async () => {
    const { dir } = await sealed({ beforeSeal: (_s, d) => { noteLostWrite(d, 'apply_shed', 1_100); } });
    const s = next(dir);
    expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: false, confirmed: true });
    const { dir: dir2 } = await sealed({ beforeSeal: (_s, d) => { rmSync(join(d, 'follower-invalidations.jsonl'), { force: true }); mkdirSync(join(d, 'follower-invalidations.jsonl')); } });
    expect(readFollowerFile(dir2)!.seal).toBeUndefined();
    expect(sealShown(dir2)).toMatchObject({ outcome: 'not_sealed', reason: 'invalidation_unread' });
  });

  test('unknown writer: the serving process refuses the mark; the obligation stays and the continuity changes', async () => {
    const { dir, continuity } = await sealed();
    const s = next(dir);
    expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: false, reason: 'writer_evidence_changed' })).toMatchObject({ valid: false, confirmed: false });
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'writer_evidence_changed' });
    const st = await s.ask<State>('state');
    expect(st).toMatchObject({ valid: false, pending_seal: null });
    expect(st.continuity).not.toBe(continuity);
    expect(await s.ask('confirmSeal', { db_at: 'mark-1', ok: true })).toMatchObject({ valid: false, confirmed: false }); // no second try
  });

  test('parse error: an unreadable follower.json starts over', async () => {
    const { dir, continuity } = await sealed();
    writeFileSync(join(dir, 'follower.json'), readFileSync(join(dir, 'follower.json'), 'utf8').slice(0, 40));
    await refused(next(dir), continuity, 'not_reconciled');
    expect(sealShown(dir)).toMatchObject({ outcome: 'refused', reason: 'follower_state_reset' });
  });
});

/** A fake Postgres read source: answers the seal queries with `row`, and the hook catalog with `hooked` of `tables`. */
function fakeReads(row: Record<string, unknown> | (() => Record<string, unknown>), o: { tables?: string[]; hooked?: string[]; fail?: boolean; hang?: boolean } = {}): ReadSource & { sql: string[] } {
  const sql: string[] = [];
  const tables = o.tables ?? ['pages', 'tags'];
  const tx = { executeRaw: async (_q: string, params: unknown[]) => (params?.[0] === WRITER_HOOK_TRIGGER ? (o.hooked ?? tables) : tables).map((name) => ({ name })) };
  return {
    sql, pauseMs: 0, close: async () => undefined,
    read: async <T,>(fn: (tx: never, query: (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> => {
      if (o.fail) throw new Error('connection refused');
      if (o.hang) return new Promise<T>(() => undefined);
      return fn(tx as never, async (q) => { sql.push(q); return q.startsWith('SET') ? [] : [typeof row === 'function' ? row() : row]; });
    },
  } as never;
}
const MARK_ROW = { app: 'gbrain-1-abc', writing: 0, live: 0, writers: 2, writers_max: '2026-11-28 10:00:00+00', gaps: 0, gaps_max: '' };
const SINCE_ROW = { writers: 2, writers_max: '2026-11-28 10:00:00+00', gaps: 0, gaps_max: '' };
function hooked(): string { const dir = tmp(); writeFileSync(writerHooksManifestPath(dir), JSON.stringify({ version: 1, state: 'installed', at: 'x', tables: ['pages', 'tags'] })); return dir; }

describe('seal.ts: the primary\'s writer evidence', () => {
  test('PGLite never takes a seal over: no mark is written and nothing is quiet, named pglite_no_db_continuity (no proof the database was untouched between sessions)', async () => {
    const dir = tmp();
    expect(await sealMark({ dir, reads: fakeReads(MARK_ROW), postgres: false })).toEqual({ refused: 'pglite_no_db_continuity' });
    expect(await quietSince({ dir, reads: fakeReads(SINCE_ROW), postgres: false }, null)).toEqual({ ok: false, reason: 'pglite_no_db_continuity' });
  });

  test('a mark is the writer evidence fingerprint, read with row security off; the same fingerprint later is quiet', async () => {
    const dir = hooked();
    const reads = fakeReads(MARK_ROW);
    const mark = await sealMark({ dir, reads, postgres: true });
    expect('token' in mark).toBe(true);
    expect(JSON.parse((mark as { token: string }).token)).toEqual({ app: 'gbrain-1-abc', writers: 2, writers_max: '2026-11-28 10:00:00+00', gaps: 0, gaps_max: '' });
    expect(reads.sql[0]).toBe('SET LOCAL row_security = off');
    const since = fakeReads(SINCE_ROW);
    expect(await quietSince({ dir, reads: since, postgres: true }, (mark as { token: string }).token)).toEqual({ ok: true });
    expect(since.sql[0]).toBe('SET LOCAL row_security = off');
  });

  test('no mark while another process has a write open or wrote recently and is still connected, the hooks are not installed, or the read fails or hangs; each with its reason', async () => {
    const dir = hooked();
    expect(await sealMark({ dir, reads: fakeReads({ ...MARK_ROW, writing: 1 }), postgres: true })).toEqual({ refused: 'other_writer_open' });
    expect(await sealMark({ dir, reads: fakeReads({ ...MARK_ROW, live: 1 }), postgres: true })).toEqual({ refused: 'other_writer_live' });
    expect(await sealMark({ dir, reads: fakeReads({ ...MARK_ROW, writers: null }), postgres: true })).toEqual({ refused: 'mark_unreadable' });
    expect(await sealMark({ dir: tmp(), reads: fakeReads(MARK_ROW), postgres: true })).toEqual({ refused: 'hooks_not_installed' });
    expect(await sealMark({ dir, reads: fakeReads(MARK_ROW, { fail: true }), postgres: true })).toEqual({ refused: 'read_failed' });
    expect(await sealMark({ dir, reads: fakeReads(MARK_ROW, { hang: true }), postgres: true })).toEqual({ refused: 'read_timeout' });
  });

  const mark = JSON.stringify({ app: 'gbrain-1-abc', writers: 2, writers_max: '2026-11-28 10:00:00+00', gaps: 0, gaps_max: '' });
  test('unknown writer: a new writer row, or a moved last_seen, is not quiet', async () => {
    const dir = hooked();
    expect(await quietSince({ dir, reads: fakeReads({ ...SINCE_ROW, writers: 3 }), postgres: true }, mark)).toEqual({ ok: false, reason: 'writer_evidence_changed' });
    expect(await quietSince({ dir, reads: fakeReads({ ...SINCE_ROW, writers_max: '2026-11-28 10:00:01+00' }), postgres: true }, mark)).toEqual({ ok: false, reason: 'writer_evidence_changed' });
  });

  test('coverage gap: a new gap row is not quiet', async () => {
    const dir = hooked();
    expect(await quietSince({ dir, reads: fakeReads({ ...SINCE_ROW, gaps: 1, gaps_max: '2026-11-28 10:00:02+00' }), postgres: true }, mark)).toEqual({ ok: false, reason: 'coverage_gap' });
  });

  test('a hook dropped or disabled on any table is not quiet', async () => {
    const dir = hooked();
    expect(await quietSince({ dir, reads: fakeReads(SINCE_ROW, { hooked: ['pages'] }), postgres: true }, mark)).toEqual({ ok: false, reason: 'hook_missing' });
  });

  test('parse error: no mark, an unreadable mark or one of the wrong shape is not quiet', async () => {
    const dir = hooked();
    for (const token of [null, '', 'not json', '{"app":"x"}', JSON.stringify({ ...JSON.parse(mark), writers: '2' })]) {
      expect(await quietSince({ dir, reads: fakeReads(SINCE_ROW), postgres: true }, token)).toEqual({ ok: false, reason: 'mark_unreadable' });
    }
  });

  test('hooks not installed, a failed read or one that hangs is not quiet', async () => {
    expect(await quietSince({ dir: tmp(), reads: fakeReads(SINCE_ROW), postgres: true }, mark)).toEqual({ ok: false, reason: 'hooks_not_installed' });
    expect(await quietSince({ dir: hooked(), reads: fakeReads(SINCE_ROW, { fail: true }), postgres: true }, mark)).toEqual({ ok: false, reason: 'read_failed' });
    expect(await quietSince({ dir: hooked(), reads: fakeReads(SINCE_ROW, { hang: true }), postgres: true }, mark)).toEqual({ ok: false, reason: 'read_timeout' });
  });

  test('confirmSeal asks only when a seal is pending, and passes the verdict and its reason for that seal\'s mark', async () => {
    const calls: Array<[string, unknown]> = [];
    const rpcFor = (pending: unknown) => (async (method: string, args?: unknown) => { calls.push([method, args]); return method === 'state' ? { pending_seal: pending } : {}; }) as never;
    await confirmSeal({ dir: hooked(), reads: fakeReads(SINCE_ROW), postgres: true, rpc: rpcFor(null) });
    expect(calls.map(([m]) => m)).toEqual(['state']);
    calls.length = 0;
    await confirmSeal({ dir: hooked(), reads: fakeReads(SINCE_ROW), postgres: true, rpc: rpcFor({ db_at: mark }) });
    expect(calls[1]).toEqual(['confirmSeal', { db_at: mark, ok: true, reason: null }]);
    calls.length = 0;
    await confirmSeal({ dir: hooked(), reads: fakeReads({ ...SINCE_ROW, writers: 3 }), postgres: true, rpc: rpcFor({ db_at: mark }) });
    expect(calls[1]).toEqual(['confirmSeal', { db_at: mark, ok: false, reason: 'writer_evidence_changed' }]);
    await confirmSeal({ dir: hooked(), reads: fakeReads(SINCE_ROW), postgres: true, rpc: (async () => { throw new Error('child gone'); }) as never }); // never rejects
  });
});

describe('the serving side records a write it will never hand over', () => {
  test('dropped write: a batch published after close, or a line the child would not take, is reported lost', async () => {
    const lost: string[] = [];
    let accept = true;
    const f = new ShadowFollower({ reads: { pauseMs: 0, read: async () => { throw new Error('no reads'); }, close: async () => {} } as never, send: () => accept, rpc: async () => { throw new Error('no child'); }, onLost: (reason) => lost.push(reason) });
    accept = false;
    f.publish({ seq: 1, committed_at: 0, items: [{ kind: 'invalid', reason: 'unmapped_write:x' }] });
    await f.settle();
    expect(lost.length).toBeGreaterThanOrEqual(1);
    lost.length = 0;
    accept = true;
    f.close();
    f.publish({ seq: 2, committed_at: 0, items: [{ kind: 'rows', relation: 'pages', selector: { id: '1' }, before_keys: null }] });
    expect(lost).toEqual(['published_after_close']); // at once, inside the publishing call
  });
});
