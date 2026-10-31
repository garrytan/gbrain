/**
 * #7679 state matrix 7c of `gbrain sources refresh`: an interrupted refresh row of each kind, settled by the owner scan, a
 * plain refresh and --resume. Split from persistence-worktree-refresh.test.ts with 7d
 * (worktree-refresh-unmoved-matrix-7679.test.ts) so each Postgres file fits run-e2e.sh's per-file cap (#8025). Postgres runs
 * through test/e2e/worktree-refresh-settle-matrix-postgres.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { refreshWorktree, resumeWorktreeRefreshes } from '../src/core/persistence/worktree-refresh.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { commitFile, git, page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

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

test('7c. #7679 state matrix: an interrupted refresh of each kind, settled by the owner scan, a plain refresh, --resume and --abandon', async () => {
  // Value: protects=each kind of interrupted refresh row leaves the row section 1.5 names when the owner scan, a plain refresh (adoption) or
  // --resume (resumeHeld) settles it; fails_when=a kind falls through to a sibling's path (an unverified HEAD adopted as the target, a syncing
  // row with an unrelated HEAD completed or refreshed over, a dead drain left standing); why_new=the #7679 tests cover syncing orphans with HEAD at
  // the target only; seam=none; no_claim=a real process death (the crash is a hook throw; the refresh lock is released as on exit).
  // #7718-#7727, #7729: --abandon rolls back only a row whose checkout never moved (a dead drain, a fence at the start commit) and admits writes
  // again; a row whose HEAD reached the target refuses refresh_in_progress and stays as it is, and an unrelated HEAD escalates to
  // recovery_required; fails_when=abandon drops its syncing or at-target guard (files left ahead of the database) or aborts over an unrelated HEAD.
  type Kind = 'draining' | 'fenced_old' | 'fenced_target' | 'fenced_unrelated' | 'merged_target' | 'merged_unrelated' | 'syncing_at_target' | 'syncing_descendant'
    | 'syncing_unrelated' | 'syncing_unrelated_synced' | 'syncing_lagging';
  type Action = 'owner_scan' | 'plain' | 'resume' | 'abandon';
  const kinds: Kind[] = ['draining', 'fenced_old', 'fenced_target', 'fenced_unrelated', 'merged_target', 'merged_unrelated', 'syncing_at_target', 'syncing_descendant',
    'syncing_unrelated', 'syncing_unrelated_synced'];
  const stateOf = (kind: Kind) => kind.split('_')[0] as 'draining' | 'fenced' | 'merged' | 'syncing';
  const crashAt = { draining: 'drained', fenced: 'fenced', merged: 'fenced', syncing: 'syncing' } as const;
  // The owner scan's row and moved count; a merged row's bookkeeping leaves it syncing, and a syncing row with an unrelated HEAD waits for --resume.
  const scanned: Record<Kind, [string, number]> = { draining: ['aborted', 1], fenced_old: ['aborted', 1], fenced_target: ['syncing', 1], fenced_unrelated: ['recovery_required', 1],
    merged_target: ['syncing', 1], merged_unrelated: ['recovery_required', 1], syncing_at_target: ['completed', 1], syncing_descendant: ['syncing', 0], syncing_unrelated: ['syncing', 0], syncing_unrelated_synced: ['syncing', 0], syncing_lagging: ['syncing', 0] };
  // syncing_lagging (HEAD at the target, members still at the start commit) is what the crash at syncing leaves; the other paths cover it in 7e/7d.
  const cells = [...kinds.flatMap(kind => (['owner_scan', 'plain', 'resume', 'abandon'] as Action[]).map(action => [kind, action] as [Kind, Action])),
    ['syncing_lagging', 'abandon'] as [Kind, Action]];
  // Test cost (#7782): a cell that leaves the checkout settled (no unfinished refresh, a HEAD the upstream contains, every member synced to it) hands
  // its fixture to the next cell instead of building a brain per cell, so each chain is at most one settled cell and then one unsettled cell.
  const endsSettled = ([kind, action]: [Kind, Action]) => action === 'abandon' ? kind === 'fenced_old' : !kind.includes('_unrelated') && kind !== 'syncing_descendant'
    && !(action === 'owner_scan' && (kind === 'fenced_target' || kind === 'merged_target'));
  const settledCells = cells.filter(endsSettled), unsettledCells = cells.filter(cell => !endsSettled(cell));
  const chains = [...unsettledCells.map((cell, i) => settledCells[i] ? [settledCells[i], cell] : [cell]), ...settledCells.slice(unsettledCells.length).map(cell => [cell])];
  expect(chains.flat()).toHaveLength(cells.length);
  for (const engine of engines) for (const chain of chains) await withRefreshFixture(engine, async f => { for (const [kind, action] of chain) {
    const label = `${kind} x ${action}`;
    const earlier = await f.refreshRows();
    if (earlier.length) {
      expect(earlier.map(r => r.state).filter(state => state !== 'aborted' && state !== 'completed'), `${label}: handoff`).toEqual([]);
      expect(git(f.root, 'merge-base', 'HEAD', 'origin/main'), `${label}: handoff`).toBe(f.head());
      expect([await f.lastCommit(f.alpha), await f.lastCommit(f.beta)], `${label}: handoff`).toEqual([f.head(), f.head()]);
    }
    const cellRows = async () => (await f.refreshRows()).filter(r => !earlier.some(e => e.id === r.id));
    const target = f.push('alpha/two.md', page('Alpha two', `Upstream for ${label}.`));
    const old = f.head();
    await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === crashAt[stateOf(kind)]) throw new Error(`simulated crash at ${point}`); } } }))
      .rejects.toThrow('simulated crash');
    await disposePersistenceConsumer(f.engine);
    const [orphan] = await cellRows();
    // The resident consumer's owner scan may already have settled it; restore what the crash left.
    await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET state=$2,completed_at=NULL WHERE id=$1::uuid`, [orphan.id, stateOf(kind)]);
    if (kind === 'fenced_target' || kind === 'merged_target') git(f.root, 'merge', '-q', '--ff-only', target);
    if (kind === 'syncing_descendant') commitFile(f.root, 'beta/local.md', page('Local', 'Committed on top of the target.'));
    if (kind.includes('_unrelated')) { git(f.root, 'reset', '-q', '--hard', old); commitFile(f.root, 'beta/unrelated.md', page('Unrelated', 'Not the upstream commit.')); }
    if (kind === 'syncing_at_target' || kind === 'syncing_unrelated_synced') for (const member of [f.alpha, f.beta]) await f.engine.transaction(tx => withCoordinatedWrite(tx, [member],
      () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [member, target]), TEST_WRITE_ATTRIBUTION));
    const head = f.head();
    const rows = async () => (await cellRows()).map(r => r.state);
    if (kind === 'draining') {
      // Ship audit (Step 7). Value: protects=writer status tells an orphaned draining refresh's writers to --resume it, never to retry (only a live
      // drain finishes on its own); fails_when=the draining branch of next stops checking liveness (master's wording); why_new=test 10 reads a live
      // drain only; seam=none; no_claim=a real process death (the crash is a hook throw; the refresh lock is released as on exit).
      const [status] = (await runPersistenceAdministration(f.engine, 'writer_status', { source_id: f.alpha }) as { worktree_refreshes: Array<Record<string, any>> }).worktree_refreshes;
      expect(status, label).toMatchObject({ refresh_id: orphan.id, state: 'draining', liveness: 'orphaned', auto_recovery: 'next_refresh',
        fix: { argv: ['gbrain', 'sources', 'refresh', f.alpha, '--resume'] }, next: `gbrain sources refresh ${f.alpha} --resume` });
    }
    if (action === 'owner_scan') {
      const [state, moved] = scanned[kind];
      expect(await resumeWorktreeRefreshes(f.engine), label).toBe(moved);
      expect(await rows(), label).toEqual([state]);
      expect(f.head(), label).toBe(head);
      continue;
    }
    if (action === 'abandon') {
      const members = [await f.lastCommit(f.alpha), await f.lastCommit(f.beta)];
      const run = refreshWorktree(f.engine, f.alpha, { abandon: true });
      if (kind === 'draining' || kind === 'fenced_old') {
        expect(await run, label).toMatchObject({ status: 'abandoned', refresh_id: orphan.id, old_head: old, target_head: target });
        expect(await rows(), label).toEqual(['aborted']);
        expect(((await cellRows())[0].outcome.refusal as { code: string }).code, label).toBe('refresh_abandoned');
      } else if (kind === 'fenced_unrelated' || kind === 'merged_unrelated') {
        const refused = await refusedWith(run, 'refresh_recovery_required');
        expect(refused.message, label).toContain(head);
        expect(await rows(), label).toEqual(['recovery_required']);
      } else {
        const refused = await refusedWith(run, 'refresh_in_progress');
        expect(refused.suggestion, label).toContain(`gbrain sources refresh ${f.alpha} --resume`);
        expect(await rows(), label).toEqual([stateOf(kind)]);
      }
      expect(f.head(), label).toBe(head);
      expect([await f.lastCommit(f.alpha), await f.lastCommit(f.beta)], label).toEqual(members);
      if (kind === 'draining') expect((await f.put(f.alpha, 'notes/after-abandon', page('After', 'admitted again'))).state ?? 'committed', label).toBe('committed');
      continue;
    }
    const run = refreshWorktree(f.engine, f.alpha, action === 'resume' ? { resume: true } : {});
    if (kind.includes('_unrelated')) {
      await refusedWith(run, 'refresh_recovery_required');
      expect(await rows(), label).toEqual(['recovery_required']);
      expect(f.head(), label).toBe(head);
      continue;
    }
    if (kind === 'syncing_descendant' && action === 'plain') {
      // The adoption completes the orphan at the descendant HEAD; the refresh itself then refuses the unpushed local commit.
      await refusedWith(run, 'refresh_diverged');
      expect(await rows(), label).toEqual(['completed']);
      expect(f.head(), label).toBe(head);
      expect(await f.lastCommit(f.alpha), label).toBe(head);
      expect(await f.lastCommit(f.beta), label).toBe(head);
      continue;
    }
    const result = await run;
    const rolledBack = kind === 'draining' || kind === 'fenced_old';
    if (action === 'resume') {
      expect(result, label).toMatchObject({ status: rolledBack ? 'abandoned' : 'completed', refresh_id: orphan.id });
      expect(await rows(), label).toEqual([rolledBack ? 'aborted' : 'completed']);
      expect(f.head(), label).toBe(head);
      continue;
    }
    if (rolledBack) {
      expect(result, label).toMatchObject({ status: 'completed', target_head: target, recovered: { refresh_id: orphan.id, state: 'aborted', status: 'abandoned' } });
      expect(await rows(), label).toEqual(['aborted', 'completed']);
    } else {
      expect(result, label).toMatchObject({ status: 'already_current', recovered: { refresh_id: orphan.id, state: 'completed', status: 'completed', previous_holder: { pid: process.pid } } });
      expect(await rows(), label).toEqual(['completed']);
    }
    const synced = kind === 'syncing_descendant' ? head : target;
    expect(f.head(), label).toBe(synced);
    expect(await f.lastCommit(f.alpha), label).toBe(synced);
    expect(await f.lastCommit(f.beta), label).toBe(synced);
  } });
}, 900_000);

