/**
 * #7679: an orphaned `gbrain sources refresh` (its process killed while the row
 * is `syncing`, for example a container replaced mid-refresh) recovers without
 * an operator, and a live refresh is never stolen.
 *
 * Protects: the next plain refresh finishes an orphaned refresh through the
 * `--resume` path, then refreshes; owner recovery completes an orphaned
 * `syncing` row once its members synced to the target or a descendant of it;
 * writer status and sync status name the recorded holder, whether it is
 * orphaned, and a fix naming `--resume`.
 * Regression it catches: every scheduled refresh refusing `refresh_in_progress`
 * forever after a crash (and every page write to the worktree refusing
 * `worktree_refreshing`), owner recovery skipping `syncing` rows, status that
 * cannot tell a live refresh from an orphan, and recovery adopting a refresh
 * whose process still holds the refresh lock or whose holder is on another host.
 * Seams: a real child process SIGKILLs itself at the refresh's `syncing`
 * boundary; the live holder is a refresh paused at that boundary in this
 * process (the native lock is per open file, so this process cannot take it).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { printRefreshOutcome, runSourcesRefresh } from '../src/commands/sources-refresh.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { commitFile, git, page, setupRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-orphan-'));
const cases: Array<{ engine: BrainEngine; database: GBrainConfig; close: () => Promise<void> }> = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const database = { engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig;
    const engine = new PGLiteEngine();
    await engine.connect(database); await engine.initSchema();
    cases.push({ engine, database, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    cases.push({ engine: pg.engine, database: { engine: 'postgres', database_url: pg.databaseUrl } as GBrainConfig, close: pg.close });
  }
}, 120_000);
afterAll(async () => {
  for (const item of cases) { await disposePersistenceConsumer(item.engine); await item.close(); }
  rmSync(dir, { recursive: true, force: true });
});

type Case = typeof cases[number];
type Row = { id: string; state: string; outcome: Record<string, any> };
const refusedWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, e => e as { code?: string; message?: string; suggestion?: string });
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};
const writerRefreshes = async (f: RefreshFixture, sourceId: string) =>
  (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: sourceId }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes;

/** A fixture whose refresh process was SIGKILLed at `syncing`: HEAD is at `target`, the members still at `old`. Runs `fn` with GBRAIN_HOME set. */
async function withKilledRefresh(item: Case, fn: (k: { f: RefreshFixture; target: string; old: string; pid: number; orphan: Row }) => Promise<void>): Promise<void> {
  const caseDir = mkdtempSync(join(dir, 'case-'));
  const home = join(caseDir, 'home');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await setupRefreshFixture(item.engine, caseDir);
    await disposePersistenceConsumer(item.engine);
    const old = f.head();
    const target = f.push('alpha/two.md', page('Alpha two', 'An observation whose refresh was killed.'));
    if (item.engine.kind === 'pglite') await item.engine.disconnect();
    const run = spawnSync(process.execPath, [join(import.meta.dir, 'helpers/worktree-refresh-child.ts')], { encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, GBRAIN_HOME: home, GBRAIN_TEST_REFRESH_CHILD: JSON.stringify({ database: item.database, sourceId: f.alpha, worktreeId: f.worktreeId, mode: 'kill-syncing' }) } });
    if (item.engine.kind === 'pglite') await item.engine.connect(item.database);
    const line = run.stdout.split('\n').find(row => row.startsWith('REFRESH_KILLED_IN_SYNCING '));
    expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
    expect(run.signal).toBe('SIGKILL');
    const pid = Number(line!.split(' ')[1]);
    const rows = await f.refreshRows() as Row[];
    expect(rows.map(row => row.state)).toEqual(['syncing']);
    expect(rows[0].outcome.holder).toMatchObject({ pid });
    expect(f.head()).toBe(target);
    expect(await f.lastCommit(f.alpha)).toBe(old);
    try { await fn({ f, target, old, pid, orphan: rows[0] }); }
    finally { await disposePersistenceConsumer(item.engine); rmSync(caseDir, { recursive: true, force: true }); }
  });
}

