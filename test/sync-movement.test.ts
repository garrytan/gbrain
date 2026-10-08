/**
 * #6317 (B4, I2, T4): the movement reader and `gbrain sources writer movement`
 * judge managed sync by committed pages and the head's step, never by a
 * renewed lease, a live lock or a green /health. Fixtures on in-memory PGLite:
 * one managed source (claimed worktree) with a pending `managed-sync` cursor,
 * committed `managed_sync_import` receipts stamped at chosen times, a running
 * head with a claim stamp, the per-source sync lock, and a hold summary row.
 *
 * Reader (B4): nothing pending → `nothing_pending`; a pending cursor with no
 * drain and no live consumer → `parked` (data_moving null, never counted); a
 * live drain whose last progress is older than the ceiling → `not_moving`
 * (data_moving false, `not_moving_since` is the watermark); a commit or a head
 * step inside the ceiling → `moving`; a hold newer than the last commit →
 * `held`. Doctor warns only for `not_moving`.
 *
 * Command (T4): a pending cursor nothing moves exits 1 with
 * `managed_sync_not_moving`; a moving one exits 0; nothing pending skips the
 * wait and exits 0; a healthy source beside a stalled one exits 1 naming the
 * stalled one; holds-only advance is `held`, exit 0, with the hold kind's
 * route; a group whose head step advances inside the window is
 * `within_allowance`, exit 0 with `retry_after_ms`; `--warn-only` exits 0 on
 * the not-moving fixture; the default window never drops below one sync
 * preparation budget; every state's envelope follows the v1 contract.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { syncLockId, tryAcquireDbLock, type DbLockHandle } from '../src/core/db-lock.ts';
import { withEnv } from './helpers/with-env.ts';
import { judgeMovement, readSourceMovement, startMovementWatch, formatSourceMovement } from '../src/core/persistence/sync-movement.ts';
import { movementReport, movementWindowMs, parseMovementArgs, runMovementCheck, MOVEMENT_SUPERVISOR_STEP } from '../src/commands/sources-writer-movement.ts';
import { managedSyncMovementEntry } from '../src/commands/doctor/checks/managed-sync-movement.ts';
import { deriveNext, cliRenderContext } from '../src/core/agent-output.ts';
import { CODES } from '../src/core/error-registry.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-movement-'));
let engine: BrainEngine;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Fixture { id: string; worktreeId: string; incarnation: string }
async function managedSource(): Promise<Fixture> {
  const id = `mv-${randomUUID().slice(0, 8)}`, root = join(home, id);
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const [row] = await engine.executeRaw<{ worktree_id: string; incarnation: string }>(
    'SELECT b.worktree_id::text AS worktree_id, b.source_incarnation::text AS incarnation FROM persistence_source_bindings b WHERE b.source_id=$1', [id]);
  return { id, worktreeId: row!.worktree_id, incarnation: row!.incarnation };
}
async function cursor(f: Fixture, index: number, total: number, extra: Record<string, unknown> = {}): Promise<void> {
  const header = { sourceId: f.id, index, total, runId: randomUUID(), counts: { added: 0, modified: 0, deleted: 0, chunks: 0, ...(extra.counts as object ?? {}) }, ...extra };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,$2::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys`, [`cursor:${f.id}`, JSON.stringify([header])]);
}
async function request(f: Fixture, state: 'committed' | 'running' | 'queued', opts: { completedAt?: string; stamp?: Record<string, unknown>; lapsed?: boolean; kind?: string } = {}): Promise<string> {
  const token = randomUUID(), requestId = randomUUID();
  const stamp = opts.stamp ? JSON.stringify({ phase: 'preparing', claimed_at: ago(90_000), since: ago(60_000), token, waiting_on: 'db', owner: { kind: 'serve', pid: process.pid + 1, version: 'test', nonce: 'other' }, ...opts.stamp }) : null;
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,
      state,execution_token,claim_expires_at,claim_phase,completed_at)
    VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,$4,$5::uuid,'d','{}'::jsonb,$6::text::jsonb,1,16384,$7,
      ${state === 'running' ? '$8::uuid' : 'NULLIF($8::text,$8::text)::uuid'},${state === 'running' ? (opts.lapsed ? "now()-interval '1 second'" : "now()+interval '30 seconds'") : 'NULL'},$9::text::jsonb,$10::timestamptz)`,
  [requestId, f.id, f.incarnation, `notes/${requestId.slice(0, 6)}`, f.worktreeId, JSON.stringify({ kind: opts.kind ?? 'managed_sync_import', path: 'p.md' }), state, token, stamp, opts.completedAt ?? null]);
  return requestId;
}
async function holdSummary(f: Fixture, counts: { count: number; stalled?: number; fences?: number }, at: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('sync-hold-summary',$1,$2::text::jsonb,$3::timestamptz)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=EXCLUDED.updated_at`,
  [`hold-summary:${f.id}`, JSON.stringify([{ source_id: f.id, incarnation: f.incarnation, count: counts.count, stale: 0, stalled: counts.stalled ?? 0, fences: counts.fences ?? 0, concurrent: 0 }]), at]);
}
/** Ends a fixture's pending work, so a later brain-wide check does not read it as parked. */
const finish = (f: Fixture) => engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [`cursor:${f.id}`]);
const one = async (f: Fixture, now?: number) => (await readSourceMovement(engine, { sourceIds: [f.id], ...(now ? { now } : {}) }))[0]!;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
  // A 60 s ceiling (its floor is the larger budget plus 30 s) and the smallest budgets, so the command's window floor is 1 s.
  for (const [key, value] of [['persistence.sync_preparation_ms', '1000'], ['persistence.maintenance_preparation_ms', '1000'], ['persistence.preparation_ceiling_ms', '60000']]) {
    await engine.executeRaw('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

describe('readSourceMovement (B4)', () => {
  test('nothing pending, parked, not moving, moving by commit, moving by step, held', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    expect(await one(f)).toMatchObject({ source_id: f.id, movement_state: 'nothing_pending', data_moving: null, cursor: null, writer_status_command: `gbrain sources writer status --source ${f.id} --json` });

    await cursor(f, 3, 10, { progress: { startedAt: Date.now() - 300_000, startIndex: 0, lastAt: Date.now() - 200_000, lastIndex: 3 } });
    await request(f, 'committed', { completedAt: ago(200_000) });
    // Pending, but no drain holds the lock and no managed request is admitted: parked, informational.
    expect(await one(f)).toMatchObject({ movement_state: 'parked', data_moving: null, not_moving_since: null, live: { drain: false, consumer: null } });
    expect(formatSourceMovement(await one(f))).toContain('parked at 3/10');

    // A live drain and a watermark 200 s old against a 60 s ceiling: not moving since the watermark.
    const lock = await tryAcquireDbLock(engine, syncLockId(f.id));
    try {
      const stuck = await one(f);
      expect(stuck).toMatchObject({ movement_state: 'not_moving', data_moving: false, live: { drain: true, drain_pid: process.pid }, ceiling_ms: 60_000, cursor: { index: 3, total: 10, remaining: 7, held: 0 } });
      expect(stuck.not_moving_since).toBe(stuck.last_commit_at);
      expect(Date.now() - Date.parse(stuck.not_moving_since!)).toBeGreaterThanOrEqual(199_000);
      expect(formatSourceMovement(stuck)).toContain('NOT MOVING since');
      // A commit inside the ceiling: moving.
      await request(f, 'committed', { completedAt: ago(5_000) });
      expect(await one(f)).toMatchObject({ movement_state: 'moving', data_moving: true, not_moving_since: null });
    } finally { await lock!.release(); }

    // No drain, but an admitted head whose owner renews a stamped claim: the claim proves a consumer; its step advance is progress.
    const g = await managedSource();
    await cursor(g, 0, 16);
    await request(g, 'committed', { completedAt: ago(500_000) });
    await request(g, 'running', { stamp: { step: 'import_screen', step_since: ago(10_000), last_sql: { label: 'SELECT pages', at: ago(4_000) } } });
    const stepping = await one(g);
    expect(stepping).toMatchObject({ movement_state: 'moving', data_moving: true, admitted: 1, live: { drain: false, consumer: 'claim' },
      head: { state: 'running', phase: 'preparing', step: 'import_screen', waiting_on: 'db', owner: { kind: 'serve', pid: process.pid + 1, nonce: 'other' }, last_sql: { label: 'SELECT pages' } } });
    expect(stepping.last_progress_at).toBe(stepping.head!.step_since);
    // The same head parked on its step for longer than the ceiling: not moving, even though the lease renews.
    await engine.executeRaw(`UPDATE persistence_requests SET claim_phase = claim_phase || $2::text::jsonb WHERE worktree_id=$1::uuid AND state='running'`, [g.worktreeId, JSON.stringify({ step_since: ago(120_000) })]);
    expect(await one(g)).toMatchObject({ movement_state: 'not_moving', data_moving: false });

    // Holds newer than the last commit: held (the containment, not a stall).
    await holdSummary(g, { count: 2, stalled: 2 }, ago(1_000));
    expect(await one(g)).toMatchObject({ movement_state: 'held', data_moving: true, holds: { count: 2, stalled: 2 } });
    await finish(f); await finish(g);
  }), 60_000);
});

