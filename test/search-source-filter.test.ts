/**
 * Source filter on `search` and `query` (engine layer + op handler).
 *
 * SearchOpts.sourceId existed in types since v0.18 but the engine bodies
 * (searchKeyword, searchVector, searchKeywordChunks) never extracted it.
 * Engine wired through to op layer for the search/query --source CLI flag
 * requested in issue #784. Tests cover both engine WHERE behavior and the
 * op-level unknown-source validation path.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();

  // Register two sources beyond `default`. The default row is auto-seeded.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('wiki', 'wiki', '{}'::jsonb), ('diary', 'diary', '{}'::jsonb)`,
  );

  // Distinct slugs across sources so the searchKeyword DISTINCT ON (slug)
  // dedup doesn't collapse cross-source hits. The user-facing dedup
  // contract is intentionally slug-grain — out of scope for this test.
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, source_id, title, compiled_truth)
       VALUES ('wiki-alpha',  'concept', 'wiki',  'wiki-alpha',  'unicornium is a fictional metal'),
              ('diary-gamma', 'concept', 'diary', 'diary-gamma', 'unicornium meeting on the patio'),
              ('wiki-beta',   'concept', 'wiki',  'wiki-beta',   'unrelated content here')`,
  );

  // Manually emit chunk + tsvector rows so searchKeyword has something to
  // rank. We embed nothing — sourceId filter is the only behavior under test.
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, search_vector, modality)
       SELECT p.id, 0, p.compiled_truth, 'compiled_truth',
              to_tsvector('english', p.compiled_truth), 'text'
         FROM pages p`,
  );
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('engine.searchKeyword honors opts.sourceId', () => {
  test('no sourceId returns matches across sources', async () => {
    const results = await engine.searchKeyword('unicornium', { limit: 10 });
    const sourceIds = new Set(results.map(r => r.source_id));
    expect(sourceIds.has('wiki')).toBe(true);
    expect(sourceIds.has('diary')).toBe(true);
  });

  test('sourceId=wiki restricts to wiki only', async () => {
    const results = await engine.searchKeyword('unicornium', { limit: 10, sourceId: 'wiki' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source_id).toBe('wiki');
    }
  });

  test('sourceId=diary restricts to diary only', async () => {
    const results = await engine.searchKeyword('unicornium', { limit: 10, sourceId: 'diary' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source_id).toBe('diary');
    }
  });

  test('sourceId pointing at unregistered id returns empty (engine has no validation)', async () => {
    // Engine doesn't validate — that's the op layer's job. WHERE just yields 0.
    const results = await engine.searchKeyword('unicornium', { limit: 10, sourceId: 'nope' });
    expect(results.length).toBe(0);
  });
});

describe('search op handler validates source via listSources', () => {
  const searchOp = operations.find(o => o.name === 'search');

  test('search op exposes `source` param', () => {
    expect(searchOp).toBeDefined();
    expect(searchOp!.params.source).toBeDefined();
    expect(searchOp!.params.source!.type).toBe('string');
  });

  test('unknown source throws OperationError(unknown_source)', async () => {
    expect(searchOp).toBeDefined();
    const ctx = { engine, config: {}, remote: false } as never;
    await expect(
      searchOp!.handler(ctx, { query: 'unicornium', source: 'made-up-source' }),
    ).rejects.toThrow(OperationError);
  });

  test('registered source resolves and filters', async () => {
    const ctx = { engine, config: {}, remote: false } as never;
    const results = await searchOp!.handler(ctx, { query: 'unicornium', source: 'wiki' }) as Array<{ source_id: string }>;
    for (const r of results) expect(r.source_id).toBe('wiki');
  });
});

describe('query op exposes source param', () => {
  test('query op exposes `source` param', () => {
    const queryOp = operations.find(o => o.name === 'query');
    expect(queryOp).toBeDefined();
    expect(queryOp!.params.source).toBeDefined();
    expect(queryOp!.params.source!.type).toBe('string');
  });
});
