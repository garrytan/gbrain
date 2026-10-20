/**
 * #6712 PR 4b lane R (design v3.2 §3.7, probe 36): every reader that read the managed-sync cursor reads the pass row of a
 * non-company source. Fixtures on in-memory PGLite: one managed source per test (a claimed worktree over a real Git
 * checkout, so HEAD reads), its pass row written with `writePassRow`, and a pass that stops on every tick for an hour
 * simulated by writing the row once per five-minute tick and stamping `updated_at` back to that tick.
 *
 * Unhealthy (blocked, a not-converged streak, a settle-mismatch streak): the backlog lists it, movement is `not_moving`,
 * doctor `managed_sync_not_moving` and `git_held_files` warn, `gbrain sources writer movement` exits 1, the blocked
 * reader lists it, doctor `managed_sync_blocked` fails past the hour and get_brain_health's `sync_blocked` band counts it.
 * Healthy (converged at HEAD, ended `synced`): nothing pending anywhere; a commit past the converged target is pending
 * again. Also: the lease holder's progress is the pass row's write, `set-strategy` refuses during a drain lease or an
 * open episode, the checkpoint-blocker map lists what blocks an open pass's checkpoint, receipt compaction keeps an open
 * pass's receipts and the newest pass receipt, and the repair busy set adds nothing for an open pass (probe 53, busy side).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { withEnv } from './helpers/with-env.ts';
import { MANAGED_SYNC_PASS_OP, writePassRow, type ManagedSyncPassValue } from '../src/core/persistence/sync-pass-row.ts';
import { readManagedSyncBacklog } from '../src/core/persistence/sync-drain.ts';
import { readSourceMovement } from '../src/core/persistence/sync-movement.ts';
import { movementReport } from '../src/commands/sources-writer-movement.ts';
import { managedSyncMovementEntry } from '../src/commands/doctor/checks/managed-sync-movement.ts';
import { managedSyncBlockedEntry } from '../src/commands/doctor/checks/managed-sync-blocked.ts';
import { gitHeldFilesCheck } from '../src/commands/doctor/checks/git-holds.ts';
import { readBlockedManagedSyncs } from '../src/core/persistence/sync-blocked.ts';
import { readBrainHealthBands } from '../src/commands/doctor/brain-health-bands.ts';
import { readDrainHolder } from '../src/core/persistence/sync-lease.ts';
import { readCheckpointBlockerMap } from '../src/core/persistence/terminal-failures.ts';
import { compactReceipt, compactWriteReceiptsDetailed } from '../src/core/persistence/journal.ts';
import { loadRepairBusySet, repairBusy } from '../src/core/persistence/repair-busy.ts';
import { runSources } from '../src/commands/sources.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pass-readers-'));
let engine: BrainEngine;
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Fixture { id: string; root: string; worktreeId: string; incarnation: string }
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=alice-example', '-c', 'user.email=alice@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
function commit(root: string, file: string, body: string): string {
  writeFileSync(join(root, file), body);
  git(root, 'add', file);
  git(root, 'commit', '-q', '-m', `edit ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}
async function managedSource(): Promise<Fixture & { head: string }> {
  const id = `pr-${randomUUID().slice(0, 8)}`, root = join(home, id);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  const head = commit(root, 'note.md', '# Note\n');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const [row] = await engine.executeRaw<{ worktree_id: string; incarnation: string }>(
    'SELECT b.worktree_id::text AS worktree_id, b.source_incarnation::text AS incarnation FROM persistence_source_bindings b WHERE b.source_id=$1', [id]);
  return { id, root, worktreeId: row!.worktree_id, incarnation: row!.incarnation, head };
}

type PassShape = { outcome: ManagedSyncPassValue['telemetry']['outcome']; stop_reason?: string | null; converged?: string | null; not_converged_streak?: number;
  mismatch?: ManagedSyncPassValue['obligations']['mismatch']; remaining?: number; stuck_since?: string | null; pass_id?: string; target?: string;
  episode?: ManagedSyncPassValue['obligations']['episode']; ended_at?: string };
function passValue(f: Fixture, s: PassShape): ManagedSyncPassValue {
  const started = ago(2 * MIN);
  return { source_id: f.id, incarnation: f.incarnation, lease_token: randomUUID(),
    obligations: { baseline_commit: null, mismatch: s.mismatch ?? {}, not_converged_streak: s.not_converged_streak ?? 0, faults: {},
      ...(s.stuck_since !== undefined ? { stuck_since: s.stuck_since } : {}), ...(s.episode ? { episode: s.episode } : {}),
      ...(s.converged ? { converged: { target: s.converged, at: started, request_hwm: '0', open_at_stamp: [], parser_fp: 'fp', pack: null, selection_fp: 'sel', last_full_at: started, passes_since_full: 1 } } : {}) },
    telemetry: { pass_id: s.pass_id ?? randomUUID(), target: s.target ?? s.converged ?? 'HEAD', started_at: started, ended_at: s.outcome === 'open' ? null : s.ended_at ?? ago(MIN), kind: 'full', round: 4,
      outcome: s.outcome, stop_reason: s.stop_reason ?? null, candidates: 10, settled: 10 - (s.remaining ?? 0), remaining: s.remaining ?? 0, counts: {}, duration_ms: null, timings_ms: {} } };
}
async function writePass(f: Fixture, s: PassShape, updatedAt?: string): Promise<ManagedSyncPassValue> {
  const value = passValue(f, s);
  expect(await writePassRow(engine, value, { pin: true })).toBe(true);
  if (updatedAt) await engine.executeRaw('UPDATE op_checkpoints SET updated_at=$3::timestamptz WHERE op=$1 AND fingerprint=$2', [MANAGED_SYNC_PASS_OP, `${f.id}:${f.incarnation}`, updatedAt]);
  return value;
}
/**
 * A pass that ends `ending` on every five-minute tick for an hour (12 ticks); the newest row is five minutes old. It has been
 * stopping for 61 minutes: doctor `managed_sync_blocked` and the health band fail only past the hour (strictly longer than
 * MANAGED_SYNC_BLOCKED_FAIL_MS), so a `stuck_since` of exactly an hour would sit on the boundary.
 */