describe('gbrain sources writer movement (I2, T4)', () => {
  const fast = { pollMs: 100 };

  test('the default window never drops below one sync preparation budget and the flags parse', () => {
    expect(movementWindowMs({ syncMs: 120_000 })).toEqual({ window_ms: 300_000, budget_ms: 120_000, source: 'default' });
    expect(movementWindowMs({ syncMs: 900_000 })).toEqual({ window_ms: 960_000, budget_ms: 900_000, source: 'default' });
    expect(movementWindowMs({ syncMs: 120_000 }, 30_000)).toEqual({ window_ms: 120_000, budget_ms: 120_000, source: '--wait' });
    expect(parseMovementArgs(['default', '--wait', '5m', '--warn-only', '--json'])).toEqual({ sourceId: 'default', waitMs: 300_000, warnOnly: true, json: true });
    expect(parseMovementArgs(['--source=notes', '--wait=45'])).toMatchObject({ sourceId: 'notes', waitMs: 45_000 });
    expect(() => parseMovementArgs(['a', 'b'])).toThrow(/Specify the source once/);
    expect(() => parseMovementArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(MOVEMENT_SUPERVISOR_STEP).toBe('after restarting serve and the workers, run: gbrain sources writer movement');
  });

  test('a pending cursor nothing moves exits 1 with managed_sync_not_moving; moving exits 0; nothing pending skips the wait', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    // Nothing pending: no wait, exit 0.
    const idle = await runMovementCheck(engine, { sourceId: f.id, waitMs: 60_000, ...fast });
    expect(idle).toMatchObject({ exit_code: 0, waited_ms: 0, window_ms: 60_000, budget_ms: 1_000, sources: [{ state: 'nothing_pending', exit: 0, code: null }] });
    expect(idle.error).toBeUndefined();

    await cursor(f, 2, 10);
    await request(f, 'committed', { completedAt: ago(300_000) });
    // Parked: pending and nothing live to move it (after a restart, the catch-up was not started again) → exit 1, resume command as the fix.
    const parked = await runMovementCheck(engine, { sourceId: f.id, waitMs: 1_000, ...fast });
    expect(parked).toMatchObject({ exit_code: 1, sources: [{ state: 'parked', exit: 1, code: 'managed_sync_not_moving', reason: 'movement_check' }] });
    expect(parked.sources[0]!.fix).toMatchObject({ next: 'run', command: `gbrain sync --source ${f.id} --no-pull` });
    expect(parked.error).toMatchObject({ code: 'managed_sync_not_moving', reason: 'movement_check', class: 'server', retryable: false, contract_version: 1 });
    expect(parked.error!.fix).toMatchObject({ next: 'run', argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.id, '--json'] });
    expect(parked.error!.docs).toContain('troubleshooting.md#managed-sync-not-moving');

    const lock = await tryAcquireDbLock(engine, syncLockId(f.id));
    try {
      // A live drain and no commit, step or cursor advance inside the window: not_moving, exit 1 with the writer summary.
      const stuck = await runMovementCheck(engine, { sourceId: f.id, waitMs: 1_000, ...fast });
      expect(stuck).toMatchObject({ exit_code: 1, sources: [{ state: 'not_moving', exit: 1, code: 'managed_sync_not_moving', reason: 'movement_check' }] });
      expect(stuck.sources[0]!.why).toContain('no page committed and no step advance');
      expect(stuck.sources[0]!.fix).toMatchObject({ next: 'run', command: `gbrain sources writer status --source ${f.id} --json` });
      expect(stuck.sources[0]!.fix!.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'movement', f.id, '--json']);
      // The consumer commits during the window: moved, exit 0, and the window ends early.
      const started = Date.now();
      const moving = runMovementCheck(engine, { sourceId: f.id, waitMs: 120_000, pollMs: 100 });
      await new Promise(r => setTimeout(r, 50));
      await request(f, 'committed', { completedAt: ago(0) });
      const result = await moving;
      expect(result).toMatchObject({ exit_code: 0, sources: [{ state: 'moved', exit: 0, code: null }] });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { await lock!.release(); await finish(f); }
  }), 60_000);

  test('a healthy source beside a stalled one exits 1 naming the stalled one; --warn-only is the caller\'s exit 0', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const healthy = await managedSource(), stalled = await managedSource();
    await cursor(stalled, 1, 5); await request(stalled, 'committed', { completedAt: ago(400_000) });
    const locks = [await tryAcquireDbLock(engine, syncLockId(stalled.id)), await tryAcquireDbLock(engine, syncLockId(healthy.id))];
    try {
      await cursor(healthy, 1, 5);
      const check = runMovementCheck(engine, { waitMs: 2_000, pollMs: 100 });
      await new Promise(r => setTimeout(r, 50));
      await request(healthy, 'committed', { completedAt: ago(0) });
      // The healthy one moved; the stalled one keeps the window pending, so the check runs its full (short) window.
      const result = await check;
      expect(result.waited_ms).toBeGreaterThanOrEqual(2_000);
      expect(result.exit_code).toBe(1);
      expect(result.sources.find(r => r.source_id === healthy.id)).toMatchObject({ state: 'moved', exit: 0 });
      expect(result.sources.find(r => r.source_id === stalled.id)).toMatchObject({ state: 'not_moving', exit: 1 });
      expect(result.error!.message).toContain(stalled.id);
    } finally { for (const lock of locks) await lock!.release(); await finish(healthy); await finish(stalled); }
  }), 90_000);

  test('holds-only advance is held (exit 0, the hold kind\'s route); a head step advance inside the window is within_allowance (exit 0, retry_after_ms)', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    await cursor(f, 4, 20, { counts: { held: 1 } });
    await request(f, 'committed', { completedAt: ago(500_000) });
    const lock = await tryAcquireDbLock(engine, syncLockId(f.id));
    try {
      const check = runMovementCheck(engine, { sourceId: f.id, waitMs: 1_000, pollMs: 100 });
      await new Promise(r => setTimeout(r, 50));
      await holdSummary(f, { count: 1, stalled: 1 }, ago(0));
      const held = await check;
      expect(held).toMatchObject({ exit_code: 0, sources: [{ state: 'held', exit: 0, code: null }] });
      expect(held.sources[0]!.fix).toMatchObject({ next: 'run', argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.id, '--json'] });
      expect(held.sources[0]!.why).toContain('1 preparation_stalled');
      // A fence hold routes to the fence repair preview instead.
      await holdSummary(f, { count: 2, stalled: 0, fences: 2 }, ago(0));
      const fenceCheck = runMovementCheck(engine, { sourceId: f.id, waitMs: 1_000, pollMs: 100 });
      await new Promise(r => setTimeout(r, 50));
      await holdSummary(f, { count: 3, stalled: 0, fences: 3 }, ago(0));
      expect((await fenceCheck).sources[0]).toMatchObject({ state: 'held', fix: { argv: ['gbrain', 'repair', 'fences', '--source', f.id] } });

      // A 16-member group preparing in waves: the head's step advances, nothing commits: within_allowance.
      const g = await managedSource();
      await cursor(g, 0, 16);
      await request(g, 'running', { stamp: { step: 'raw_hash', step_since: ago(2_000) } });
      const lockG = await tryAcquireDbLock(engine, syncLockId(g.id));
      try {
        const waves = runMovementCheck(engine, { sourceId: g.id, waitMs: 1_000, pollMs: 100 });
        await new Promise(r => setTimeout(r, 50));
        await engine.executeRaw(`UPDATE persistence_requests SET claim_phase = claim_phase || $2::text::jsonb WHERE worktree_id=$1::uuid AND state='running'`, [g.worktreeId, JSON.stringify({ step: 'import_screen', step_since: ago(0) })]);
        const result = await waves;
        expect(result).toMatchObject({ exit_code: 0, sources: [{ state: 'within_allowance', exit: 0, code: null, retry_after_ms: 1_000 }] });
        expect(result.sources[0]!.fix).toMatchObject({ next: 'run', argv: ['gbrain', 'sources', 'writer', 'movement', g.id, '--json'] });
        expect(result.sources[0]!.why).toContain('multi-wave group');
      } finally { await lockG!.release(); await finish(g); }
    } finally { await lock!.release(); await finish(f); }
  }), 60_000);

  test('every state\'s envelope follows the v1 contract: a fix with argv, consent, actor, a derived next and a read-only verify', () => {
    const base = (over: Record<string, unknown>) => ({ source_id: 's', sampled_at: ago(0), movement_state: 'moving', data_moving: true, not_moving_since: null, last_commit_at: ago(1_000), last_progress_at: ago(1_000),
      cursor: { index: 1, total: 4, remaining: 3, held: 0, last_progress_at: null, resume_command: 'gbrain sync --source s --no-pull' }, head: null, holds: { count: 0, stalled: 0, fences: 0, concurrent: 0, last_hold_at: null },
      admitted: 1, live: { drain: true, drain_pid: 1, consumer: null }, ceiling_ms: 600_000, owner_is_this_host: true, writer_status_command: 'gbrain sources writer status --source s --json', ...over }) as Parameters<typeof movementReport>[1];
    const states: Array<[ReturnType<typeof judgeMovement>, Parameters<typeof movementReport>[0], Parameters<typeof movementReport>[1]]> = [
      ['nothing_pending', undefined, base({ movement_state: 'nothing_pending', cursor: null, data_moving: null })],
      ['moved', base({ last_commit_at: ago(100_000) }), base({})],
      ['within_allowance', base({ head: { request_id: 'r', state: 'running', phase: 'preparing', step: 'a', step_since: ago(50_000), step_age_ms: 50_000, waiting_on: 'db', owner: null, last_sql: null, lapsed: false } }),
        base({ last_commit_at: null, head: { request_id: 'r', state: 'running', phase: 'preparing', step: 'b', step_since: ago(1_000), step_age_ms: 1_000, waiting_on: 'db', owner: null, last_sql: null, lapsed: false } })],
      ['held', base({ holds: { count: 0, stalled: 0, fences: 0, concurrent: 0, last_hold_at: null } }), base({ holds: { count: 1, stalled: 0, fences: 1, concurrent: 0, last_hold_at: ago(0) } })],
      ['parked', base({ movement_state: 'parked', live: { drain: false, drain_pid: null, consumer: null } }), base({ movement_state: 'parked', live: { drain: false, drain_pid: null, consumer: null } })],
      ['not_moving', base({}), base({})],
    ];
    for (const [expected, before, after] of states) {
      const report = movementReport(before, after, 300_000);
      expect(report.state).toBe(expected);
      expect(report.exit).toBe(expected === 'not_moving' || expected === 'parked' ? 1 : 0);
      expect(report.code).toBe(report.exit ? 'managed_sync_not_moving' : null);
      expect(report.why.length).toBeGreaterThan(20);
      if (report.fix) {
        expect(report.fix.argv?.[0]).toBe('gbrain');
        expect(report.fix.consent).toEqual([]);
        expect(['run', 'tell_user_to_run']).toContain(report.fix.next);
        expect(report.fix.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'movement', 's', '--json']);
      } else expect(['nothing_pending', 'moved']).toContain(expected);
    }
    // The registry entry the command's envelope rides on.
    const entry = CODES.managed_sync_not_moving;
    expect(entry.reasons).toContain('movement_check');
    expect(deriveNext(entry.fix!, cliRenderContext())).toBe('run');
  });
});