test('#7679: a refresh killed mid-syncing is reported orphaned with its holder, and the next scheduled refresh finishes it, then refreshes', async () => {
  for (const item of cases) await withKilledRefresh(item, async ({ f, target, pid, orphan }) => {
    const resume = ['gbrain', 'sources', 'refresh', f.alpha, '--resume'];
    const [status] = await writerRefreshes(f, f.beta);
    expect(status).toMatchObject({ refresh_id: orphan.id, state: 'syncing', liveness: 'orphaned', orphaned: true, auto_recovery: 'next_refresh',
      holder: { pid }, fix: { argv: resume, actor: 'agent' }, next: resume.join(' ') });
    const sync = await readSyncStatus(f.engine, f.beta, { detail: false });
    expect(sync.worktree_refresh).toMatchObject({ refresh_id: orphan.id, state: 'syncing', orphaned: true, holder: { pid } });
    expect(sync.next?.argv).toEqual(resume);
    // The wedge: every page write to the worktree is refused while the orphan stands.
    await refusedWith(f.put(f.beta, 'notes/while-orphaned', page('While orphaned', 'refused')), 'worktree_refreshing');

    // Ship audit. Value: protects=a --dry-run reports the orphan and writes nothing (no adoption, holder unchanged); fails_when=the dryRun guard on
    // adoption is dropped; why_new=no dry run ran against an orphan; seam=none; no_claim=none beyond protects.
    await refusedWith(refreshWorktree(f.engine, f.alpha, { dryRun: true }), 'refresh_in_progress');
    expect((await f.refreshRows() as Row[]).map(row => [row.state, row.outcome.holder?.pid, row.outcome.previous_holder])).toEqual([['syncing', pid, undefined]]);

    const next = f.push('alpha/three.md', page('Alpha three', 'Landed upstream while the refresh was orphaned.'));
    const result = await refreshWorktree(f.engine, f.alpha);
    expect(result).toMatchObject({ status: 'completed', old_head: target, target_head: next,
      recovered: { refresh_id: orphan.id, state: 'completed', status: 'completed', previous_holder: { pid } } });
    const rows = await f.refreshRows() as Row[];
    expect(rows.map(row => row.state)).toEqual(['completed', 'completed']);
    expect(rows[0].outcome.previous_holder).toMatchObject({ pid });
    expect(rows[0].outcome.holder.pid).toBe(process.pid);
    expect(f.head()).toBe(next);
    expect(await f.lastCommit(f.alpha)).toBe(next);
    expect(await f.lastCommit(f.beta)).toBe(next);
    expect(await writerRefreshes(f, f.beta)).toEqual([]);
    expect((await readSyncStatus(f.engine, f.beta, { detail: false })).worktree_refresh).toBeNull();
    expect((await f.put(f.beta, 'notes/after-recovery', page('After', 'admitted'))).state ?? 'committed').toBe('committed');
  });
}, 300_000);

test('#7679: owner recovery completes an orphaned syncing refresh once every member synced past its target, and leaves one whose members lag', async () => {
  for (const item of cases) await withKilledRefresh(item, async ({ f, target, orphan }) => {
    expect(await resumeWorktreeRefreshes(f.engine)).toBe(0);
    expect((await f.refreshRows()).map(row => row.state)).toEqual(['syncing']);
    // An agent commits on top of the target and cycle syncs catch both members up to that descendant.
    const descendant = commitFile(f.root, 'beta/local.md', page('Local', 'Committed on top of the refresh target.'));
    for (const id of [f.alpha, f.beta]) await performManagedSync(f.engine, { sourceId: id, noPull: true, noEmbed: true });
    expect(git(f.root, 'merge-base', '--is-ancestor', target, descendant)).toBe('');
    expect(await f.lastCommit(f.alpha)).toBe(descendant);
    expect(await f.lastCommit(f.beta)).toBe(descendant);
    // The owner scan (the consumer the syncs started runs it too) completes the orphan; nothing else does.
    const deadline = Date.now() + 20_000;
    while ((await f.refreshRows())[0].state === 'syncing' && Date.now() < deadline) await resumeWorktreeRefreshes(f.engine);
    const [row] = await f.refreshRows() as Row[];
    expect(row).toMatchObject({ id: orphan.id, state: 'completed', outcome: { completed_by: 'owner_recovery' } });
    expect((await f.put(f.alpha, 'notes/after-recovery', page('After', 'admitted'))).state ?? 'committed').toBe('committed');
  });
}, 300_000);