async function stuckForAnHour(f: Fixture & { head: string }, ending: 'blocked' | 'not_converged' | 'settle_mismatch'): Promise<void> {
  const stuckSince = ago(61 * MIN);
  for (let tick = 1; tick <= 12; tick++) {
    await writePass(f, { outcome: ending === 'blocked' ? 'blocked' : 'resumable', stop_reason: ending === 'blocked' ? 'reconcile_read_incomplete' : 'not_converged',
      not_converged_streak: ending === 'not_converged' ? tick : 0, remaining: 3, target: f.head, stuck_since: stuckSince,
      mismatch: ending === 'settle_mismatch' ? { 'notes/flaky.md': { level: 'abc', streak: Math.min(tick, 2) } } : {} }, ago((65 - tick * 5) * MIN));
  }
}
/** The same hour, from a gbrain that writes no `stuck_since`: one row, untouched for the hour. */
const stuckRowOnly = (f: Fixture & { head: string }) => writePass(f, { outcome: 'resumable', stop_reason: 'not_converged', not_converged_streak: 12, remaining: 3, target: f.head, ended_at: ago(61 * MIN) }, ago(61 * MIN));
const converged = (f: Fixture & { head: string }) => writePass(f, { outcome: 'synced', converged: f.head, target: f.head });
const forget = (f: Fixture) => engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [MANAGED_SYNC_PASS_OP, `${f.id}:${f.incarnation}`]);
const one = async (f: Fixture) => (await readSourceMovement(engine, { sourceIds: [f.id] }))[0]!;
const ctx = () => ({ engine }) as unknown as Parameters<typeof managedSyncMovementEntry.run>[0];
const doctorMovement = async (f: Fixture) => {
  const [check] = await managedSyncMovementEntry.run(ctx()) as unknown as Array<{ status: string; message: string; details: { sources: Array<{ source_id: string }> } }>;
  return { status: check!.status, mine: check!.details.sources.some(s => s.source_id === f.id), message: check!.message };
};

