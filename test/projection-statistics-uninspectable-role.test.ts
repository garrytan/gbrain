import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { BrainEngine } from '../src/core/engine.ts';
import { refreshProjectionStatistics } from '../src/core/search/projection-statistics.ts';

function postgresFixture(db: Pick<PGlite, 'query'> & Partial<Pick<PGlite, 'transaction'>>): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
    transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => db.transaction
      ? db.transaction(tx => fn(postgresFixture(tx)))
      : fn(postgresFixture(db)),
  } as unknown as BrainEngine;
}

describe('projection statistics hidden from a non-owner role', () => {
  let db: PGlite;
  let engine: BrainEngine;

  beforeAll(async () => {
    db = new PGlite();
    engine = postgresFixture(db);
    await db.exec(`CREATE ROLE app;
      CREATE TABLE pages (id integer PRIMARY KEY, source_id text, type text, slug text, deleted_at timestamptz,
        text_projection_revision integer, knowledge_revision integer, body_generation bigint);
      CREATE TABLE content_chunks (id integer PRIMARY KEY, model text, modality text, page_id integer, body_generation bigint);
      INSERT INTO pages SELECT i, 'source', 'note', 'slug-' || i, NULL, i, i, 0 FROM generate_series(1, 1000) i;
      INSERT INTO content_chunks SELECT i, 'model', 'text', i, 0 FROM generate_series(1, 1000) i;
      CREATE STATISTICS pages_text_projection_current_stats
        ON ((text_projection_revision = knowledge_revision)) FROM pages;
      ANALYZE pages;
      ANALYZE content_chunks;
      GRANT SELECT ON pages, content_chunks TO app;
      SET ROLE app;`);
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  test('an analyzed projection does not warn on repeated write passes', async () => {
    const [visibility] = await engine.executeRaw<{ can_select: boolean; owner_role: boolean; visible_stats: number }>(
      `SELECT has_table_privilege('pages', 'SELECT') AS can_select,
              pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'pages'::regclass), 'USAGE') AS owner_role,
              (SELECT count(*)::int FROM pg_stats_ext_exprs WHERE statistics_name = 'pages_text_projection_current_stats') AS visible_stats`);
    expect(visibility).toEqual({ can_select: true, owner_role: false, visible_stats: 0 });

    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await refreshProjectionStatistics(engine, 1)).toBe(true);
      expect(await refreshProjectionStatistics(engine, 1)).toBe(true);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  }, 30_000);
});
