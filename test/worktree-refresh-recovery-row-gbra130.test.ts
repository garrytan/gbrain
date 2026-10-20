/**
 * GBRA-130 A-34 (#6712 PR 4b): owner-startup refresh recovery (`resumeWorktreeRefreshes`, the first step of
 * `recoverSourceTopologies`) had no per-row catch: one interrupted refresh whose convergence failed with an unexpected
 * error (here a database failure in its bookkeeping transaction) rejected the whole owner-start topology recovery, every
 * start, so no other refresh and no topology change was ever recovered.
 *
 * Protects (red before: recoverSourceTopologies rejects with the row's error): the row's failure is logged and the row is
 * left for the next start; recovery resolves, and once the cause is gone the next start converges the row.
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { refreshWorktree } from '../src/core/persistence/worktree-refresh.ts';
import { recoverSourceTopologies } from '../src/core/persistence/topology-recovery.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { page, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

test('one refresh whose owner-start convergence fails unexpectedly is left for the next start; topology recovery resolves and later converges it', async () => {
  for (const engine of engines) await withRefreshFixture(engine, async f => {
    const target = f.push('alpha/two.md', page('Alpha two', 'Upstream.'));
    await expect(refreshWorktree(f.engine, f.alpha, { hooks: { boundary: point => { if (point === 'merged') throw new Error('simulated crash after merge'); } } }))
      .rejects.toThrow('simulated crash');
    expect(f.head()).toBe(target);
    const interrupted = (await f.refreshRows()) as Array<{ state: string }>;
    expect(interrupted.map(row => row.state)).not.toContain('syncing');
    const logged: string[] = [];
    const err = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); });
    const original = f.engine.transaction.bind(f.engine);
    let failed = false;
    const tx = spyOn(f.engine, 'transaction').mockImplementation((async (fn: never) => {
      if (!failed) { failed = true; throw new Error('simulated database failure'); }
      return original(fn);
    }) as never);
    try {
      await recoverSourceTopologies(f.engine);
    } finally { tx.mockRestore(); err.mockRestore(); }
    expect(failed).toBe(true);
    expect(logged.some(line => line.includes('did not converge at owner start'))).toBe(true);
    expect(((await f.refreshRows()) as Array<{ state: string }>).map(row => row.state)).toEqual(interrupted.map(row => row.state));
    await recoverSourceTopologies(f.engine);
    expect(((await f.refreshRows()) as Array<{ state: string }>).map(row => row.state)).toEqual(['syncing']);
  });
}, 300_000);
