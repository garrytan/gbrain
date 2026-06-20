import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { reconcileStructure, DERIVED_PATH_SOURCE, MAX_STRUCTURAL_CHILDREN, STRUCTURE_PREFIX } from '../src/core/structure-reconcile.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('deterministic structural reconciliation', () => {
  test('dry-run reports the hierarchy without writing', async () => {
    await engine.putPage('docs/guide', {
      type: 'note', title: 'Guide', compiled_truth: 'guide', frontmatter: {},
    });
    const result = await reconcileStructure(engine, { dryRun: true });
    expect(result.structural_pages_planned).toBeGreaterThan(0);
    expect(result.edges_planned).toBeGreaterThan(0);
    expect(result.structural_pages_written).toBe(0);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM links WHERE link_source = $1`,
      [DERIVED_PATH_SOURCE],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  test('connects a top-level README to its source root', async () => {
    await engine.putPage('readme', {
      type: 'note', title: 'Root README', compiled_truth: 'root', frontmatter: {},
    });
    await reconcileStructure(engine);
    expect((await engine.getHealth()).orphan_pages).toBe(0);
  });
  test('connects every page, remains acyclic, and is state-idempotent', async () => {
    for (const slug of ['docs/readme', 'docs/guide', 'docs/deep/topic', 'notes/one']) {
      await engine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: slug, frontmatter: {},
      });
    }
    const first = await reconcileStructure(engine);
    expect(first.max_degree).toBeLessThanOrEqual(MAX_STRUCTURAL_CHILDREN);
    expect((await engine.getHealth()).orphan_pages).toBe(0);
    const before = await engine.executeRaw<{ edge: string }>(
      `SELECT f.slug || '>' || t.slug AS edge
         FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_source=$1 ORDER BY edge`,
      [DERIVED_PATH_SOURCE],
    );
    await reconcileStructure(engine);
    const after = await engine.executeRaw<{ edge: string }>(
      `SELECT f.slug || '>' || t.slug AS edge
         FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_source=$1 ORDER BY edge`,
      [DERIVED_PATH_SOURCE],
    );
    expect(after).toEqual(before);
    const cycles = await engine.executeRaw<{ count: number }>(
      `WITH RECURSIVE walk(start_id, id, depth) AS (
         SELECT from_page_id, to_page_id, 1 FROM links WHERE link_source=$1
         UNION ALL
         SELECT w.start_id, l.to_page_id, w.depth+1 FROM walk w
         JOIN links l ON l.from_page_id=w.id AND l.link_source=$1 WHERE w.depth < 32
       ) SELECT count(*)::int AS count FROM walk WHERE start_id=id`,
      [DERIVED_PATH_SOURCE],
    );
    expect(Number(cycles[0].count)).toBe(0);
  });

  test('caps a flat source with deterministic buckets', async () => {
    for (let i = 0; i < 150; i++) {
      await engine.putPage(`page-${String(i).padStart(3, '0')}`, {
        type: 'note', title: `Page ${i}`, compiled_truth: `content ${i}`, frontmatter: {},
      });
    }
    const result = await reconcileStructure(engine);
    expect(result.max_degree).toBeLessThanOrEqual(MAX_STRUCTURAL_CHILDREN);
    const bucketCount = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM pages
        WHERE deleted_at IS NULL AND frontmatter->>'structural_kind'='bucket'`,
    );
    expect(Number(bucketCount[0].count)).toBeGreaterThan(0);
    expect((await engine.getHealth()).orphan_pages).toBe(0);
  });

  test('a scoped run does not write a global page outside its source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('source-a', 'source-a', '/fake/source-a', '{}'::jsonb, NOW())`,
    );
    await engine.putPage('docs/guide', {
      type: 'note', title: 'Guide', compiled_truth: 'guide', frontmatter: {},
    }, { sourceId: 'source-a' });

    await reconcileStructure(engine, { sourceIds: ['source-a'] });

    const globalPages = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM pages
        WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL`,
      [`${STRUCTURE_PREFIX}/structure`],
    );
    expect(Number(globalPages[0].count)).toBe(0);
    const staleGenerated = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM pages
        WHERE frontmatter->>'generated_by'=$1
          AND (links_extracted_at IS NULL OR links_extracted_at < updated_at)`,
      [DERIVED_PATH_SOURCE],
    );
    expect(Number(staleGenerated[0].count)).toBe(0);
  });
  test('a scoped run preserves another source hierarchy', async () => {
    for (const sourceId of ['source-a', 'source-b']) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES ($1, $1, $2, '{}'::jsonb, NOW())`,
        [sourceId, `/fake/${sourceId}`],
      );
      await engine.putPage('docs/guide', {
        type: 'note', title: `${sourceId} guide`, compiled_truth: sourceId, frontmatter: {},
      }, { sourceId });
    }

    await reconcileStructure(engine);
    const before = await engine.executeRaw<{ edge: string }>(
      `SELECT f.source_id || ':' || f.slug || '>' || t.source_id || ':' || t.slug AS edge
         FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_source=$1 AND (f.source_id='source-b' OR t.source_id='source-b') ORDER BY edge`,
      [DERIVED_PATH_SOURCE],
    );

    await engine.putPage('docs/new', {
      type: 'note', title: 'Source A new page', compiled_truth: 'new', frontmatter: {},
    }, { sourceId: 'source-a' });
    await reconcileStructure(engine, { sourceIds: ['source-a'] });

    const after = await engine.executeRaw<{ edge: string }>(
      `SELECT f.source_id || ':' || f.slug || '>' || t.source_id || ':' || t.slug AS edge
         FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_source=$1 AND (f.source_id='source-b' OR t.source_id='source-b') ORDER BY edge`,
      [DERIVED_PATH_SOURCE],
    );
    expect(after).toEqual(before);
    const sourceBGenerated = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM pages
        WHERE source_id='source-b' AND deleted_at IS NULL AND frontmatter->>'generated_by'=$1`,
      [DERIVED_PATH_SOURCE],
    );
    expect(Number(sourceBGenerated[0].count)).toBeGreaterThan(0);
  });
});
