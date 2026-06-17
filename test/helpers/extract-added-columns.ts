/**
 * MIGRATIONS-source introspection for the bootstrap CI guard.
 *
 * The v0.28.5 SQL-parser at the bottom of `test/schema-bootstrap-coverage.test.ts`
 * walks every `CREATE INDEX` in `PGLITE_SCHEMA_SQL` to enforce that indexed
 * columns either live in the table's CREATE TABLE body OR are added by
 * `applyForwardReferenceBootstrap`. That structural check kills the
 * column-with-index forward-reference class.
 *
 * It does NOT kill the column-ONLY forward-reference class. v0.26.5 (v34)
 * added `sources.archived` + `sources.archived_at` + `sources.archive_expires_at`
 * for the soft-delete lifecycle. Those columns aren't indexed, but
 * `CREATE TABLE IF NOT EXISTS sources` is a no-op on a pre-v34 brain, so the
 * archive columns never land on the schema when the schema blob replays —
 * downstream visibility filters in search / list_pages trip immediately.
 *
 * This helper closes the gap by walking the source text of
 * `src/core/migrate.ts` and extracting every `ALTER TABLE ... ADD COLUMN`
 * the file contains, regardless of whether it lives in a migration's `sql`
 * field, `sqlFor.{postgres,pglite}` field, or inside a `handler` function
 * body that calls `engine.runMigration(N, \`...\`)`. The test in
 * `schema-bootstrap-coverage.test.ts` then asserts every such (table, column)
 * pair is also covered by the bootstrap.
 *
 * Why source-file introspection (vs walking the MIGRATIONS object array):
 * v34's `destructive_guard_columns` migration uses a `handler` function that
 * embeds SQL inside `engine.runMigration(34, \`ALTER TABLE sources ADD COLUMN ...\`)`.
 * The handler body isn't reachable via Migration.sql / Migration.sqlFor. Reading
 * the source text catches ALL three shapes uniformly: top-level sql, sqlFor
 * overrides, and handler-embedded `engine.runMigration` calls.
 *
 * Why regex-on-our-own-source is safe (vs the DDL-parser-of-prod-schema trap
 * codex flagged in plan review): the input is migrate.ts — our own code, with
 * consistent shape. ALTER TABLE ADD COLUMN is unambiguous. Future contributors
 * who add columns follow the same shape (or fail this test and learn).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface AddedColumnRef {
  table: string;
  column: string;
}

/**
 * Extract every `ALTER TABLE <table> ADD COLUMN <col>` reference from a SQL
 * string. Handles:
 *   - `ALTER TABLE [IF EXISTS] [ONLY] <table> ADD COLUMN [IF NOT EXISTS] <col>`
 *   - Quoted identifiers (`"col"`, `\`col\``)
 *   - Multi-statement strings with mixed ALTER + CREATE + UPDATE
 */
function extractAlterAddColumnsFromSql(sql: string): Array<{ table: string; column: string }> {
  const result: Array<{ table: string; column: string }> = [];
  // Identifier shape: optional quote, word chars, optional matching quote.
  // Handles bare `pages`, double-quoted `"pages"`, and backtick `\`pages\``.
  const re = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    result.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return result;
}

/**
 * Read `src/core/migrate.ts` and emit every (table, column) pair that ANY
 * `ALTER TABLE ... ADD COLUMN` reference in the file targets. Deduped:
 * later occurrences of the same (table, column) are dropped.
 *
 * Source-file introspection covers all three migration shapes:
 *   - top-level `sql:` field (e.g. v22 ingest_log_source_id)
 *   - `sqlFor.postgres` / `sqlFor.pglite` overrides
 *   - handler-body `engine.runMigration(N, \`ALTER TABLE ... ADD COLUMN ...\`)`
 *     (e.g. v34 destructive_guard_columns)
 *
 * The function intentionally does NOT track which migration each column
 * came from. That mapping requires parsing the surrounding migration object
 * structure, which adds fragility for marginal value (the failure message
 * names the table.column; the contributor can grep for it in migrate.ts).
 */
export function extractAddedColumnsFromMigrations(): AddedColumnRef[] {
  const migratePath = resolve(process.cwd(), 'src/core/migrate.ts');
  const source = readFileSync(migratePath, 'utf-8');

  const seen = new Set<string>();
  const result: AddedColumnRef[] = [];
  for (const ref of extractAlterAddColumnsFromSql(source)) {
    const key = `${ref.table}.${ref.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

// Test-internal exports so the parser itself can be unit-tested.
export const __internal = { extractAlterAddColumnsFromSql };
