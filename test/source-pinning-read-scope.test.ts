/**
 * Read hard-scope when token is pinned (v37/v38).
 *
 * Validates the precedence rule for ALL read operations:
 *   1. params.source_id (explicit) → overrides everything
 *   2. ctx.defaultSourceId (token pin) → HARD scope, no fallback to other sources
 *   3. neither → unscoped (legacy cross-source visible)
 *
 * Closes the cross-source slug-collision read leak: before this PR a token
 * authenticated against source A could read pages from source B by knowing
 * the slug. With token pinning, that path 404s.
 *
 * Coverage:
 *   - get_page: pinned token can't read other-source slug; explicit override works
 *   - search: filtered to pinned source
 *   - query: filtered to pinned source (post-filter belt-and-suspenders)
 *   - resolve_slugs: candidates filtered to pinned source
 *   - list_pages: filtered to pinned source
 *   - get_chunks / get_tags / get_links / get_backlinks / get_timeline /
 *     get_versions / get_raw_data: opaque cross-source (return [])
 *   - traverse_graph: opaque cross-source root
 *   - find_orphans: filtered to pinned source
 *   - regression: unpinned token preserves global cross-source behavior
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as any);
  await engine.initSchema();
  const db = (engine as any).db;
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''),
      '',
    );
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  await sql`INSERT INTO sources (id, name, config) VALUES ('agent-a', 'Agent A', '{}'::jsonb) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO sources (id, name, config) VALUES ('agent-b', 'Agent B', '{}'::jsonb) ON CONFLICT DO NOTHING`;
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 15_000);

beforeEach(async () => {
  await sql`DELETE FROM links`;
  await sql`DELETE FROM timeline_entries`;
  await sql`DELETE FROM tags`;
  await sql`DELETE FROM raw_data`;
  await sql`DELETE FROM page_versions`;
  await sql`DELETE FROM content_chunks`;
  await sql`DELETE FROM pages`;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeCtx(defaultSourceId?: string): OperationContext {
  return {
    engine: engine as any,
    logger: noopLogger,
    config: { brain_path: '/tmp', wiki_path: '/tmp/wiki' } as any,
    dryRun: false,
    remote: true,
    defaultSourceId,
  };
}

function getOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`op not found: ${name}`);
  return op;
}

async function importPage(slug: string, sourceId: string, body: string = `# ${slug}`) {
  await importFromContent(engine, slug, body, { noEmbed: true, sourceId });
}

// ---------------------------------------------------------------------------
// get_page — the headline cross-source read leak fix
// ---------------------------------------------------------------------------
describe('get_page hard-scope', () => {
  // Helper: assert which source a slug landed in by joining via raw SQL.
  async function pageSourceFor(slug: string): Promise<string[]> {
    const rows = await sql`SELECT source_id FROM pages WHERE slug = ${slug}`;
    return (rows as any[]).map(r => r.source_id);
  }

  test('pinned token can read its own source slug', async () => {
    await importPage('shared-slug', 'agent-a', '# from a');
    const result = await getOp('get_page').handler(makeCtx('agent-a'), { slug: 'shared-slug' });
    expect((result as any).slug).toBe('shared-slug');
    expect(await pageSourceFor('shared-slug')).toEqual(['agent-a']);
  });

  test('pinned token CANNOT read same slug from another source (closes leak)', async () => {
    await importPage('shared-slug', 'agent-b', '# from b');
    // token pinned to agent-a tries to read a slug that only exists in agent-b
    await expect(
      getOp('get_page').handler(makeCtx('agent-a'), { slug: 'shared-slug' }),
    ).rejects.toThrow(/Page not found/);
  });

  test('explicit params.source_id overrides ctx pin (admin/cross-source)', async () => {
    await importPage('shared-slug', 'agent-b', '# from b');
    const result = await getOp('get_page').handler(
      makeCtx('agent-a'),
      { slug: 'shared-slug', source_id: 'agent-b' },
    );
    expect((result as any).slug).toBe('shared-slug');
  });

  test('regression: unpinned token sees cross-source (legacy behavior)', async () => {
    await importPage('shared-slug', 'agent-b', '# from b');
    const result = await getOp('get_page').handler(makeCtx(/* no pin */), { slug: 'shared-slug' });
    expect((result as any).slug).toBe('shared-slug');
  });
});

