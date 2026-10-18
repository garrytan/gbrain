/**
 * Title arm on PostgreSQL: the dual-backend cases in
 * test/search/title-arm-exact.test.ts, plus a plan proof for the remote
 * (safe-chunks) predicate. The plan proof EXPLAINs the statement the engine
 * runs (search/title-statement.ts buildSearchTitlesStatement, the one builder
 * both engines call) and requires `idx_pages_search` with no per-row
 * `to_tsvector(title)` filter (the pre-fix remote arm scanned every page in
 * scope). `enable_seqscan = off` inside the transaction keeps the plan
 * choice deterministic on a small fixture.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { buildSearchTitlesStatement } from '../../src/core/search/title-statement.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS } from '../../src/core/postgres-engine/keyword-statement-timeout.ts';
import { registerPostgresTests, requirePostgresTestDatabase } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/title-arm-exact.test.ts'));

const POSTGRES_DIALECT = { statementTimeout: `${KEYWORD_STATEMENT_TIMEOUT_DEFAULT_MS}ms`, relaxedPrefersIndex: true, staleProbe: false };
const REMOTE = { requireSafeChunks: true, excludePrivate: true, sourceId: 'default', limit: 50 };

describe('remote title arm plan (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    for (let i = 1; i <= 40; i++) {
      const slug = `notes/page-${i}`;
      const body = `Body ${i}.`;
      await engine.putPage(slug, { type: 'note', title: i % 10 === 0 ? `Acme review ${i}` : `Globex weekly sync ${i}`, compiled_truth: body });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
    }
    await engine.executeRaw('ANALYZE pages');
  }, 120_000);

  afterAll(async () => { await close?.(); });

  async function plan(query: string): Promise<string> {
    const statement = buildSearchTitlesStatement(query, REMOTE, POSTGRES_DIALECT);
    return engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL enable_seqscan = off`);
      const rows = await tx.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${statement.sql}`, statement.params);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  for (const query of ['acme', 'acme -secret', '"weekly sync"', 'globex or acme']) {
    test(`\`${query}\` uses idx_pages_search with no per-row to_tsvector(title)`, async () => {
      const text = await plan(query);
      expect(text).toContain('idx_pages_search');
      expect(text).not.toMatch(/to_tsvector\([^)]*title/);
    });
  }

  test('the engine runs the same statement the plan proof explains', async () => {
    const statement = buildSearchTitlesStatement('acme', REMOTE, POSTGRES_DIALECT);
    const direct = await engine.executeRaw<{ slug: string }>(statement.sql, statement.params);
    const viaEngine = await engine.searchTitles('acme', REMOTE);
    expect(viaEngine.map((r) => r.slug)).toEqual(direct.map((r) => r.slug));
    expect(viaEngine.length).toBe(4);
  });
});
