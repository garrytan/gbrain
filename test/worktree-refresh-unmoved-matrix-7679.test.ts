/**
 * #7679 state matrix 7d of `gbrain sources refresh`: an interrupted refresh that the unattended paths cannot verify, or
 * that a live or remote holder owns, is never moved. Split from persistence-worktree-refresh.test.ts with 7c
 * (worktree-refresh-settle-matrix-7679.test.ts) so each Postgres file fits run-e2e.sh's per-file cap (#8025). Postgres runs
 * through test/e2e/worktree-refresh-unmoved-matrix-postgres.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { refreshLockPath, refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { git, page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

const refusedWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(() => null, e => e as { code?: string; suggestion?: string; message?: string; docs?: string });
  expect(error, `expected refusal ${code}`).not.toBeNull();
  expect(error!.code).toBe(code);
  return error!;
};

test('7d. #7679 state matrix: an interrupted refresh that the unattended paths cannot verify, or that a live or remote holder owns, is never moved', async () => {
  // Value: protects=a plain refresh leaves an orphan untouched (state, holder, previous_holder, HEAD) when git cannot read HEAD (refusing
  // refresh_in_progress), when publication/topology recovery is pending or the worktree is not active (refusing refresh_recovery_required, the
  // blocker that must clear first), when a live process holds the refresh lock, or when its holder is on another host; the owner scan aborts a dead
  // drain whatever HEAD reads and leaves every other kind on an unreadable HEAD; fails_when=adoption runs recovery on a null HEAD, ahead of the
  // recovery gate, against a live lock or another host's holder, or the scan escalates an unreadable HEAD; why_new=7c covers readable HEADs with
  // free locks and no pending recovery only; seam=.git/HEAD overwritten with garbage, a recovering topology change row, the worktree state column,
  // the refresh lock held in this process, a foreign holder host id; no_claim=the race where HEAD becomes unreadable between adoption's two reads.
  type Kind = 'draining' | 'fenced_old' | 'fenced_target' | 'merged_target' | 'syncing_lagging' | 'syncing_at_target' | 'recovery_required';
  type Action = 'plain_head_unreadable' | 'scan_head_unreadable' | 'plain_recovery_pending' | 'plain_worktree_inactive' | 'live_holder' | 'other_host_holder';
  const kinds: Kind[] = ['draining', 'fenced_old', 'fenced_target', 'merged_target', 'syncing_lagging', 'syncing_at_target', 'recovery_required'];
  // The scan aborts a dead drain, so scan_head_unreadable runs last.
  const actions: Action[] = ['plain_head_unreadable', 'plain_recovery_pending', 'plain_worktree_inactive', 'live_holder', 'other_host_holder', 'scan_head_unreadable'];
  const stateOf = (kind: Kind) => kind === 'recovery_required' ? 'recovery_required' : kind.split('_')[0];
  const crashAt = (kind: Kind) => kind === 'draining' ? 'drained' : kind.startsWith('syncing') ? 'syncing' : 'fenced';
  // Test cost (#7782): each kind builds one brain and one interrupted refresh, and every action runs on it in turn. No action but the last may move
  // the refresh, so each one undoes its seam and hands the next action the journal, HEAD and worktree it started with.
  for (const engine of engines) for (const kind of kinds) await withRefreshFixture(engine, async f => {
    const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
    await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === crashAt(kind)) throw new Error(`simulated crash at ${point}`); } } }))
      .rejects.toThrow('simulated crash');
    await disposePersistenceConsumer(f.engine);
    const [orphan] = await f.refreshRows();
    const state = stateOf(kind);
    await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state=$2,completed_at=NULL WHERE id=$1::uuid`, [orphan.id, state]);
    if (kind === 'fenced_target' || kind === 'merged_target') git(f.root, 'merge', '-q', '--ff-only', target);
    if (kind === 'syncing_at_target') for (const member of [f.alpha, f.beta]) await f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
      () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, target]), TEST_WRITE_ATTRIBUTION));
    const head = f.head();
    const settled = async () => (await f.refreshRows()).map(r => [r.state, (r.outcome.holder as { pid?: number } | undefined)?.pid, r.outcome.previous_holder]);
    const before = await settled();
    const plainCode = kind === 'recovery_required' ? 'refresh_recovery_required' : 'refresh_in_progress';
    const writerStatus = async () => (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.alpha }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes[0];
    const journal = async () => JSON.stringify(await f.refreshRows());
    const worktree = async () => (await f.engine.executeRaw<{ state: string; topology: number }>(`SELECT state,(SELECT count(*)::int FROM persistence_topology_changes
      WHERE $1::uuid = ANY(worktree_ids)) AS topology FROM persistence_worktrees WHERE id=$1::uuid`, [f.worktreeId]))[0];
    const pristine = { journal: await journal(), worktree: await worktree() };
    for (const action of actions) {
      const label = `${kind} x ${action}`;
      if (action === 'plain_recovery_pending' || action === 'plain_worktree_inactive') {
        const topologyRequest = randomUUID();
        if (action === 'plain_recovery_pending') await f.engine.executeRaw(`INSERT INTO persistence_topology_changes(principal_id,request_id,digest,operation,source_id,worktree_ids,state,recovery)
          VALUES($1::uuid,$2::uuid,'example','reclone',$3,ARRAY[$4::uuid],'recovering',$5::text::jsonb)`,
          [randomUUID(), topologyRequest, f.alpha, f.worktreeId, JSON.stringify({ worktreeId: f.worktreeId })]);
        else await f.engine.executeRaw(`UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid`, [f.worktreeId]);
        await refusedWith(refreshWorktree(f.engine, f.alpha), 'refresh_recovery_required');
        // Status does not promise that the next refresh finishes an orphan the recovery gate holds back.
        if (kind !== 'recovery_required') expect(await writerStatus(), label).toMatchObject({ liveness: 'orphaned', auto_recovery: 'none',
          fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', f.alpha, '--json'] } });
        if (action === 'plain_recovery_pending') await f.engine.executeRaw('DELETE FROM persistence_topology_changes WHERE request_id=$1::uuid', [topologyRequest]);
        else await f.engine.executeRaw('UPDATE persistence_worktrees SET state=$2 WHERE id=$1::uuid', [f.worktreeId, pristine.worktree.state]);
      } else if (action === 'live_holder') {
        const lock = await tryAcquireNativeLock(refreshLockPath(f.worktreeId));
        expect(lock, label).not.toBeNull();
        try {
          expect(await resumeWorktreeRefreshes(f.engine), label).toBe(0);
          await refusedWith(refreshWorktree(f.engine, f.alpha), plainCode);
          await refusedWith(refreshWorktree(f.engine, f.alpha, { resume: true }), 'refresh_in_progress');
          expect(await writerStatus(), label).toMatchObject({ liveness: 'live', auto_recovery: 'none' });
        } finally { await lock!.release(); }
      } else if (action === 'other_host_holder') {
        const [{ outcome }] = await f.refreshRows();
        const foreignHost = randomUUID();
        await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome=jsonb_set(outcome,'{holder,host_id}',to_jsonb($2::text)) WHERE id=$1::uuid`, [orphan.id, foreignHost]);
        await refusedWith(refreshWorktree(f.engine, f.alpha), plainCode);
        // #7731: next names the host the command must run on.
        if (kind !== 'recovery_required') expect(await writerStatus(), label).toMatchObject({ liveness: 'unknown', auto_recovery: 'unknown', fix: { actor: 'host_admin' },
          next: `On host ${hostname()} (${foreignHost}), which holds the refresh lock: gbrain sources writer status --source ${f.alpha} --json` });
        await f.engine.executeRaw('UPDATE persistence_worktree_refreshes SET outcome=$2::text::jsonb WHERE id=$1::uuid', [orphan.id, JSON.stringify(outcome)]);
      } else {
        const headFile = join(f.root, '.git', 'HEAD');
        const saved = readFileSync(headFile, 'utf8');
        writeFileSync(headFile, 'not a ref\n');
        try {
          if (action === 'plain_head_unreadable') {
            const refused = await refusedWith(refreshWorktree(f.engine, f.alpha), plainCode);
            if (kind !== 'recovery_required') expect(refused.suggestion, label).toContain(`gbrain sources writer status --source ${f.alpha} --json`);
          } else {
            // The scan aborts a dead drain (it does not depend on HEAD) and leaves every other kind for a scan that can read HEAD.
            expect(await resumeWorktreeRefreshes(f.engine), label).toBe(kind === 'draining' ? 1 : 0);
            expect((await f.refreshRows()).map(r => r.state), label).toEqual([kind === 'draining' ? 'aborted' : state]);
          }
        } finally { writeFileSync(headFile, saved); }
        if (action === 'scan_head_unreadable') { expect(f.head(), label).toBe(head); continue; }
      }
      expect(await settled(), label).toEqual(before);
      expect(f.head(), label).toBe(head);
      await disposePersistenceConsumer(f.engine);
      expect({ journal: await journal(), worktree: await worktree() }, `${label}: handoff`).toEqual(pristine);
    }
  });
}, 900_000);
