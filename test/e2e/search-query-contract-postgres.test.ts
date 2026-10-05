import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { seedSearchQueryContract, vector, verifyKeywordTieOrder, verifyMixedCjkCase, verifySearchDateBounds } from '../helpers/search-query-contract.ts';
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

  /** Runs `check` as a reader that sees pages only from a statement where `predicate` holds. */
  async function asSettingProbeReader(predicate: string, check: (reader: PostgresEngine) => Promise<void>) {
    await engine.executeRaw('CREATE ROLE query_contract_probe NOLOGIN');
    const tables = ['pages', 'content_chunks', 'sources', 'timeline_entries', 'config'];
    const original = await engine.executeRaw<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[])`, [tables]);
    const reader = new PostgresEngine();
    try {
      await engine.executeRaw('GRANT USAGE ON SCHEMA public TO query_contract_probe');
      await engine.executeRaw(`GRANT SELECT ON ${tables.join(', ')} TO query_contract_probe`);
      for (const table of tables) {
        await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await engine.executeRaw(`CREATE POLICY query_contract_probe_allow ON ${table} FOR SELECT TO query_contract_probe USING (true)`);
      }
      await engine.executeRaw(`CREATE POLICY query_contract_probe_setting ON pages AS RESTRICTIVE FOR SELECT TO query_contract_probe USING (${predicate})`);
      // One pooled connection, so the session role and settings reach every search transaction.
      await reader.connect({ database_url: process.env.DATABASE_URL!, poolSize: 1 });
      await reader.executeRaw('SET ROLE query_contract_probe');
      await check(reader);
    } finally {
      await reader.disconnect();
      await engine.executeRaw('DROP POLICY IF EXISTS query_contract_probe_setting ON pages');
      for (const table of tables) {
        await engine.executeRaw(`DROP POLICY IF EXISTS query_contract_probe_allow ON ${table}`);
        if (!original.find(row => row.relname === table)?.relrowsecurity) await engine.executeRaw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      }
      await engine.executeRaw('DROP OWNED BY query_contract_probe');
      await engine.executeRaw('DROP ROLE query_contract_probe');
    }
  }

  test('every search arm runs with JIT off and restores the caller setting (#6039)', async () => {
    // An arm that leaves JIT on sees no pages.
    await asSettingProbeReader(`current_setting('jit') = 'off'`, async reader => {
      await reader.executeRaw('SET jit = on');
      const opts = { limit: 10, sourceId: 'query-dates' };
      const arms = (e: BrainEngine) => ({
        keyword: () => e.searchKeyword('precisiontoken', opts),
        keywordChunks: () => e.searchKeywordChunks('precisiontoken', opts),
        cjk: () => e.searchKeyword('東京', opts),
        titles: () => e.searchTitles('precisiontoken', opts),
        vector: () => e.searchVector(vector, opts),
      });
      for (const [arm, run] of Object.entries(arms(reader))) expect({ arm, hits: (await run()).length }).toEqual({ arm, hits: 7 });
      await reader.transaction(async tx => {
        for (const [arm, run] of Object.entries(arms(tx))) {
          expect({ arm, hits: (await run()).length }).toEqual({ arm, hits: 7 });
          expect(await tx.executeRaw(`SELECT $1::text AS arm, current_setting('jit') AS jit`, [arm])).toEqual([{ arm, jit: 'on' }]);
        }
      });
    });
  });

  test('vector candidates plan with Materialize off and restore the caller setting (#6039)', async () => {
    // A vector attempt that leaves Materialize on sees no pages.
    await asSettingProbeReader(`current_setting('enable_material') = 'off'`, async reader => {
      await reader.executeRaw('SET enable_material = on');
      const opts = { limit: 10, sourceId: 'query-dates' };
      expect((await reader.searchVector(vector, opts)).length).toBe(7);
      await reader.transaction(async tx => {
        expect((await tx.searchVector(vector, opts)).length).toBe(7);
        expect(await tx.executeRaw(`SELECT current_setting('enable_material') AS enable_material`)).toEqual([{ enable_material: 'on' }]);
      });
      // Only the vector candidate statement plans without Materialize.
      expect(await reader.searchKeyword('precisiontoken', opts)).toEqual([]);
    });
  });
});
