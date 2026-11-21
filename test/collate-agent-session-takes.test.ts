/**
 * agentSessionTakes lists takes in byte order of (source id, slug, take id) on both SQL engines.
 *
 * 1. Contract: `agentSessionTakes` returns the takes the agent-session-facts repair retires ordered by source id, then slug,
 *    then take id, in byte (code point) order, the order PGLite (collation C) and the Rust engine give. The repair preview
 *    hashes and lists the takes in this order. `activeSources` (same file) is not tested: its ids only feed a count.
 * 2. Regression: the ORDER BY sorting by the database's default collation. en_US ignores punctuation at the first level, so
 *    Postgres listed slug 'notes/ab' before 'notes/a-z' and source 'ab-example' before 'a-z-example'.
 * 3. Why existing coverage misses it: test/repair-agent-session-facts-scale-9503.test.ts runs on PGLite only and keeps every take on one page.
 * 4. Seams: none. Pages, facts and takes are inserted with `executeRaw`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { agentSessionTakes } from '../src/core/repair/agent-session-facts.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const SOURCES = ['a-z-example', 'ab-example'];

for (const kind of testBackends()) {
  describe(`agentSessionTakes order (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const reattributed = new Set<number>();
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const source of SOURCES) {
        await engine.executeRaw("INSERT INTO sources(id, name, config) VALUES ($1, $1, '{}')", [source]);
      }
      // Inserted in en_US order, so a byte-order result is not the insertion order.
      for (const [source, slug] of [['ab-example', 'notes/a-z'], ['a-z-example', 'notes/ab'], ['a-z-example', 'notes/a-z'], ['ab-example', 'notes/ab']] as const) {
        const [page] = await engine.executeRaw<{ id: number }>(
          "INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1, $2, 'note', 'Example', '') RETURNING id", [source, slug]);
        const [fact] = await engine.executeRaw<{ id: number }>(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to)
           VALUES ($1, $2, $3, 'preference', 'private', 'hook:writeback', 'sess-example', 'user') RETURNING id`, [source, slug, `Claim of ${source}:${slug}`]);
        const [take] = await engine.executeRaw<{ id: number }>(
          `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, source, active)
           VALUES ($1, 1, $2, 'fact', 'self', 0.8, '2026-10-01', 'hook:writeback', true) RETURNING id`, [page!.id, `Claim of ${source}:${slug}`]);
        await engine.executeRaw("UPDATE facts SET consolidated_into=$1, consolidated_at=now() - interval '1 minute' WHERE id=$2", [take!.id, fact!.id]);
        reattributed.add(Number(fact!.id));
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('lists takes by source id, then slug, in byte order', async () => {
      const takes = await agentSessionTakes(engine, SOURCES, reattributed);
      expect(takes.map(t => `${t.source_id}:${t.slug}`)).toEqual([
        'a-z-example:notes/a-z', 'a-z-example:notes/ab', 'ab-example:notes/a-z', 'ab-example:notes/ab',
      ]);
    });
  });
}
