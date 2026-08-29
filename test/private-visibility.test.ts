/**
 * #4352 — page-level `visibility: private` enforcement for untrusted callers.
 *
 * Pages have persisted `frontmatter.visibility` forever, but no read path
 * enforced it: a remote/MCP caller could pull a private page through search,
 * recall's query arm, entity cards, and context_pack. Pins:
 *   - buildVisibilityClause emits the predicate only when excludePrivate
 *   - engines (PGLite here; SQL identical in postgres-engine — parity pinned
 *     by the shared buildVisibilityClause builder) filter private pages on
 *     searchKeyword / searchTitles / searchKeywordChunks when the flag is set
 *   - resolveExcludePrivatePages: trust rules + config gate + env hatch
 *   - recall (query arm) as a remote ctx hides private pages; local sees them
 *   - buildEntityCard (entity/context_pack/delta) hides private cards remotely
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import {
  resolveExcludePrivatePages,
  __resetPrivateVisibilityCacheForTests,
  REMOTE_PRIVATE_PAGES_KEY,
} from '../src/core/search/private-visibility.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/world-page', {
    title: 'Zebra Widget World',
    type: 'concept',
    frontmatter: { visibility: 'world' },
    compiled_truth: 'zebra widget public knowledge body',
    timeline: '',
  });
  await engine.putPage('notes/private-page', {
    title: 'Zebra Widget Private',
    type: 'concept',
    frontmatter: { visibility: 'private' },
    compiled_truth: 'zebra widget secret private knowledge body',
    timeline: '',
  });
  // No visibility key at all → defaults to world (visible everywhere).
  await engine.putPage('notes/unmarked-page', {
    title: 'Zebra Widget Unmarked',
    type: 'concept',
    frontmatter: {},
    compiled_truth: 'zebra widget unmarked knowledge body',
    timeline: '',
  });
  // putPage doesn't chunk; the keyword/chunk arms search content_chunks.
  for (const [slug, body] of [
    ['notes/world-page', 'zebra widget public knowledge body'],
    ['notes/private-page', 'zebra widget secret private knowledge body'],
    ['notes/unmarked-page', 'zebra widget unmarked knowledge body'],
  ] as const) {
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('buildVisibilityClause (#4352)', () => {
  test('default: no private predicate (pre-fix SQL preserved byte-for-byte)', () => {
    const clause = buildVisibilityClause('p', 's');
    expect(clause).not.toContain('visibility');
    expect(clause).toContain('p.deleted_at IS NULL');
  });

  test('excludePrivate: adds the COALESCE predicate', () => {
    const clause = buildVisibilityClause('p', 's', { excludePrivate: true });
    expect(clause).toContain(`COALESCE(p.frontmatter->>'visibility', 'world') <> 'private'`);
  });
});

describe('engine search paths honor excludePrivate (#4352)', () => {
  for (const method of ['searchKeyword', 'searchTitles', 'searchKeywordChunks'] as const) {
    test(`${method}: private page hidden with flag, visible without`, async () => {
      const withFlag = await engine[method]('zebra widget', { limit: 20, excludePrivate: true });
      const withoutFlag = await engine[method]('zebra widget', { limit: 20 });
      const slugsWith = withFlag.map((r) => r.slug);
      const slugsWithout = withoutFlag.map((r) => r.slug);
      expect(slugsWith).not.toContain('notes/private-page');
      expect(slugsWith).toContain('notes/world-page');
      // Absent visibility defaults to world — still visible under the flag.
      expect(slugsWith).toContain('notes/unmarked-page');
      // Trusted path unchanged: private page still retrievable.
      expect(slugsWithout).toContain('notes/private-page');
    });
  }
});

describe('resolveExcludePrivatePages gate (#4352)', () => {
  test('trusted local (remote === false) never excludes', async () => {
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, false)).toBe(false);
  });

  test('remote/undefined excludes by default (fail-closed)', async () => {
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(true);
    expect(await resolveExcludePrivatePages(engine, undefined)).toBe(true);
  });

  test('config opt-out disables enforcement', async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(false);
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(true);
  });

  test('GBRAIN_REMOTE_PRIVATE_PAGES=1 env escape hatch disables enforcement', async () => {
    __resetPrivateVisibilityCacheForTests();
    await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
      expect(await resolveExcludePrivatePages(engine, true)).toBe(false);
    });
  });
});

describe('recall query arm (#4352)', () => {
  function mkCtx(remote: boolean) {
    return {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote,
      sourceId: 'default',
    } as never;
  }

  test('remote recall with query hides private pages; local sees them', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['recall'];
    // Test env strips provider keys → keyword-only search arm.
    const remoteOut = (await op.handler(mkCtx(true), { query: 'zebra widget' })) as {
      results: Array<{ slug: string }>;
    };
    const remoteSlugs = (remoteOut.results ?? []).map((r) => r.slug);
    expect(remoteSlugs).not.toContain('notes/private-page');
    expect(remoteSlugs).toContain('notes/world-page');

    const localOut = (await op.handler(mkCtx(false), { query: 'zebra widget' })) as {
      results: Array<{ slug: string }>;
    };
    const localSlugs = (localOut.results ?? []).map((r) => r.slug);
    expect(localSlugs).toContain('notes/private-page');
  });
});

describe('entity card (#4352 — covers entity/context_pack/delta)', () => {
  test('remote card lookup cannot resolve a private page', async () => {
    __resetPrivateVisibilityCacheForTests();
    const remoteRes = await buildEntityCard(engine, 'default', 'Zebra Widget Private', { remote: true });
    expect(remoteRes.found ? remoteRes.card?.entity.slug : null).not.toBe('notes/private-page');

    const localRes = await buildEntityCard(engine, 'default', 'Zebra Widget Private', { remote: false });
    expect(localRes.found).toBe(true);
    expect(localRes.card?.entity.slug).toBe('notes/private-page');
  });
});

describe('page read ops (#4352 remediation — list_pages / get_page / fetch)', () => {
  function mkCtx(remote: boolean) {
    return {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote,
      sourceId: 'default',
    } as never;
  }

  test('list_pages: remote listing omits private pages; local enumerates them', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['list_pages'];
    const remoteRows = (await op.handler(mkCtx(true), { limit: 100 })) as Array<{ slug: string }>;
    const remoteSlugs = remoteRows.map((r) => r.slug);
    expect(remoteSlugs).not.toContain('notes/private-page');
    expect(remoteSlugs).toContain('notes/world-page');
    // Absent visibility defaults to world — still listed remotely.
    expect(remoteSlugs).toContain('notes/unmarked-page');

    const localRows = (await op.handler(mkCtx(false), { limit: 100 })) as Array<{ slug: string }>;
    expect(localRows.map((r) => r.slug)).toContain('notes/private-page');
  });

  test('get_page: remote read of a private page is page_not_found; local reads the body', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_page'];
    await expect(op.handler(mkCtx(true), { slug: 'notes/private-page' })).rejects.toThrow(/Page not found/);
    // No over-blocking: world pages stay readable remotely.
    const world = (await op.handler(mkCtx(true), { slug: 'notes/world-page' })) as { slug: string };
    expect(world.slug).toBe('notes/world-page');

    const local = (await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as { compiled_truth: string };
    expect(local.compiled_truth).toContain('secret');
  });

  test('get_page fuzzy: remote fuzzy resolution cannot surface a private page; local can', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_page'];
    await expect(
      op.handler(mkCtx(true), { slug: 'notes/private-pag', fuzzy: true }),
    ).rejects.toThrow(/Page not found/);

    const local = (await op.handler(mkCtx(false), { slug: 'notes/private-pag', fuzzy: true })) as { slug: string };
    expect(local.slug).toBe('notes/private-page');
  });

  test('fetch: remote fetch of a private page is page_not_found; local returns full text', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['fetch'];
    await expect(op.handler(mkCtx(true), { id: 'notes/private-page' })).rejects.toThrow(/Page not found/);

    const local = (await op.handler(mkCtx(false), { id: 'notes/private-page' })) as { text: string };
    expect(local.text).toContain('secret');
  });

  test('config opt-out restores remote reads on all three ops', async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      const got = (await operationsByName['get_page'].handler(mkCtx(true), { slug: 'notes/private-page' })) as { slug: string };
      expect(got.slug).toBe('notes/private-page');
      const rows = (await operationsByName['list_pages'].handler(mkCtx(true), { limit: 100 })) as Array<{ slug: string }>;
      expect(rows.map((r) => r.slug)).toContain('notes/private-page');
      const fetched = (await operationsByName['fetch'].handler(mkCtx(true), { id: 'notes/private-page' })) as { id: string };
      expect(fetched.id).toBe('notes/private-page');
    } finally {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});

describe('sibling read ops (#4352 remediation — no bypass around get_page)', () => {
  function mkCtx(remote: boolean) {
    return {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote,
      sourceId: 'default',
    } as never;
  }

  beforeAll(async () => {
    // Edges in both directions so get_links / get_backlinks / traverse_graph
    // each have a private endpoint to leak.
    await engine.addLink('notes/world-page', 'notes/private-page', 'seen with', 'related_to');
    await engine.addLink('notes/private-page', 'notes/world-page', 'refers to', 'related_to');
    await engine.addLink('notes/world-page', 'notes/unmarked-page', 'also', 'related_to');
    await engine.addTimelineEntry('notes/private-page', {
      date: '2026-08-01', source: 'test', summary: 'secret meeting happened',
    });
    await engine.createVersion('notes/private-page');
    await engine.putRawData('notes/private-page', 'crustdata', { secret: true });
  });

  test('get_chunks: private page reads as missing ([]) remotely; local + world unaffected', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_chunks'];
    expect((await op.handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[]).toEqual([]);
    expect(((await op.handler(mkCtx(true), { slug: 'notes/world-page' })) as unknown[]).length).toBeGreaterThan(0);
    expect(((await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as unknown[]).length).toBeGreaterThan(0);
  });

  test('get_versions: private page history reads as missing ([]) remotely; local sees it', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_versions'];
    expect((await op.handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[]).toEqual([]);
    expect(((await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as unknown[]).length).toBeGreaterThan(0);
  });

  test('get_timeline: private page timeline reads as missing ([]) remotely; local sees it', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_timeline'];
    expect((await op.handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[]).toEqual([]);
    const local = (await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as Array<{ summary: string }>;
    expect(local.map((e) => e.summary)).toContain('secret meeting happened');
  });

  test('get_raw_data: private page raw data reads as missing ([]) remotely; local sees it', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_raw_data'];
    expect((await op.handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[]).toEqual([]);
    expect(((await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as unknown[]).length).toBeGreaterThan(0);
  });

  test('resolve_slugs: remote resolution never returns a private slug; local does', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['resolve_slugs'];
    // Exact-slug arm: the strongest oracle — must read as no-match remotely.
    expect((await op.handler(mkCtx(true), { partial: 'notes/private-page' })) as string[]).toEqual([]);
    expect((await op.handler(mkCtx(false), { partial: 'notes/private-page' })) as string[]).toEqual(['notes/private-page']);
    // Fuzzy arm: private slugs must not be enumerable via trigram candidates.
    const fuzzy = (await op.handler(mkCtx(true), { partial: 'Zebra Widget' })) as string[];
    expect(fuzzy).not.toContain('notes/private-page');
    expect(fuzzy).toContain('notes/world-page');
  });

  test('get_links: edges to a private endpoint are dropped remotely; a private page reads as missing', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_links'];
    const remote = (await op.handler(mkCtx(true), { slug: 'notes/world-page' })) as Array<{ to_slug: string }>;
    expect(remote.map((l) => l.to_slug)).not.toContain('notes/private-page');
    expect(remote.map((l) => l.to_slug)).toContain('notes/unmarked-page');
    expect((await op.handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[]).toEqual([]);
    const local = (await op.handler(mkCtx(false), { slug: 'notes/world-page' })) as Array<{ to_slug: string }>;
    expect(local.map((l) => l.to_slug)).toContain('notes/private-page');
  });

  test('get_backlinks: edges from a private page are dropped remotely; world backlinks survive', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['get_backlinks'];
    const remote = (await op.handler(mkCtx(true), { slug: 'notes/world-page' })) as Array<{ from_slug: string }>;
    expect(remote.map((l) => l.from_slug)).not.toContain('notes/private-page');
    const unmarked = (await op.handler(mkCtx(true), { slug: 'notes/unmarked-page' })) as Array<{ from_slug: string }>;
    expect(unmarked.map((l) => l.from_slug)).toContain('notes/world-page');
    const local = (await op.handler(mkCtx(false), { slug: 'notes/world-page' })) as Array<{ from_slug: string }>;
    expect(local.map((l) => l.from_slug)).toContain('notes/private-page');
  });

  test('traverse_graph (node shape): private nodes + edges to them are stripped remotely', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['traverse_graph'];
    const remote = (await op.handler(mkCtx(true), { slug: 'notes/world-page' })) as Array<{
      slug: string; links: Array<{ to_slug: string }>;
    }>;
    expect(remote.map((n) => n.slug)).not.toContain('notes/private-page');
    for (const node of remote) {
      expect(node.links.map((l) => l.to_slug)).not.toContain('notes/private-page');
    }
    const local = (await op.handler(mkCtx(false), { slug: 'notes/world-page' })) as Array<{ slug: string }>;
    expect(local.map((n) => n.slug)).toContain('notes/private-page');
  });

  test('traverse_graph: a private start page reads as missing ([]) remotely', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['traverse_graph'];
    expect((await op.handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[]).toEqual([]);
    expect(((await op.handler(mkCtx(false), { slug: 'notes/private-page' })) as unknown[]).length).toBeGreaterThan(0);
  });

  test('traverse_graph (path shape): paths touching a private slug are dropped remotely', async () => {
    __resetPrivateVisibilityCacheForTests();
    const op = operationsByName['traverse_graph'];
    const remote = (await op.handler(mkCtx(true), { slug: 'notes/world-page', direction: 'out' })) as Array<{
      from_slug: string; to_slug: string;
    }>;
    const touched = remote.flatMap((e) => [e.from_slug, e.to_slug]);
    expect(touched).not.toContain('notes/private-page');
    expect(touched).toContain('notes/unmarked-page');
    const local = (await op.handler(mkCtx(false), { slug: 'notes/world-page', direction: 'out' })) as Array<{
      from_slug: string; to_slug: string;
    }>;
    expect(local.flatMap((e) => [e.from_slug, e.to_slug])).toContain('notes/private-page');
  });

  test('config opt-out restores remote reads on the sibling ops', async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      const chunks = (await operationsByName['get_chunks'].handler(mkCtx(true), { slug: 'notes/private-page' })) as unknown[];
      expect(chunks.length).toBeGreaterThan(0);
      const resolved = (await operationsByName['resolve_slugs'].handler(mkCtx(true), { partial: 'notes/private-page' })) as string[];
      expect(resolved).toEqual(['notes/private-page']);
    } finally {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});

describe('shared private predicate lives once (#4352 remediation)', () => {
  test('entity-card composes privatePagesFilterFragment instead of hand-rolling the predicate', () => {
    // test-reads-source-ok: structural "lives ONCE" guard — a duplicated predicate behaves identically until visibility semantics drift, so only the text can catch it (#4352)
    const src = readFileSync(join(import.meta.dir, '../src/core/verbs/entity-card.ts'), 'utf8');
    expect(src).toContain('privatePagesFilterFragment');
    // The predicate TEXT must not be duplicated — silent drift risk if
    // visibility semantics ever change (sql-ranking.ts's "lives ONCE" claim).
    expect(src).not.toMatch(/frontmatter->>\s*'visibility'/);
  });
});
