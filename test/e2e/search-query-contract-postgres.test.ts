import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { seedSearchQueryContract, verifyKeywordTieOrder, verifyMixedCjkCase, verifySearchDateBounds } from '../helpers/search-query-contract.ts';
import { withEnv } from '../helpers/with-env.ts';

(hasDatabase() ? describe : describe.skip)('search query contract on Postgres', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    engine = await setupLegacyEmbeddingDB();
    await seedSearchQueryContract(engine);
  }, 120_000);
  afterAll(async () => { await teardownDB(); });
  test('all arms preserve inclusive bounds and strict legacy microsecond precision', async () => { await verifySearchDateBounds(engine); });
  test('keyword page pools and chunk pagination have deterministic tie ordering', async () => { await verifyKeywordTieOrder(engine); });
  test('mixed CJK and Latin terms remain case-insensitive', async () => { await verifyMixedCjkCase(engine); });
  test('relaxed retries retain scope and restore the planner setting', async () => {
    const before = await engine.executeRaw(`SHOW enable_seqscan`);
    for (const requireSafeChunks of [false, true]) {
      const hits = await engine.searchKeyword('ordertoken impossibleterm', { sourceId: 'query-order', orFallback: true, requireSafeChunks });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(hit => hit.keyword_relaxed && hit.source_id === 'query-order')).toBe(true);
      expect((await engine.searchTitles('ordertoken impossibleterm', { sourceId: 'query-order', requireSafeChunks })).length).toBeGreaterThan(0);
    }
    expect(await engine.searchKeyword('ordertoken impossibleterm', { sourceId: 'query-dates', orFallback: true })).toEqual([]);
    expect(await engine.executeRaw(`SHOW enable_seqscan`)).toEqual(before);
  });

  test('restricted runtime roles retain RLS and local settings through relaxed retries', async () => {
    await engine.executeRaw('CREATE ROLE query_contract_reader NOLOGIN');
    const tables = ['pages', 'content_chunks', 'sources'];
    const original = await engine.executeRaw<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[])`, [tables]);
    try {
      await engine.executeRaw('GRANT USAGE ON SCHEMA public TO query_contract_reader');
      await engine.executeRaw('GRANT SELECT ON pages, content_chunks, sources TO query_contract_reader');
      for (const table of tables) {
        await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await engine.executeRaw(`CREATE POLICY query_contract_allow ON ${table} FOR SELECT TO query_contract_reader USING (true)`);
      }
      await engine.executeRaw(`CREATE POLICY query_contract_source ON pages AS RESTRICTIVE FOR SELECT TO query_contract_reader USING (source_id = 'query-order')`);
      await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
        await engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL ROLE query_contract_reader');
          await tx.executeRaw(`SELECT set_config('app.scopes', 'original-scope', true)`);
          const before = await tx.executeRaw(`SHOW enable_seqscan`);
          const hits = await tx.searchKeyword('ordertoken impossibleterm', { sourceId: 'query-order', orFallback: true });
          expect(hits.length).toBeGreaterThan(0);
          expect(hits.every(hit => hit.source_id === 'query-order' && hit.keyword_relaxed)).toBe(true);
          expect(await tx.searchKeyword('precisiontoken impossibleterm', { sourceId: 'query-dates', orFallback: true })).toEqual([]);
          expect(await tx.executeRaw(`SELECT current_setting('app.scopes') AS scopes`)).toEqual([{ scopes: 'original-scope' }]);
          expect(await tx.executeRaw(`SHOW enable_seqscan`)).toEqual(before);
        });
      });
    } finally {
      await engine.executeRaw('DROP POLICY IF EXISTS query_contract_source ON pages');
      for (const table of tables) {
        await engine.executeRaw(`DROP POLICY IF EXISTS query_contract_allow ON ${table}`);
        if (!original.find(row => row.relname === table)?.relrowsecurity) await engine.executeRaw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      }
      await engine.executeRaw('DROP OWNED BY query_contract_reader');
      await engine.executeRaw('DROP ROLE query_contract_reader');
    }
  });
});