test('#7679: a live refresh is never stolen: owner recovery, a plain refresh and --resume leave it to its holder, and status reports it live', async () => {
  for (const item of cases) {
    const caseDir = mkdtempSync(join(dir, 'live-'));
    await withEnv({ GBRAIN_HOME: join(caseDir, 'home') }, async () => {
      const f = await setupRefreshFixture(item.engine, caseDir);
      try {
        const target = f.push('alpha/two.md', page('Alpha two', 'Upstream while a refresh is live.'));
        let reached!: () => void, release!: () => void;
        const atSyncing = new Promise<void>(resolve => { reached = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const live = refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => { if (point === 'syncing') { reached(); await gate; } } } });
        await atSyncing;
        try {
          const [held] = await f.refreshRows() as Row[];
          expect(held.state).toBe('syncing');
          // Both members caught up while the holder is paused: still not the owner scan's to complete.
          for (const id of [f.alpha, f.beta]) await performManagedSync(f.engine, { sourceId: id, noPull: true, noEmbed: true });
          expect(await f.lastCommit(f.alpha)).toBe(target);
          expect(await resumeWorktreeRefreshes(f.engine)).toBe(0);
          const refused = await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_in_progress');
          expect(refused.message).toContain(`pid ${process.pid}`);
          await refusedWith(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_in_progress');
          // #7685: the --json refusal carries the structured fix: the writer status read that reports the holder's liveness.
          const printed: string[] = [];
          const log = console.log;
          console.log = (line: string) => { printed.push(line); };
          try { await runSourcesRefresh(f.engine, [f.alpha, '--json']); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = 0; }
          expect(JSON.parse(printed.join('\n'))).toMatchObject({ status: 'refused', code: 'refresh_in_progress',
            fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.alpha, '--json'], next: 'run', actor: 'agent' } });
          const [row] = await f.refreshRows() as Row[];
          expect(row).toMatchObject({ id: held.id, state: 'syncing' });
          expect(row.outcome.holder).toEqual(held.outcome.holder);
          expect(row.outcome.previous_holder).toBeUndefined();
          const [status] = await writerRefreshes(f, f.alpha);
          expect(status).toMatchObject({ refresh_id: held.id, liveness: 'live', orphaned: false, auto_recovery: 'none', fix: null, holder: { pid: process.pid } });
          expect(status.next).toContain('Wait for it');
          const sync = await readSyncStatus(f.engine, f.alpha, { detail: false });
          expect(sync.worktree_refresh).toMatchObject({ liveness: 'live', orphaned: false });
          expect(sync.next?.argv ?? []).not.toContain('--resume');
        } finally { release(); }
        expect(await live).toMatchObject({ status: 'completed', target_head: target });
        expect((await f.refreshRows()).map(row => row.state)).toEqual(['completed']);
      } finally { await disposePersistenceConsumer(item.engine); }
    });
    rmSync(caseDir, { recursive: true, force: true });
  }
}, 300_000);

