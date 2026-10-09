/**
 * Executes the actual PostgreSQL SQL on isolated PGLite fixtures. Protects
 * eligibility before the bound, term coverage, page diversity, and payload.
 * A title/ID-only pool or a pre-filter cap loses the late multi-term page.
 * Earlier planner recording tests cannot detect these result regressions.
 * Uses the production SQL builder without a new testing seam.
 */
import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { buildRelaxedKeywordSql } from '../src/core/postgres-engine/relaxed-keyword.ts';

test('eligible multi-term evidence survives a broad pool and a long page', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE sources (id text PRIMARY KEY, archived boolean);
      CREATE TABLE pages (id int PRIMARY KEY, slug text, title text, type text,
        source_id text, effective_date timestamptz, effective_date_source text,
        frontmatter jsonb DEFAULT '{}', deleted_at timestamptz);
      CREATE TABLE content_chunks (id int PRIMARY KEY, page_id int, chunk_index int,
        chunk_text text, chunk_source text, modality text, language text, search_vector tsvector);
      INSERT INTO sources VALUES ('allowed', false), ('foreign', false);
      INSERT INTO pages (id, slug, title, type, source_id)
        SELECT i, 'noise/' || i, 'Unrelated', 'note', 'allowed' FROM generate_series(1, 5000) i;
      INSERT INTO content_chunks SELECT i, i, 0, 'alpha', 'body', 'text', 'en', to_tsvector('english', 'alpha')
        FROM generate_series(1, 5000) i;
      INSERT INTO pages (id, slug, title, type, source_id) VALUES
        (0, 'long', 'Unrelated', 'note', 'allowed'),
        (7000, 'hidden', 'Unrelated', 'note', 'allowed'),
        (8000, 'foreign', 'Unrelated', 'note', 'foreign'),
        (9000, 'late-evidence', 'Unrelated', 'note', 'allowed');
      UPDATE pages SET deleted_at = now() WHERE id = 7000;
      INSERT INTO content_chunks SELECT 10000+i, 0, i, 'alpha', 'body', 'text', 'en', to_tsvector('english', 'alpha')
        FROM generate_series(1, 5000) i;
      INSERT INTO content_chunks SELECT 20000+i, 7000, i, 'alpha beta', 'body', 'text', 'en', to_tsvector('english', 'alpha beta')
        FROM generate_series(1, 5000) i;
      INSERT INTO content_chunks SELECT 30000+i, 8000, i, 'alpha beta', 'body', 'text', 'en', to_tsvector('english', 'alpha beta')
        FROM generate_series(1, 5000) i;
      INSERT INTO content_chunks VALUES
        (90000, 9000, 0, 'alpha beta alpha beta', 'body', 'text', 'en', to_tsvector('english', 'alpha beta alpha beta'));
    `);
    const sql = buildRelaxedKeywordSql({ ftsLanguage: 'english',
      pageWhere: "AND p.source_id = 'allowed' AND p.deleted_at IS NULL AND NOT s.archived",
      chunkWhere: "AND cc.language = 'en'", sourceFactorCase: '1.0',
      innerLimitParam: '$2', limitParam: '$3', offsetParam: '$4' });
    const result = await db.query<{ slug: string; chunk_id: number; chunk_text: string; score: number }>(
      sql, ['alpha OR beta OR gamma', 150, 50, 0]);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]?.slug).toBe('late-evidence');
    expect(result.rows[0]?.chunk_id).toBe(90000);
    expect(result.rows[0]?.chunk_text).toBe('alpha beta alpha beta');
    expect(result.rows[0]?.score).toBeGreaterThan(result.rows[1]!.score);
    expect(result.rows.some(row => ['hidden', 'foreign'].includes(row.slug))).toBe(false);
    const candidates = sql.slice(0, sql.indexOf(', ranked_chunks AS (')) + ' SELECT * FROM eligible_candidates';
    const pool = await db.query<{ page_id: number }>(candidates, ['alpha OR beta OR gamma']);
    expect(pool.rows).toHaveLength(4096);
    expect(pool.rows.filter(row => row.page_id === 0)).toHaveLength(1);
    expect(pool.rows.some(row => row.page_id === 9000)).toBe(true);
    // This is a bounded recall approximation, not an exact top-k algorithm.
    // A single matched term ties coverage across more than 4096 pages; a
    // later page with higher term frequency can fall outside that pool.
    const singleTerm = await db.query<{ slug: string }>(sql, ['alpha OR gamma', 150, 50, 0]);
    expect(singleTerm.rows.some(row => row.slug === 'late-evidence')).toBe(false);
  } finally { await db.close(); }
}, 60_000);
