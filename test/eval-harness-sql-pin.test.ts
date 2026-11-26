/**
 * The PGLite / Postgres SQL of the memory-trust evals' harness members (src/core/engine-sql/eval-harness-reads.ts),
 * pinned byte for byte. Each member runs against a recording executeRaw; the texts and parameters it sends must equal
 * the literals below, written out here rather than imported, so an edit to the SQL shows up as a diff of this file.
 * scanTextColumns builds one SELECT over every table from the catalog; the recorder answers its catalog reads with a
 * small fixed catalog (pages, facts, takes and a table with a uuid page_id and no slug or lifecycle column).
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
const COLUMNS: Record<string, Array<[string, string]>> = {
  facts: [['id', 'bigint'], ['source_id', 'text'], ['entity_slug', 'text'], ['source_markdown_slug', 'text'], ['fact', 'text'], ['expired_at', 'timestamp with time zone']],
  pages: [['id', 'integer'], ['slug', 'text'], ['compiled_truth', 'text'], ['deleted_at', 'timestamp with time zone']],
  plain_notes: [['id', 'uuid'], ['page_id', 'uuid'], ['body', 'jsonb']],
  takes: [['id', 'bigint'], ['page_id', 'integer'], ['claim', 'text'], ['active', 'boolean']],
};

/** The scan's catalog reads: the text columns, the visibility check (`hidden` tables) and every column with its type. */
const scanAnswer = (hidden: string[] = []) => (text: string) => text.startsWith('SELECT c.table_name') ? CATALOG
  : text.startsWith('SELECT current_schema()') ? [{ schema: 'public', hidden }]
  : text.startsWith('SELECT table_name AS "table"') ? Object.entries(COLUMNS).flatMap(([table, cols]) => cols.map(([column, data_type]) => ({ table, column, data_type }))) : [];

const VISIBILITY = `SELECT current_schema()::text AS schema,
      COALESCE(array_agg(c.relname::text ORDER BY c.relname::text COLLATE "C") FILTER (WHERE NOT pg_catalog.has_table_privilege(c.oid, 'SELECT') OR pg_catalog.row_security_active(c.oid)), '{}') AS hidden
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])`;

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

  test('scanTextColumns: one schema-qualified SELECT over every table from the catalog, with and without activeOnly', async () => {
    for (const activeOnly of [false, true]) {
      const { engine, calls } = recorder(scanAnswer());
      await sql.scanTextColumns(engine, { pattern: 'Token', activeOnly, ...(activeOnly ? { limit: 5 } : {}) });
      const live = (s: string) => (activeOnly ? s : '');
      expect(calls.slice(1)).toEqual([
        { text: VISIBILITY, params: [['facts', 'pages', 'plain_notes', 'takes']] },
        { text: 'SELECT table_name AS "table", column_name AS "column", data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])',
          params: [['facts', 'pages', 'plain_notes', 'takes']] },
        { text: 'SELECT * FROM ('
            + `SELECT $1::text AS "table", $2::text AS "column", COALESCE(x."entity_slug"::text, x."source_markdown_slug"::text) AS slug, NULL::bigint AS page_id, x."entity_slug"::text AS entity_slug, x."fact"::text AS value FROM "public"."facts" x WHERE strpos(lower(x."fact"::text), lower($3::text)) > 0${live(' AND x."expired_at" IS NULL AND NOT EXISTS (SELECT 1 FROM "public"."pages" q WHERE q."source_id" = x."source_id" AND q."slug" = x."source_markdown_slug" AND q."deleted_at" IS NOT NULL)')}`
            + ` UNION ALL SELECT $4::text AS "table", $5::text AS "column", COALESCE(x."slug"::text, p."slug") AS slug, x."id"::bigint AS page_id, NULL::text AS entity_slug, x."compiled_truth"::text AS value FROM "public"."pages" x LEFT JOIN "public"."pages" p ON p."id" = x."id" WHERE strpos(lower(x."compiled_truth"::text), lower($6::text)) > 0${live(' AND x."deleted_at" IS NULL AND (p."id" IS NULL OR p."deleted_at" IS NULL)')}`
            + ' UNION ALL SELECT $7::text AS "table", $8::text AS "column", NULL::text AS slug, NULL::bigint AS page_id, NULL::text AS entity_slug, x."body"::text AS value FROM "public"."plain_notes" x WHERE strpos(lower(x."body"::text), lower($9::text)) > 0'
            + ` UNION ALL SELECT $10::text AS "table", $11::text AS "column", COALESCE(p."slug") AS slug, x."page_id"::bigint AS page_id, NULL::text AS entity_slug, x."claim"::text AS value FROM "public"."takes" x LEFT JOIN "public"."pages" p ON p."id" = x."page_id" WHERE strpos(lower(x."claim"::text), lower($12::text)) > 0${live(' AND x."active" AND (p."id" IS NULL OR p."deleted_at" IS NULL)')}`
            + `) hit ORDER BY convert_to(hit."table", 'UTF8'), convert_to(hit."column", 'UTF8'), convert_to(hit.value, 'UTF8')${live(' LIMIT $13')}`,
          params: ['facts', 'fact', 'Token', 'pages', 'compiled_truth', 'Token', 'plain_notes', 'body', 'Token', 'takes', 'claim', 'Token', ...(activeOnly ? [5] : [])] },
      ]);
    }
  });

  test('scanTextColumns refuses, naming them, tables the running role cannot read in full, and a negative limit', async () => {
    const { engine, calls } = recorder(scanAnswer(['facts', 'takes']));
    const refused = await sql.scanTextColumns(engine, { pattern: 'token', activeOnly: false }).then(() => 'ok', (e: Error) => e.message);
    expect(refused).toBe('scanTextColumns: the running role cannot read every row of facts, takes; run the scan as the table owner or a BYPASSRLS role');
    expect(calls.map(c => c.text.slice(0, 22))).toEqual(['SELECT c.table_name AS', 'SELECT current_schema(']);
    const negative = await sql.scanTextColumns(recorder().engine, { pattern: 'token', activeOnly: false, limit: -1 }).then(() => 'ok', (e: Error) => e.message);
    expect(negative).toBe('scanTextColumns: a limit that is not a whole number');
  });

  test('a catalog name with a double quote is quoted, never spliced bare', () => {
    expect(sql.catalogIdentifierSql('we"ird')).toBe('"we""ird"');
  });

  test('pauseManagedPersistence and restoreManagedPersistence', async () => {
    const { engine, calls } = recorder((text) => (text.startsWith('WITH prior') ? [{ enabled: true, mode_epoch: '7', topology_changes: '2' }] : [{ restored: true }]));
    expect(await sql.pauseManagedPersistence(engine)).toEqual({ enabled: true, mode_epoch: '7', topology_changes: '2' });
    expect(await sql.restoreManagedPersistence(engine, { enabled: true, mode_epoch: '7', topology_changes: '2' })).toBe(true);
    expect(calls).toEqual([
      { text: `WITH prior AS (SELECT enabled, mode_epoch, (SELECT count(*) FROM persistence_topology_changes) AS topology_changes
        FROM persistence_brain WHERE singleton = 1 FOR UPDATE),
      paused AS (UPDATE persistence_brain SET enabled = false WHERE singleton = 1)
    SELECT enabled, mode_epoch::text AS mode_epoch, topology_changes::text AS topology_changes FROM prior`, params: undefined },
      { text: `UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1 AND enabled = false AND mode_epoch = $2::bigint
      AND (SELECT count(*) FROM persistence_topology_changes) = $3::bigint RETURNING true AS restored`, params: [true, '7', '2'] },
    ]);
  });
});
