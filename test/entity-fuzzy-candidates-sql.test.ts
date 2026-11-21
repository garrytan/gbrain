/**
 * The fuzzy entity lookup's statement (engine-sql/entity-reads.ts `findFuzzyEntityCandidates`) is the one
 * entities/resolve.ts `tryFuzzyMatch` sent through executeRaw, byte for byte.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member sends the statement `tryFuzzyMatch` built (with `retiredPageSql('pages')` inlined) and the
 *    parameters in the same order, so PGLite and Postgres run the same SQL as before the move.
 *  - Regression: an edit to `retiredPageSql` that the spelled-out constant does not follow would let the fuzzy tier
 *    read retired pages again (or skip live ones) while every other resolver tier keeps the new rule.
 *  - Why existing coverage misses it: the SQL-text golden records whatever the constant says; nothing ties it to the
 *    builder the constant copies.
 *  - Seam: a recording executor stands in for the engine; the statement is never run here.
 */
import { describe, expect, test } from 'bun:test';
import { findFuzzyEntityCandidates } from '../src/core/engine-sql/entity-reads.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';

/** The statement as `tryFuzzyMatch` wrote it before the move. */
const BUILT = `SELECT slug, title, type,
         GREATEST(
           similarity(lower(title), $2),
           similarity(slug, $3)
         ) AS score
       FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND NOT ${retiredPageSql('pages')}
         AND (
           lower(title) % $2
           OR slug ILIKE '%' || $3 || '%'
         )
       ORDER BY score DESC, slug ASC
       LIMIT 5`;

describe('findFuzzyEntityCandidates SQL', () => {
  test('sends the statement tryFuzzyMatch built, with its parameters in order', async () => {
    const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const exec = { executeRaw: async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return []; } };
    const rows = await findFuzzyEntityCandidates(exec as never, 'default', 'alice exampel', 'alice-exampel');
    expect(rows).toEqual([]);
    expect(sent).toEqual([{ sql: BUILT, params: ['default', 'alice exampel', 'alice-exampel'] }]);
  });
});
