/**
 * Fix wave 3 chaos scenario: a delayed persistence consumer with sustained
 * connector arrivals, then a provider outage, then recovery. PGLite here;
 * Postgres through test/e2e/fix-wave-3-integration.test.ts.
 *
 * Authoring gate. (1) Protects the backlog contract across Lane A's pending
 * batches and the consumer: every accepted connector write publishes once the
 * owner recovers, nothing is admitted twice, an outage neither loses the
 * pending set nor stamps freshness, and the backlog drains with no operator
 * step. (2) Fails when a pending set is dropped by an outage, when a later
 * sweep re-admits pages still pending, or when the drain stalls. (3) Lane A's
 * pending-set tests pause one run; none sustains arrivals across several
 * stopped runs and an outage. (4) No seam: the owner is delayed by draining its
 * worktree, the provider by a fixture fetcher. It reports time-to-searchable,
 * oldest pending age and drain rate on stderr.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { connectorWaitBudget } from '../src/core/persistence/connector-sync.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, contact, withGoogleAccount, connectorPendingSet } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, boundSource } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const ARRIVALS_PER_SWEEP = 4;
const SWEEPS = 3;

async function worktree(engine: BrainEngine, id: string, state: 'draining' | 'active') {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('UPDATE persistence_worktrees SET state=$2 WHERE id=$1::uuid', [id, state]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

test('delayed consumer, sustained arrivals and a provider outage: the backlog drains with every page published once', async () => withEnv(env, async () => {
  const budget = connectorWaitBudget.ms;
  connectorWaitBudget.ms = 1_000;
  try {
    for (const engine of engines) {
      const f = await boundSource(engine, googleConfig);
      let listed = 0, down = false;
      const fetcher = async (url: string) => {
        if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
        if (down) return json({ error: { message: 'fixture people outage' } }, 503);
        return json({ connections: Array.from({ length: listed }, (_, i) => contact(`arrival-${i}`, `Arrival Example ${i}`)), nextSyncToken: `contacts-${listed}` });
      };
      const run = () => runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, withGoogleAccount(fetcher)).catch(error => error);
      await worktree(engine, f.binding.worktree_id, 'draining');
      const started = Date.now();
      for (let sweep = 0; sweep < SWEEPS; sweep++) {
        listed += ARRIVALS_PER_SWEEP;
        await run();
        await disposePersistenceConsumer(engine);
      }
      const total = SWEEPS * ARRIVALS_PER_SWEEP;
      const queued = async () => (await engine.executeRaw<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' AND state IN ('queued','running')", [f.id]))[0]!.n;
      // While the owner is delayed, each sweep first waits on its recorded pending set and stops on the
      // wait budget; the checkpoint never advances past a pending page, so later arrivals wait upstream.
      const backlog = await queued();
      expect(backlog).toBeGreaterThanOrEqual(ARRIVALS_PER_SWEEP);
      expect(backlog).toBeLessThanOrEqual(total);
      expect((await connectorPendingSet(engine, f.id)).length).toBe(backlog);
      // The provider goes down while the owner is still delayed: nothing is lost or stamped.
      down = true;
      const lastSync = (await engine.executeRaw<{ at: string | null }>('SELECT last_sync_at::text AS at FROM sources WHERE id=$1', [f.id]))[0]!.at;
      await run();
      await disposePersistenceConsumer(engine);
      expect(await queued()).toBe(backlog);
      expect((await connectorPendingSet(engine, f.id)).length).toBe(backlog);
      expect((await engine.executeRaw<{ at: string | null }>('SELECT last_sync_at::text AS at FROM sources WHERE id=$1', [f.id]))[0]!.at).toBe(lastSync);
      const [oldest] = await engine.executeRaw<{ age_ms: number }>(
        "SELECT (EXTRACT(EPOCH FROM (now()-min(created_at)))*1000)::int AS age_ms FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running')", [f.id]);
      // Recovery: the owner and the provider return.
      down = false;
      const recovered = Date.now();
      await worktree(engine, f.binding.worktree_id, 'active');
      startPersistenceConsumer(engine, { engine: engine.kind });
      const deadline = Date.now() + 60_000;
      while (await queued() > 0 && Date.now() < deadline) await Bun.sleep(100);
      expect(await queued()).toBe(0);
      const drainMs = Date.now() - recovered;
      // Sweeps pick up the arrivals that waited upstream until every page is in, then admit nothing new.
      const imports = async () => (await engine.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import'", [f.id]))[0]!.n;
      let sweeps = 0;
      const present = async () => (await engine.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM pages WHERE source_id=$1 AND slug LIKE 'people/arrival-example-%' AND deleted_at IS NULL", [f.id]))[0]!.n;
      const drain = async () => { while (await queued() > 0 && Date.now() < deadline) await Bun.sleep(100); };
      while (await present() < total && sweeps < 3) { await run(); await drain(); sweeps++; }
      expect(await present()).toBe(total);
      while (await queued() > 0 && Date.now() < deadline) await Bun.sleep(100);
      const searchable = async () => (await Promise.all(Array.from({ length: total }, async (_, i) =>
        (await engine.searchKeyword(`Arrival Example ${i}`, { sourceId: f.id } as never)).some(r => r.slug === `people/arrival-example-${i}`)))).every(Boolean);
      while (!await searchable() && Date.now() < deadline) await Bun.sleep(100);
      expect(await searchable()).toBe(true);
      const timeToSearchable = Date.now() - started;
      await disposePersistenceConsumer(engine);
      const before = await imports();
      await run();
      await disposePersistenceConsumer(engine);
      expect(await imports()).toBe(before);
      // Each arrival was admitted exactly once across the delay, the outage and recovery.
      expect(before).toBe(total);
      // No page is left pending; a checkpoint save may still be settling and resolves on the next run.
      expect((await connectorPendingSet(engine, f.id)).filter(item => item.itemRef !== '__managed_connector_checkpoint__')).toEqual([]);
      const pages = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'people/arrival-example-%' AND deleted_at IS NULL", [f.id]);
      expect(pages).toHaveLength(total);
      const failed = await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' AND state<>'committed'", [f.id]);
      expect(failed).toEqual([]);
      console.error(`[chaos] ${engine.kind} arrivals=${total} oldest_pending_ms=${oldest!.age_ms} drain_ms=${drainMs} `
        + `backlog=${backlog} drain_rate_per_s=${(backlog / Math.max(drainMs / 1000, 0.001)).toFixed(1)} time_to_searchable_ms=${timeToSearchable}`);
    }
  } finally { connectorWaitBudget.ms = budget; }
}), 300_000);
