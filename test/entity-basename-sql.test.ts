/**
 * The exact-basename lookup and the retirement hop (engine-sql/entity-reads.ts `findExactBasenameCandidates`,
 * `readRetirementHop`) send the statements entities/resolve.ts sent through executeRaw, byte for byte.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends the statement its resolver step built (the hop with `retiredPageSql('p')` inlined and
 *    an empty privacy slot) and the parameters in the same order, so PGLite and Postgres run the same SQL as before.
 *    `followRetirement` with a privacy fragment still builds the same text with the fragment in that slot.
 *  - Regression: an edit to `retiredPageSql` that the member does not follow, or a hop text that drifts from the
 *    privacy-aware copy in resolve.ts, would make the two hop paths disagree on which page is retired.
 *  - Why existing coverage misses it: the SQL-text golden records whatever the member says; nothing ties it to the
 *    text the resolver built before the move.
 *  - Seam: a recording executor stands in for the engine; the statements are never run here.
 */
import { describe, expect, test } from 'bun:test';
import { findExactBasenameCandidates, readRetirementHop } from '../src/core/engine-sql/entity-reads.ts';
import { followRetirement, retiredPageSql } from '../src/core/entities/resolve.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const BASENAME = `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`;

/** The hop as `followRetirement` wrote it before the move, with `privacy` in its slot. */
const hop = (privacy: string) => `SELECT p.slug, p.type, ${retiredPageSql('p')} AS retired,
              COALESCE(NULLIF(btrim(p.frontmatter->>'superseded_by'), ''), NULLIF(btrim(p.frontmatter->>'merged_into'), '')) AS target
         FROM pages p
        WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL ${privacy}
        LIMIT 1`;

function recorder(rows: unknown[] = []) {
  const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
  return { sent, exec: { executeRaw: async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return rows; } } };
}

describe('exact-basename and retirement-hop SQL', () => {
  test('findExactBasenameCandidates sends the basename statement and returns the slugs', async () => {
    const { sent, exec } = recorder([{ slug: 'people/alice-example' }]);
    const slugs = ['people/alice-example', 'concepts/alice-example'];
    expect(await findExactBasenameCandidates(exec as never, 'default', slugs)).toEqual(['people/alice-example']);
    expect(sent).toEqual([{ sql: BASENAME, params: ['default', slugs] }]);
  });

  test('readRetirementHop sends the hop with an empty privacy slot, and null on no row', async () => {
    const { sent, exec } = recorder();
    expect(await readRetirementHop(exec as never, 'default', 'people/alice-example')).toBeNull();
    expect(sent).toEqual([{ sql: hop(''), params: ['default', 'people/alice-example'] }]);
  });

  test('followRetirement with a privacy fragment keeps the raw hop with the fragment in the slot', async () => {
    const { sent, exec } = recorder([{ slug: 'people/alice-example', type: 'person', retired: false, target: null }]);
    const engine = { ...exec, readRetirementHop: async () => { throw new Error('the typed hop ran'); } } as unknown as BrainEngine;
    const privacy = 'AND NOT p.private';
    expect(await followRetirement(engine, 'default', 'people/alice-example', privacy)).toEqual({ slug: 'people/alice-example', type: 'person' });
    expect(sent).toEqual([{ sql: hop(privacy), params: ['default', 'people/alice-example'] }]);
  });
});
