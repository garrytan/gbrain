/**
 * The PGLite / Postgres SQL of the memory-trust evals' harness members (src/core/engine-sql/eval-harness-reads.ts),
 * pinned byte for byte. Each member runs against a recording executeRaw; the texts and parameters it sends must equal
 * the literals below, written out here rather than imported, so an edit to the SQL shows up as a diff of this file.
 * scanTextColumns builds one SELECT per table from the catalog; the recorder answers the two catalog reads with a
 * small fixed catalog (pages, facts, takes and a table with no page, slug or lifecycle column).
 */
import { describe, expect, test } from 'bun:test';
import * as sql from '../src/core/engine-sql/eval-harness-reads.ts';

type Call = { text: string; params: unknown[] | undefined };

function recorder(answer: (text: string) => unknown[] = () => []) {
  const calls: Call[] = [];
  const engine = { executeRaw: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return answer(text) as never[]; } };
  return { engine, calls };
}

const CATALOG = [
  { table: 'facts', column: 'fact', data_type: 'text', udt_name: 'text' },
  { table: 'pages', column: 'compiled_truth', data_type: 'text', udt_name: 'text' },
  { table: 'plain_notes', column: 'body', data_type: 'jsonb', udt_name: 'jsonb' },
  { table: 'takes', column: 'claim', data_type: 'text', udt_name: 'text' },
];
const COLUMNS: Record<string, string[]> = {
  facts: ['id', 'entity_slug', 'source_markdown_slug', 'fact', 'expired_at'],
  pages: ['id', 'slug', 'compiled_truth', 'deleted_at'],
  plain_notes: ['id', 'body'],
  takes: ['id', 'page_id', 'claim', 'active'],
};

describe('eval harness SQL, byte for byte', () => {
  test('getFactsByIds, findLiveFactsByText and listPageIdSlugs', async () => {
    const { engine, calls } = recorder();
    await sql.getFactsByIds(engine, [3, 1]);
    await sql.findLiveFactsByText(engine, 'default', ['a', 'b']);
    await sql.listPageIdSlugs(engine);
    await sql.getFactsByIds(engine, []);
    await sql.findLiveFactsByText(engine, 'default', []);
    expect(calls).toEqual([
      { text: 'SELECT id, source_id, fact, entity_slug, expired_at, superseded_by FROM facts WHERE id = ANY($1::bigint[]) ORDER BY id', params: [[3, 1]] },
      { text: 'SELECT id, fact FROM facts WHERE source_id = $1 AND fact = ANY($2::text[]) AND expired_at IS NULL ORDER BY id', params: ['default', ['a', 'b']] },
      { text: 'SELECT id, slug, source_id, deleted_at FROM pages ORDER BY id', params: undefined },
    ]);
  });

  test('hasTable, hasColumn and listTextBearingColumns', async () => {
    const { engine, calls } = recorder();
    await sql.hasTable(engine, 'takes');
    await sql.hasColumn(engine, 'takes', 'active');
    await sql.listTextBearingColumns(engine);
    expect(calls).toEqual([
      { text: 'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS present', params: ['takes'] },
      { text: 'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS present', params: ['takes', 'active'] },
      { text: `SELECT c.table_name AS "table", c.column_name AS "column", c.data_type, c.udt_name
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR c.udt_name IN ('_text', '_varchar'))
    ORDER BY c.table_name COLLATE "C", c.ordinal_position`, params: undefined },
    ]);
  });

  test('scanTextColumns: one SELECT per table from the catalog, with and without activeOnly', async () => {
    const answer = (text: string) => text.startsWith('SELECT c.table_name') ? CATALOG
      : text.startsWith('SELECT table_name AS "table"') ? Object.entries(COLUMNS).flatMap(([table, cols]) => cols.map(column => ({ table, column }))) : [];
    for (const activeOnly of [false, true]) {
      const { engine, calls } = recorder(answer);
      await sql.scanTextColumns(engine, { pattern: 'Token', activeOnly });
      const live = (s: string) => (activeOnly ? s : '');
      expect(calls.slice(1)).toEqual([
        { text: 'SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])',
          params: [['facts', 'pages', 'plain_notes', 'takes']] },
        { text: `SELECT $1::text AS "column", COALESCE(x."entity_slug"::text, x."source_markdown_slug"::text) AS slug, NULL::bigint AS page_id, x."entity_slug"::text AS entity_slug, x."fact"::text AS value FROM "facts" x WHERE strpos(lower(x."fact"::text), $2) > 0${live(' AND x."expired_at" IS NULL')}`,
          params: ['fact', 'token'] },
        { text: `SELECT $1::text AS "column", COALESCE(x."slug"::text, p."slug") AS slug, x."id"::bigint AS page_id, NULL::text AS entity_slug, x."compiled_truth"::text AS value FROM "pages" x LEFT JOIN "pages" p ON p."id" = x."id" WHERE strpos(lower(x."compiled_truth"::text), $2) > 0${live(' AND x."deleted_at" IS NULL AND (p."id" IS NULL OR p."deleted_at" IS NULL)')}`,
          params: ['compiled_truth', 'token'] },
        { text: 'SELECT $1::text AS "column", NULL::text AS slug, NULL::bigint AS page_id, NULL::text AS entity_slug, x."body"::text AS value FROM "plain_notes" x WHERE strpos(lower(x."body"::text), $2) > 0',
          params: ['body', 'token'] },
        { text: `SELECT $1::text AS "column", COALESCE(p."slug") AS slug, x."page_id"::bigint AS page_id, NULL::text AS entity_slug, x."claim"::text AS value FROM "takes" x LEFT JOIN "pages" p ON p."id" = x."page_id" WHERE strpos(lower(x."claim"::text), $2) > 0${live(' AND x."active" AND (p."id" IS NULL OR p."deleted_at" IS NULL)')}`,
          params: ['claim', 'token'] },
      ]);
    }
  });

  test('a catalog name with a double quote is quoted, never spliced bare', () => {
    expect(sql.catalogIdentifierSql('we"ird')).toBe('"we""ird"');
  });

  test('pauseManagedPersistence and restoreManagedPersistence', async () => {
    const { engine, calls } = recorder((text) => (text.startsWith('WITH prior') ? [{ enabled: true, mode_epoch: '7' }] : [{ restored: true }]));
    expect(await sql.pauseManagedPersistence(engine)).toEqual({ enabled: true, mode_epoch: '7' });
    expect(await sql.restoreManagedPersistence(engine, { enabled: true, mode_epoch: '7' })).toBe(true);
    expect(calls).toEqual([
      { text: `WITH prior AS (SELECT enabled, mode_epoch FROM persistence_brain WHERE singleton = 1 FOR UPDATE),
      paused AS (UPDATE persistence_brain SET enabled = false WHERE singleton = 1)
    SELECT enabled, mode_epoch::text AS mode_epoch FROM prior`, params: undefined },
      { text: 'UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1 AND enabled = false AND mode_epoch = $2::bigint RETURNING true AS restored', params: [true, '7'] },
    ]);
  });
});
