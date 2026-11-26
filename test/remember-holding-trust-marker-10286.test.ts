/**
 * #10286: the holding page a first `remember` creates (memory/unattributed) carries the writer's `trust_tier` marker, as
 * a page `put` creates does, so doctor `provenance_stamp_drift` stays ok on a fresh brain instead of counting the page
 * `marker_missing`.
 *
 * PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { scanProvenanceDrift } from '../src/core/trust/provenance-drift.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../src/core/facts-fence.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe(`#10286 the holding page remember creates carries its trust marker (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); resetGateway(); await close(); });

    test('a first remember with no entity leaves provenance drift clean', async () => {
      expect((await scanProvenanceDrift(engine, 'default')).marker_missing).toBe(0);
      const res = await dispatchToolCall(engine, 'remember', { fact: 'gbrain install check', provenance: 'install-check' }, { remote: false });
      expect(res.isError).not.toBe(true);
      const [stored] = await engine.executeRaw<{ tier: string; marker: string | null }>(
        "SELECT trust_tier AS tier, frontmatter->>'trust_tier' AS marker FROM pages WHERE source_id = 'default' AND slug = $1", [UNATTRIBUTED_MEMORY_SLUG]);
      expect(stored).toEqual({ tier: 'agent_written', marker: 'agent_written' });
      expect((await scanProvenanceDrift(engine, 'default')).marker_missing).toBe(0);
    }, 120_000);
  });
}
