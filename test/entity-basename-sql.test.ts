/**
 * The exact-basename lookup (engine-sql/entity-reads.ts `findExactBasenameCandidates`) sends the statement
 * entities/resolve.ts sent through executeRaw, byte for byte. The retirement hop's text is pinned with the privacy
 * variants in test/engine-sql-caller-raw-sql-pins.test.ts and test/engine-parity/entity-reads.test.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the member sends the statement its resolver step built and the parameters in the same order, so PGLite
 *    and Postgres run the same SQL as before.
 *  - Regression: a basename text that drifts from the one the resolver built would change which slugs a reference
 *    resolves to.
 *  - Why existing coverage misses it: the SQL-text golden records whatever the member says; nothing ties it to the
 *    text the resolver built before the move.
 *  - Seam: a recording executor stands in for the engine; the statements are never run here.
 */
import { describe, expect, test } from 'bun:test';
import { findExactBasenameCandidates } from '../src/core/engine-sql/entity-reads.ts';

const BASENAME = `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`;

function recorder(rows: unknown[] = []) {
  const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
  return { sent, exec: { executeRaw: async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return rows; } } };
}

describe('exact-basename SQL', () => {
  test('findExactBasenameCandidates sends the basename statement and returns the slugs', async () => {
    const { sent, exec } = recorder([{ slug: 'people/alice-example' }]);
    const slugs = ['people/alice-example', 'concepts/alice-example'];
    expect(await findExactBasenameCandidates(exec as never, 'default', slugs)).toEqual(['people/alice-example']);
    expect(sent).toEqual([{ sql: BASENAME, params: ['default', slugs] }]);
  });
});
