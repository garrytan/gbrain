/**
 * #8617: a `gbrain sources refresh` tick refused `refresh_source_changed` because HEAD moved (a writer committing) or work
 * reached the worktree after the drain check gets exactly one retry in the same tick, from a fresh precheck.
 *
 * Protects: the first attempt aborts its row and the retry fast-forwards to the upstream, so the tick is not lost; a second
 * consecutive change still refuses `refresh_source_changed` with both rows aborted and no third attempt.
 * Regression it catches: a tick that drops on the first source change (a full tick of sync lag), or a retry loop that keeps
 * re-running while the checkout keeps moving.
 * Seams: the `hooks.boundary` callback moves HEAD at the drained point; a real bare remote, a pushing clone and the managed
 * checkout otherwise.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

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

const each = async (fn: (f: RefreshFixture) => Promise<void>) => { for (const engine of engines) await withRefreshFixture(engine, fn); };

test('a HEAD that moves once during the drain is retried in the same tick and reaches the upstream', () => each(async f => {
  const first = f.push('alpha/two.md', page('Alpha two', 'An upstream observation.'));
  const target = f.push('alpha/three.md', page('Alpha three', 'A later upstream observation.'));
  let drained = 0;
  const result = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point !== 'drained') return;
    if (++drained === 1) git(f.root, 'merge', '--ff-only', '--quiet', first);
  } } });
  expect(drained).toBe(2);
  expect(result).toMatchObject({ status: 'completed', old_head: first, target_head: target });
  expect(f.head()).toBe(target);
  expect((await f.refreshRows()).map(row => row.state)).toEqual(['aborted', 'completed']);
  expect(await f.lastCommit(f.alpha)).toBe(target);
}), 180_000);

test('a HEAD that moves again during the retry refuses refresh_source_changed after exactly two attempts', () => each(async f => {
  const steps = [f.push('alpha/two.md', page('Alpha two', 'One.')), f.push('alpha/three.md', page('Alpha three', 'Two.'))];
  f.push('alpha/four.md', page('Alpha four', 'Three.'));
  let drained = 0;
  const error = await refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => {
    if (point === 'drained') git(f.root, 'merge', '--ff-only', '--quiet', steps[drained++]!);
  } } }).then(() => null, (e: unknown) => e as { code?: string });
  expect(error?.code).toBe('refresh_source_changed');
  expect(drained).toBe(2);
  const rows = await f.refreshRows();
  expect(rows.map(row => row.state)).toEqual(['aborted', 'aborted']);
  expect(rows.map(row => (row.outcome.refusal as { code: string }).code)).toEqual(['refresh_source_changed', 'refresh_source_changed']);
  expect(f.head()).toBe(steps[1]!);
}), 180_000);