let requestSeq = 0;
async function request(f: Fixture, state: 'committed' | 'running' | 'queued', intent: Record<string, unknown>, completedAt?: string): Promise<string> {
  const requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,digest,authority,intent,intent_bytes,terminal_reservation,state,completed_at)
    VALUES('local_cli','cli:example',$1::uuid,'submit_job',$2,$3::uuid,$4,$5::uuid,'d','{}'::jsonb,$6::text::jsonb,1,16384,$7,$8::timestamptz)`,
  [requestId, f.id, f.incarnation, `notes/r${++requestSeq}`, f.worktreeId, JSON.stringify(intent), state, completedAt ?? null]);
  return requestId;
}
const compacted = async (requestId: string) => (await engine.executeRaw<{ compacted: boolean }>('SELECT compacted FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]!.compacted;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite;
  for (const [key, value] of [['persistence.sync_preparation_ms', '1000'], ['persistence.maintenance_preparation_ms', '1000'], ['persistence.preparation_ceiling_ms', '60000']]) {
    await engine.executeRaw('INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

/** Each §3.7 health reader, asserting it reads the source unhealthy. */
const UNHEALTHY: Array<[string, (f: Fixture, ending: string) => Promise<void>]> = [
  ['backlog (readManagedSyncBacklog)', async (f, ending) => {
    const [backlog] = await readManagedSyncBacklog(engine, [f.id]);
    expect(backlog).toMatchObject({ source_id: f.id, remaining: 3, pass: { stuck: ending } });
  }],
  ['movement (readSourceMovement)', async (f, ending) => {
    expect(await one(f)).toMatchObject({ movement_state: 'not_moving', data_moving: false, cursor: null, pass: { stuck: ending } });
  }],
  ['sources writer movement', async f => {
    const after = await one(f);
    expect(movementReport(after, after, 60_000)).toMatchObject({ state: 'not_moving', exit: 1, code: 'managed_sync_not_moving' });
  }],
  ['doctor managed_sync_not_moving', async f => {
    expect(await doctorMovement(f)).toMatchObject({ status: 'warn', mine: true });
  }],
  ['doctor git_held_files', async (f, ending) => {
    const held = await gitHeldFilesCheck(engine, [f.id]);
    expect(held.status).toBe('warn');
    expect((held.details as { passes?: Array<{ source_id: string; reason: string }> }).passes).toEqual([expect.objectContaining({ source_id: f.id, reason: ending })]);
  }],
  ['sync-blocked (readBlockedManagedSyncs)', async f => {
    const [blocked] = await readBlockedManagedSyncs(engine, [f.id]);
    expect(blocked).toMatchObject({ source_id: f.id });
    expect(Date.now() - Date.parse(blocked!.blocked_since)).toBeGreaterThanOrEqual(60 * MIN);
  }],
  ['doctor managed_sync_blocked', async f => {
    const [check] = await managedSyncBlockedEntry.run(ctx()) as unknown as Array<{ status: string; details?: { sources: Array<{ source_id: string }> } }>;
    expect(check!.status).toBe('fail');
    expect(check!.details?.sources.map(s => s.source_id)).toContain(f.id);
  }],
  ['get_brain_health sync_blocked band', async f => {
    expect((await readBrainHealthBands(engine, { sourceIds: [f.id] })).sync_blocked.band).toBe('1-9');
  }],
];

describe('probe 36: a pass that keeps stopping reads unhealthy on every reader', () => {
  for (const ending of ['blocked', 'not_converged', 'settle_mismatch'] as const) {
    for (const [reader, assertUnhealthy] of UNHEALTHY) {
      test(`${ending} on every tick for an hour: ${reader}`, () => withEnv({ GBRAIN_HOME: home }, async () => {
        const f = await managedSource();
        try {
          await stuckForAnHour(f, ending);
          await assertUnhealthy(f, ending);
        } finally { await forget(f); }
      }), 60_000);
    }
  }

  test('a not-converged row nobody touched for an hour (no stuck_since) also reads unhealthy and past the hour', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    try {
      await stuckRowOnly(f);
      expect((await one(f)).movement_state).toBe('not_moving');
      const [blocked] = await readBlockedManagedSyncs(engine, [f.id]);
      expect(Date.now() - Date.parse(blocked!.blocked_since)).toBeGreaterThanOrEqual(60 * MIN);
      expect((await readBrainHealthBands(engine, { sourceIds: [f.id] })).sync_blocked.band).toBe('1-9');
    } finally { await forget(f); }
  }), 60_000);

  test('converged at HEAD and ended synced reads healthy everywhere', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    try {
      await converged(f);
      expect(await readManagedSyncBacklog(engine, [f.id])).toEqual([]);
      const healthy = await one(f);
      expect(healthy).toMatchObject({ movement_state: 'nothing_pending', cursor: null });
      expect(movementReport(healthy, healthy, 60_000)).toMatchObject({ state: 'nothing_pending', exit: 0 });
      expect(await doctorMovement(f)).toMatchObject({ mine: false });
      expect((await gitHeldFilesCheck(engine, [f.id])).status).toBe('ok');
      expect(await readBlockedManagedSyncs(engine, [f.id])).toEqual([]);
      expect((await readBrainHealthBands(engine, { sourceIds: [f.id] })).sync_blocked.band).toBe('none');
    } finally { await forget(f); }
  }), 60_000);

  test('a commit past the converged target makes the source pending again, not stuck', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    try {
      await converged(f);
      const next = commit(f.root, 'later.md', '# Later\n');
      const [behind] = await readManagedSyncBacklog(engine, [f.id]);
      expect(behind).toMatchObject({ source_id: f.id, pass: { head: next, converged_target: f.head, stuck: null } });
      expect((await one(f)).movement_state).toBe('parked');
      expect(await readBlockedManagedSyncs(engine, [f.id])).toEqual([]);
    } finally { await forget(f); }
  }), 60_000);
});

describe('the other cursor readers', () => {
  test("the drain holder's progress is the pass row's newest write", () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    const lock = await tryAcquireDbLock(engine, syncLockId(f.id));
    try {
      expect(lock).not.toBeNull();
      await writePass(f, { outcome: 'open', remaining: 5, target: f.head }, ago(2 * MIN));
      const holder = await readDrainHolder(engine, f.id);
      expect(holder?.progress?.last_progress_at).not.toBeNull();
      expect(Math.abs(Date.parse(holder!.progress!.last_progress_at!) - (Date.now() - 2 * MIN))).toBeLessThan(MIN);
    } finally { await lock?.release(); await forget(f); }
  }), 60_000);

  test('set-strategy refuses during a drain lease and during an open episode, and allows it after', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    const cli = async (args: string[]) => {
      const err: string[] = [];
      const seen: { exit: number | null } = { exit: null };
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { seen.exit = code ?? 0; throw new Error('EXIT'); }) as never);
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.map(String).join(' ')); });
      try { await runSources(engine, args); } catch (error) { if (!(error instanceof Error && error.message === 'EXIT')) throw error; }
      finally { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); }
      return { exit: seen.exit, err: err.join('\n') };
    };
    const strategy = async () => (await engine.executeRaw<{ strategy: string | null }>("SELECT config->>'strategy' AS strategy FROM sources WHERE id=$1", [f.id]))[0]!.strategy;
    try {
      const lock = await tryAcquireDbLock(engine, syncLockId(f.id));
      try {
        const leased = await cli(['set-strategy', f.id, 'code']);
        expect(leased.exit).toBe(1);
        expect(leased.err).toContain('sync_run_unfinished');
        expect(await strategy()).toBeNull();
      } finally { await lock?.release(); }
      await writePass(f, { outcome: 'resumable', target: f.head, remaining: 4,
        episode: { opened_at: ago(MIN), full_id: randomUUID(), selection: { exclude: [], includeHidden: [], strategy: null, srcSubpath: null, mode: 'committed' }, inherited: { noEmbed: false, noExtract: false, noSchemaPack: false, from: 'flag' } } });
      const episode = await cli(['set-strategy', f.id, 'code']);
      expect(episode.exit).toBe(1);
      expect(episode.err).toContain('sync_run_unfinished');
      expect(episode.err).toContain(`gbrain sync --source ${f.id} --no-pull`);
      expect(await strategy()).toBeNull();
      await converged(f);
      expect((await cli(['set-strategy', f.id, 'code'])).exit).toBeNull();
      expect(await strategy()).toBe('code');
    } finally { await forget(f); }
  }), 60_000);

  test("an open pass's admitted checkpoint lists what blocks it", () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    try {
      const pass = await writePass(f, { outcome: 'open', remaining: 0, target: f.head });
      const page = await request(f, 'running', { kind: 'managed_sync_import', passId: pass.telemetry.pass_id, path: 'note.md', slug: 'note' });
      await request(f, 'queued', { kind: 'managed_sync_checkpoint', passId: pass.telemetry.pass_id });
      const map = await readCheckpointBlockerMap(engine, [f.id]);
      expect(map.get(f.id)).toEqual([expect.objectContaining({ request_id: page, state: 'running', recovery: false, knock_on: false })]);
      await engine.executeRaw("UPDATE persistence_requests SET state='committed', completed_at=now() WHERE source_id=$1", [f.id]);
      expect((await readCheckpointBlockerMap(engine, [f.id])).has(f.id)).toBe(false);
    } finally { await forget(f); }
  }), 60_000);

  test("compaction keeps an open pass's receipts and the newest pass receipt of the worktree", () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    try {
      const pass = await writePass(f, { outcome: 'open', remaining: 2, target: f.head });
      const inPass = await request(f, 'committed', { kind: 'managed_sync_import', passId: pass.telemetry.pass_id, path: 'note.md' }, ago(3 * MIN));
      const newest = await request(f, 'committed', { kind: 'managed_sync_import', passId: randomUUID(), path: 'later.md' }, ago(2 * MIN));
      await compactWriteReceiptsDetailed(engine, 0);
      expect(await compacted(inPass)).toBe(false);
      expect(await compacted(newest)).toBe(false);
      const [row] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id, principal_kind, principal_id FROM persistence_requests WHERE request_id=$1::uuid', [inPass]);
      expect(await compactReceipt(engine, row as never)).toEqual({ skipped: 'open_sync_pass' });
      await writePass(f, { outcome: 'synced', converged: f.head, pass_id: pass.telemetry.pass_id });
      await compactWriteReceiptsDetailed(engine, 0);
      expect(await compacted(inPass)).toBe(true);
      expect(await compacted(newest)).toBe(false);
    } finally { await forget(f); }
  }), 60_000);

  test('probe 53 (busy side): an open pass with no open request makes no repair candidate busy', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedSource();
    try {
      await writePass(f, { outcome: 'open', remaining: 3, target: f.head });
      const busy = await loadRepairBusySet(engine, f.id, f.incarnation);
      expect(busy.unknown).toBeNull();
      expect(repairBusy(busy, { path: 'note.md', slug: 'note' })).toBe(false);
    } finally { await forget(f); }
  }), 60_000);
});
