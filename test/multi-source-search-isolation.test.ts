/**
 * Regression test for multi-source search isolation.
 *
 * v0.18.0 advertised "Cross-source search is opt-in per source
 * (federated=true) so isolated content never bleeds into your main
 * brain", but every search path (search, query, hybridSearch, both
 * engines' searchKeyword/searchVector) ran across every page row
 * regardless of the caller's resolved source.
 *
 * This test fails on master (the unscoped engine returns rows from
 * isolated sources) and passes once `source_ids` is plumbed through
 * SearchOpts and the WHERE clauses + the operation handler resolves
 * the default scope (current source UNION federated) before calling
 * the engine.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resolveSearchScope } from '../src/core/source-scope.ts';

let engine: PGLiteEngine;

const SLUG_DEFAULT = 'topics/iso-default';
const SLUG_FEDERATED = 'topics/iso-federated';
const SLUG_ISOLATED = 'topics/iso-isolated';
const TOKEN = 'isolation-canary-token';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();

  // Two extra sources alongside the seeded `default` source: one
  // federated, one explicitly isolated.
  await runSources(engine, ['add', 'fed-src', '--federated']);
  await runSources(engine, ['add', 'iso-src', '--no-federated']);

  // Each source gets a page whose body contains the same canary token
  // so a single FTS query matches all three. The point of the test is
  // not the search ranking, it is which source_ids show up in results.
  for (const [src, slug, label] of [
    ['default', SLUG_DEFAULT, 'default'],
    ['fed-src', SLUG_FEDERATED, 'federated'],
    ['iso-src', SLUG_ISOLATED, 'isolated'],
  ] as const) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
       VALUES ($1, $2, 'concept', $3, $4, '', '{}'::jsonb, $5)`,
      [src, slug, `Iso ${label}`, `${label} body containing ${TOKEN}`, `hash-${src}`],
    );
    // Search needs at least one content_chunks row so the JOIN matches.
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
       SELECT id, 0, $1, 'compiled_truth' FROM pages WHERE source_id = $2 AND slug = $3`,
      [`${label} body containing ${TOKEN}`, src, slug],
    );
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('search isolation — engine layer honors source_ids', () => {
  test('searchKeyword without source_ids returns every source (unscoped baseline)', async () => {
    const rows = await engine.searchKeyword(TOKEN, { limit: 50 });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toContain(SLUG_DEFAULT);
    expect(slugs).toContain(SLUG_FEDERATED);
    expect(slugs).toContain(SLUG_ISOLATED);
  });

  test('searchKeyword with source_ids=[default,fed-src] excludes the isolated source', async () => {
    const rows = await engine.searchKeyword(TOKEN, {
      limit: 50,
      source_ids: ['default', 'fed-src'],
    });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toContain(SLUG_DEFAULT);
    expect(slugs).toContain(SLUG_FEDERATED);
    expect(slugs).not.toContain(SLUG_ISOLATED);
  });

  test('searchKeyword with source_ids=[iso-src] returns only the isolated source', async () => {
    const rows = await engine.searchKeyword(TOKEN, {
      limit: 50,
      source_ids: ['iso-src'],
    });
    const slugs = rows.map(r => r.slug);
    expect(slugs).toEqual([SLUG_ISOLATED]);
  });

  test('searchKeyword with empty source_ids array falls back to no filter', async () => {
    // Empty array is treated the same as undefined — the scope is the
    // operation layer's job, not the engine's. The engine's job is to
    // honor a non-empty list verbatim.
    const rows = await engine.searchKeyword(TOKEN, { limit: 50, source_ids: [] });
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toContain(SLUG_ISOLATED);
  });
});

describe('resolveSearchScope — default scope is current source + federated', () => {
  test('explicit list wins verbatim, federated sources are NOT merged in', async () => {
    const scope = await resolveSearchScope(engine, ['fed-src']);
    expect(scope).toEqual(['fed-src']);
  });

  test('null/undefined scope resolves to default source + every federated source', async () => {
    // No --source flag, no GBRAIN_SOURCE, no dotfile → resolveSourceId
    // falls through to the seeded `default` source. Plus fed-src is
    // federated. Plus default itself is federated by migration v16.
    // iso-src must NOT appear.
    const scope = await resolveSearchScope(engine, null);
    expect(scope).toContain('default');
    expect(scope).toContain('fed-src');
    expect(scope).not.toContain('iso-src');
  });

  test('rejects malformed explicit ids without hitting the database', async () => {
    await expect(resolveSearchScope(engine, ['bad source!'])).rejects.toThrow(/Invalid source id/);
  });
});
