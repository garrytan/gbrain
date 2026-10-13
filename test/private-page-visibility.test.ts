import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import {
  __resetPrivateVisibilityCacheForTests,
  REMOTE_PRIVATE_PAGES_KEY,
  resolveExcludePrivatePages,
} from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;

function ctx(remote: boolean) {
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
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, visibility, body] of [
    ['notes/world', 'world', 'zebra widget public body'],
    ['notes/private', 'private', 'zebra widget secret body'],
    ['notes/unmarked', undefined, 'zebra widget unmarked body'],
  ] as const) {
    await engine.putPage(slug, {
      title: slug,
      type: 'concept',
      frontmatter: visibility ? { visibility } : {},
      compiled_truth: body,
      timeline: '',
    });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('remote private-page visibility contract', () => {
  test('SQL filter is opt-in so trusted local reads keep their existing behavior', () => {
    expect(buildVisibilityClause('p', 's')).not.toContain("COALESCE(p.frontmatter->>'visibility', 'world') <> 'private'");
    expect(buildVisibilityClause('p', 's', { excludePrivate: true }))
      .toContain("COALESCE(p.frontmatter->>'visibility', 'world') <> 'private'");
  });

  test('remote callers exclude private pages by default; local callers do not', async () => {
    __resetPrivateVisibilityCacheForTests();
    expect(await resolveExcludePrivatePages(engine, true)).toBe(true);
    expect(await resolveExcludePrivatePages(engine, undefined)).toBe(true);
    expect(await resolveExcludePrivatePages(engine, false)).toBe(false);
  });

  test('keyword, title and chunk search hide private pages only when requested', async () => {
    for (const method of ['searchKeyword', 'searchTitles', 'searchKeywordChunks'] as const) {
      const hidden = await engine[method]('zebra widget', { limit: 20, excludePrivate: true });
      const trusted = await engine[method]('zebra widget', { limit: 20 });
      expect(hidden.map(row => row.slug)).not.toContain('notes/private');
      expect(hidden.map(row => row.slug)).toContain('notes/world');
      expect(hidden.map(row => row.slug)).toContain('notes/unmarked');
      expect(trusted.map(row => row.slug)).toContain('notes/private');
    }
  });

  test('remote list/get/chunks/slug resolution cannot bypass the private-page boundary', async () => {
    __resetPrivateVisibilityCacheForTests();
    const remoteRows = await operationsByName.list_pages.handler(ctx(true), { limit: 100 }) as Array<{ slug: string }>;
    expect(remoteRows.map(row => row.slug)).not.toContain('notes/private');
    await expect(operationsByName.get_page.handler(ctx(true), { slug: 'notes/private' }))
      .rejects.toThrow(/Page not found/);
    expect(await operationsByName.get_chunks.handler(ctx(true), { slug: 'notes/private' })).toEqual([]);
    expect(await operationsByName.resolve_slugs.handler(ctx(true), { partial: 'notes/private' })).toEqual([]);

    const localRows = await operationsByName.list_pages.handler(ctx(false), { limit: 100 }) as Array<{ slug: string }>;
    expect(localRows.map(row => row.slug)).toContain('notes/private');
    expect((await operationsByName.get_chunks.handler(ctx(false), { slug: 'notes/private' }) as unknown[]).length)
      .toBeGreaterThan(0);
  });

  test('explicit compatibility opt-out restores remote reads without changing data', async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      expect(await resolveExcludePrivatePages(engine, true)).toBe(false);
      const page = await operationsByName.get_page.handler(ctx(true), { slug: 'notes/private' }) as { slug: string };
      expect(page.slug).toBe('notes/private');
    } finally {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});