describe('doctor managed_sync_not_moving and the serve notice', () => {
  test('warns only for not_moving (structured fix), lists parked as info, ok when nothing is pending; the watch prints one notice per flip', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const ctx = { engine } as unknown as Parameters<typeof managedSyncMovementEntry.run>[0];
    const f = await managedSource();
    await cursor(f, 1, 9); await request(f, 'committed', { completedAt: ago(400_000) });
    const [parked] = await managedSyncMovementEntry.run(ctx) as unknown as Array<Record<string, unknown>>;
    expect(parked).toMatchObject({ name: 'managed_sync_not_moving', status: 'ok', severity: 'info' });
    expect(String(parked!.message)).toContain(`${f.id} is parked at 1/9`);
    const lines: string[] = [];
    const watch = startMovementWatch(engine, { log: line => lines.push(line), everyMs: 3_600_000 });
    const lock = await tryAcquireDbLock(engine, syncLockId(f.id));
    try {
      const [warn] = await managedSyncMovementEntry.run(ctx) as unknown as Array<Record<string, unknown>>;
      expect(warn).toMatchObject({ name: 'managed_sync_not_moving', status: 'warn', readiness_state: 'degraded', details: { count: 1 } });
      expect(warn!.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.id, '--json'], actor: 'agent', consent: [] });
      await watch.tick(); await watch.tick();
      expect(lines.filter(line => line.startsWith('[gbrain notice managed_sync_not_moving kind=degraded]'))).toHaveLength(1);
      expect(lines[0]).toContain(`gbrain sources writer status --source ${f.id} --json`);
      await request(f, 'committed', { completedAt: ago(0) });
      await watch.tick();
      expect(lines[1]).toContain('moving again');
      const [ok] = await managedSyncMovementEntry.run(ctx) as unknown as Array<Record<string, unknown>>;
      expect(ok).toMatchObject({ status: 'ok' });
    } finally { watch.stop(); await lock!.release(); }
  }), 60_000);
});
