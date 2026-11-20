/**
 * The `gbrain schema detect` page-shape members (engine-sql/schema-detect.ts) send Postgres the statements
 * src/core/schema-pack/detect.ts sent through `executeRaw` at d4669c924d, in the same order, with three intended
 * differences: the types under a prefix are aggregated `COLLATE "C"` in byte order, a count tie sorts by the prefix or the
 * type `COLLATE "C"`, and the type statement binds its limit (`$2`, 100 from detect) instead of a literal `LIMIT 100`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `runDetect` on Postgres sends exactly the three statements below (text and params, in order).
 *  - Regression: a member that drops the byte-order collation or the tie-break returns rows in the database locale's order
 *    on Postgres alone (en_US puts 'ab' before 'a-z'); PGLite parity on a fixture without ties cannot see it.
 *  - Why existing coverage misses it: test/engine-parity/schema-detect.test.ts compares results, not statement text, and
 *    the sql-text goldens cover the W1 domains only.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records text and params; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runDetect } from '../src/core/schema-pack/detect.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const TOTALS = `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped,
       COUNT(*) FILTER (WHERE type IS NOT NULL AND type != '')::text AS typed
     FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL`;

const PREFIXES = `SELECT
       substring(slug from '^[^/]+/') AS prefix,
       COUNT(*)::text AS cnt,
       array_agg(DISTINCT type COLLATE "C" ORDER BY type COLLATE "C") FILTER (WHERE type IS NOT NULL AND type != '') AS sample_types
     FROM pages
     WHERE source_id = $1
       AND deleted_at IS NULL
       AND slug LIKE '%/%'
     GROUP BY substring(slug from '^[^/]+/')
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC, substring(slug from '^[^/]+/') COLLATE "C"
     LIMIT $3`;

const TYPES = `SELECT type, COUNT(*)::text AS cnt
     FROM pages
     WHERE source_id = $1 AND deleted_at IS NULL AND type IS NOT NULL AND type != ''
     GROUP BY type
     ORDER BY COUNT(*) DESC, type COLLATE "C"
     LIMIT $2`;

describe('schema detect statements on Postgres', () => {
  test('runDetect sends the totals, prefix and type statements with their binds, in order', async () => {
    const fake = makeFakeSql();
    const engine = new PostgresEngine();
    (engine as unknown as { _sql: unknown })._sql = fake.sql;
    await runDetect(engine, { sourceId: 'src-a', minPagesPerPrefix: 7, maxTypes: 9 });
    expect(fake.statements().map(s => ({ text: s.text, params: s.params }))).toEqual([
      { text: TOTALS, params: ['src-a'] },
      { text: PREFIXES, params: ['src-a', 7, 9] },
      { text: TYPES, params: ['src-a', 100] },
    ]);
  });
});