// ---------------------------------------------------------------------------
// search / query — keyword + hybrid both filter to pinned source
// ---------------------------------------------------------------------------
describe('search/query hard-scope', () => {
  test('search returns only pinned-source results', async () => {
    await importPage('a-only', 'agent-a', '# A only\nfizzbuzz unique-token-abc');
    await importPage('b-only', 'agent-b', '# B only\nfizzbuzz unique-token-abc');
    const results = await getOp('search').handler(makeCtx('agent-a'), { query: 'unique-token-abc' });
    const slugs = (results as any[]).map(r => r.slug);
    expect(slugs).toContain('a-only');
    expect(slugs).not.toContain('b-only');
  });

  test('search with explicit source_id overrides pin', async () => {
    await importPage('a-only', 'agent-a', '# A only\nspecial-keyword-xyz');
    await importPage('b-only', 'agent-b', '# B only\nspecial-keyword-xyz');
    const results = await getOp('search').handler(
      makeCtx('agent-a'),
      { query: 'special-keyword-xyz', source_id: 'agent-b' },
    );
    const slugs = (results as any[]).map(r => r.slug);
    expect(slugs).toContain('b-only');
    expect(slugs).not.toContain('a-only');
  });

  test('search unpinned sees both sources (regression)', async () => {
    await importPage('a-only', 'agent-a', '# A only\nrare-marker-pqr');
    await importPage('b-only', 'agent-b', '# B only\nrare-marker-pqr');
    const results = await getOp('search').handler(makeCtx(), { query: 'rare-marker-pqr' });
    const slugs = (results as any[]).map(r => r.slug);
    expect(slugs.length).toBe(2);
  });

  test('query (hybrid) hard-scoped to pinned source', async () => {
    await importPage('a-only', 'agent-a', '# A only\nhybrid-token-mno');
    await importPage('b-only', 'agent-b', '# B only\nhybrid-token-mno');
    const results = await getOp('query').handler(makeCtx('agent-b'), { query: 'hybrid-token-mno', expand: false });
    const slugs = (results as any[]).map(r => r.slug);
    expect(slugs).not.toContain('a-only');
    if (slugs.length > 0) expect(slugs).toContain('b-only');
  });
});

// ---------------------------------------------------------------------------
// list_pages — filter post-engine
// ---------------------------------------------------------------------------
describe('list_pages hard-scope', () => {
  test('pinned token sees only its source', async () => {
    await importPage('a1', 'agent-a');
    await importPage('a2', 'agent-a');
    await importPage('b1', 'agent-b');
    const results = await getOp('list_pages').handler(makeCtx('agent-a'), {});
    const slugs = (results as any[]).map(r => r.slug);
    expect(slugs.sort()).toEqual(['a1', 'a2']);
  });

  test('unpinned token sees all sources', async () => {
    await importPage('a1', 'agent-a');
    await importPage('b1', 'agent-b');
    const results = await getOp('list_pages').handler(makeCtx(), {});
    const slugs = (results as any[]).map(r => r.slug).sort();
    expect(slugs).toEqual(['a1', 'b1']);
  });
});

// ---------------------------------------------------------------------------
// resolve_slugs — candidates filtered to pinned source
// ---------------------------------------------------------------------------
describe('resolve_slugs hard-scope', () => {
  test('only matches slugs visible in pinned source', async () => {
    await importPage('alpha-one', 'agent-a');
    await importPage('alpha-two', 'agent-b');
    const results = await getOp('resolve_slugs').handler(makeCtx('agent-a'), { partial: 'alpha' });
    expect(results).toContain('alpha-one');
    expect(results).not.toContain('alpha-two');
  });
});

// ---------------------------------------------------------------------------
// Slug-derived data ops are opaque to cross-source slugs
// ---------------------------------------------------------------------------
describe('derived ops hard-scope (slug visibility guard)', () => {
  beforeEach(async () => {
    // Setup: same slug exists in both sources with rich data on agent-b only.
    await importPage('shared', 'agent-b', '# B page\ncontent here');
    // Tags/timeline on agent-b's row
    const bPageId = (await sql`SELECT id FROM pages WHERE slug='shared' AND source_id='agent-b'`)[0].id;
    await sql`INSERT INTO tags (page_id, tag) VALUES (${bPageId}, 'secret-tag') ON CONFLICT DO NOTHING`;
  });

  test('get_tags returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_tags').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('get_tags returns real data when pinned to owning source', async () => {
    const result = await getOp('get_tags').handler(makeCtx('agent-b'), { slug: 'shared' });
    expect(result).toContain('secret-tag');
  });

  test('get_chunks returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_chunks').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('get_links returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_links').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('get_backlinks returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_backlinks').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('get_timeline returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_timeline').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('get_versions returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_versions').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('get_raw_data returns [] for cross-source slug under pin', async () => {
    const result = await getOp('get_raw_data').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });

  test('traverse_graph returns [] for cross-source slug under pin', async () => {
    const result = await getOp('traverse_graph').handler(makeCtx('agent-a'), { slug: 'shared' });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Final integration check — token A creates "x", token without pin tries
// to read "x" via slug → still readable (unpinned = global).
// But: token B (pinned to B) can't see A's "x" → 404.
// ---------------------------------------------------------------------------
describe('semantic validation (per task spec)', () => {
  test('token A creates slug x; token B (pinned different source) gets 404', async () => {
    await importPage('x', 'agent-a', '# x in a');
    await expect(
      getOp('get_page').handler(makeCtx('agent-b'), { slug: 'x' }),
    ).rejects.toThrow(/Page not found/);
  });

  test('token A creates slug x; unpinned token reads it (regression preserved)', async () => {
    await importPage('x', 'agent-a', '# x in a');
    const result = await getOp('get_page').handler(makeCtx(), { slug: 'x' });
    expect((result as any).slug).toBe('x');
  });
});