test('#7679: an orphan written before holders were recorded is reported orphaned on the owner host, and the next plain refresh adopts it', async () => {
  // Ship audit. Value: protects=a refresh row with no outcome.holder (left by a binary older than #7679) is still adopted and reported orphaned;
  // fails_when=adoption or the holder report requires a recorded holder, so the upgrade-era orphan stays wedged; why_new=every #7679 test row
  // carries a holder; seam=none; no_claim=a row written by an actual older binary (the holder is removed with SQL).
  for (const item of cases) await withKilledRefresh(item, async ({ f, target, orphan }) => {
    await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=outcome-'holder' WHERE id=$1::uuid`, [orphan.id]);
    const [status] = await writerRefreshes(f, f.alpha);
    expect(status).toMatchObject({ refresh_id: orphan.id, holder: null, liveness: 'orphaned', orphaned: true, auto_recovery: 'next_refresh',
      fix: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'] } });
    expect(status.fix.why).toContain('a process that recorded no holder');
    const result = await refreshWorktree(f.engine, f.alpha);
    expect(result).toMatchObject({ status: 'already_current', recovered: { refresh_id: orphan.id, state: 'completed', status: 'completed', previous_holder: null } });
    // Ship review: text mode (the cron default) reports the recovery too. Value: protects=a plain refresh's text output names the orphan it
    // recovered; fails_when=describe drops the recovered field; why_new=only --json read it; seam=none; no_claim=none beyond protects.
    const out: string[] = [];
    const log = console.log;
    console.log = (line: string) => { out.push(line); };
    try { printRefreshOutcome({ result }, false); } finally { console.log = log; }
    expect(out.join('\n')).toContain(`Recovered orphaned refresh ${orphan.id} (completed; previous holder: not recorded).`);
    const rows = await f.refreshRows() as Row[];
    expect(rows.map(row => row.state)).toEqual(['completed']);
    expect(rows[0].outcome.holder.pid).toBe(process.pid);
    expect(await f.lastCommit(f.alpha)).toBe(target);
    expect(await f.lastCommit(f.beta)).toBe(target);
  });
}, 300_000);

test('#7679: an orphan whose recorded holder is on another host is reported unknown and is not adopted by a plain refresh; --resume on the owner finishes it', async () => {
  for (const item of cases) await withKilledRefresh(item, async ({ f, target, orphan }) => {
    const elsewhere = randomUUID();
    await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=jsonb_set(outcome,'{holder,host_id}',to_jsonb($2::text)) WHERE id=$1::uuid`, [orphan.id, elsewhere]);
    const [status] = await writerRefreshes(f, f.alpha);
    expect(status).toMatchObject({ liveness: 'unknown', orphaned: null, auto_recovery: 'unknown', fix: { actor: 'host_admin' } });
    expect(status.fix.why).toContain(elsewhere);
    expect(status.fix.why).toContain('--resume');
    const sync = await readSyncStatus(f.engine, f.alpha, { detail: false });
    expect(sync.worktree_refresh).toMatchObject({ refresh_id: orphan.id, liveness: 'unknown', orphaned: null });
    expect(sync.next).toMatchObject({ actor: 'host_admin', argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.alpha, '--json'] });
    await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_in_progress');
    expect((await f.refreshRows()).map(row => row.state)).toEqual(['syncing']);
    expect(await refreshWorktree(f.engine, f.alpha, { resume: true })).toMatchObject({ status: 'completed', refresh_id: orphan.id, target_head: target });
  });
}, 300_000);

test('#7679: a plain refresh that cannot read the checkout HEAD leaves an orphaned syncing refresh as it is, and the next one adopts it', async () => {
  // Ship audit (adversarial #1). Value: protects=an unattended plain refresh never escalates an orphan to recovery_required on a transient
  // HEAD read failure (that state's advice resets the checkout behind members that already synced); fails_when=adoption runs recovery with an
  // unreadable HEAD; why_new=no test read HEAD as unreadable during adoption; seam=.git/HEAD overwritten with garbage; no_claim=the recoverOne
  // guard for a HEAD lost between adoption's read and recovery's read (a race window this test does not open).
  for (const item of cases) await withKilledRefresh(item, async ({ f, target, orphan }) => {
    const headFile = join(f.root, '.git', 'HEAD');
    const saved = readFileSync(headFile, 'utf8');
    writeFileSync(headFile, 'not a ref\n');
    try {
      await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_in_progress');
      expect((await f.refreshRows() as Row[]).map(row => [row.state, row.outcome.previous_holder])).toEqual([['syncing', undefined]]);
    } finally { writeFileSync(headFile, saved); }
    expect(await refreshWorktree(f.engine, f.alpha)).toMatchObject({ recovered: { refresh_id: orphan.id, state: 'completed', status: 'completed' } });
    expect(await f.lastCommit(f.alpha)).toBe(target);
  });
}, 300_000);
