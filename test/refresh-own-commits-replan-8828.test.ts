/**
 * #8828: a refresh whose drain waited for gbrain's own writes saw HEAD move past the precheck's old_head (those writes' commits,
 * pushed upstream by the writer), refused refresh_source_changed, and its same-run retry met the next writes and refused too. When
 * every commit since old_head is gbrain's own and the upstream it pushed to holds them, the refresh now takes HEAD as its start
 * under the fence and fast-forwards to that upstream; any other HEAD move still refuses.
 * Seams: the real refresh state machine, commit ledger and git; PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, afterEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { _resetRefreshBarrierCacheForTests } from '../src/core/persistence/refresh-barrier.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { recordCommit } from '../src/core/git/commit-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { commitFile, git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

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
beforeEach(() => { _setRefreshFenceWaitForTests(0); _resetRefreshBarrierCacheForTests(); });
afterEach(() => { resetWriteSwitches(); _setRefreshFenceWaitForTests(null); });

const each = (fn: (f: RefreshFixture) => Promise<void>) => withEnv({ GBRAIN_REFRESH_BARRIER: '1' }, async () => {
  resetWriteSwitches();
  for (const engine of engines) await withRefreshFixture(engine, fn);
});

/**
 * What the writer does for a write admitted before the fence that lands while the refresh drains: commit on the checkout (ledgered),
 * then publish without moving the checkout. The remote moved, so the publish merges it in memory and pushes the merge (#7010).
 */
function ownCommitPublished(f: RefreshFixture, n: number, foreign = false): { own: string; published: string } {
  let own = commitFile(f.root, `alpha/drained-${n}.md`, page(`Drained ${n}`, 'A write admitted before the fence.'), 'gbrain: persist canonical memory update');
  recordCommit(f.root, { sha: own, writer: 'effect' });
  if (foreign) own = commitFile(f.root, `alpha/foreign-${n}.md`, page('Foreign', 'A commit gbrain did not make.'), 'foreign commit');
  git(f.root, 'fetch', '-q', 'origin');
  const remote = git(f.root, 'rev-parse', 'origin/main');
  const tree = git(f.root, 'merge-tree', '--write-tree', own, remote);
  const published = git(f.root, 'commit-tree', tree, '-p', own, '-p', remote, '-m', 'gbrain: integrate remote commits');
  git(f.root, 'push', '-q', 'origin', `${published}:refs/heads/main`);
  git(f.root, 'fetch', '-q', 'origin');
  return { own, published };
}

test('#8828: a refresh whose drain landed gbrain\'s own published commits fast-forwards from them instead of refusing refresh_source_changed', () => each(async f => {
  const upstream = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  const landed: Array<{ own: string; published: string }> = [];
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') landed.push(ownCommitPublished(f, landed.length + 1));
  } } });
  expect(landed).toHaveLength(1);
  expect(result.status).toBe('completed');
  expect(result.target_head).toBe(landed[0]!.published);
  expect(f.head()).toBe(landed[0]!.published);
  expect(git(f.root, 'merge-base', '--is-ancestor', upstream, 'HEAD')).toBe('');
  const [row] = await f.refreshRows();
  expect(row!.state).toBe('completed');
  expect(await f.lastCommit(f.alpha)).toBe(landed[0]!.published);
  expect(await f.lastCommit(f.beta)).toBe(landed[0]!.published);
}), 180_000);

test('#8828: a HEAD move under the fence that is not all gbrain\'s own published commits still refuses refresh_source_changed', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  let n = 0;
  const unpublished = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'drained') return;
    const sha = commitFile(f.root, `alpha/local-${++n}.md`, page('Local', 'A ledgered commit not pushed yet.'), 'gbrain: persist canonical memory update');
    recordCommit(f.root, { sha, writer: 'effect' });
  } } }).then(() => null, thrown => thrown as { code?: string; message: string });
  expect(unpublished?.code).toBe('refresh_source_changed');
  for (const row of await f.refreshRows()) expect(row.state).toBe('aborted');
}), 180_000);

test('#8828: one foreign commit among gbrain\'s own published commits still refuses refresh_source_changed and merges nothing', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  const landed: Array<{ own: string; published: string }> = [];
  const refused = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point === 'drained') landed.push(ownCommitPublished(f, landed.length + 1, true));
  } } }).then(() => null, thrown => thrown as { code?: string; message: string });
  expect(refused?.code).toBe('refresh_source_changed');
  expect(refused?.message).toContain('a commit or checkout gbrain did not make');
  expect(landed).toHaveLength(2);
  expect(f.head()).toBe(landed[1]!.own);
  const rows = await f.refreshRows();
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row.state).toBe('aborted');
}), 180_000);

test('#8828: own published commits under an upstream other than the one the precheck recorded still refuse refresh_source_changed and merge nothing', () => each(async f => {
  f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  const landed: Array<{ own: string; published: string }> = [];
  const refused = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: async point => {
    if (point !== 'drained') return;
    const n = landed.length + 1;
    landed.push(ownCommitPublished(f, n));
    git(f.root, 'push', '-q', 'origin', `${landed[n - 1]!.published}:refs/heads/other-${n}`);
    git(f.root, 'fetch', '-q', 'origin');
    git(f.root, 'branch', '-q', `--set-upstream-to=origin/other-${n}`);
  } } }).then(() => null, thrown => thrown as { code?: string; message: string });
  expect(refused?.code).toBe('refresh_source_changed');
  expect(landed.length).toBeGreaterThan(0);
  expect(f.head()).toBe(landed[landed.length - 1]!.own);
  for (const row of await f.refreshRows()) expect(row.state).toBe('aborted');
}), 180_000);
