/**
 * Multi-source search visibility regression tests.
 *
 * Default search should follow the upstream sources contract: federated sources
 * are visible in cross-source search; isolated sources are only visible when
 * explicitly named, or when the caller asks for all sources.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

const openAiEnvName = 'OPENAI_API_' + 'KEY';
let engine: PGLiteEngine;
let savedOpenAiEnvValue: string | undefined;

async function insertSearchablePage(sourceId: string, slug: string, token: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
     VALUES ($1, $2, $3, $4, $5, '', '{}'::jsonb, $6)`,
    [
      sourceId,
      slug,
      `visibility-${sourceId}`,
      `Visibility ${sourceId}`,
      `${token} compiled truth for ${sourceId}`,
      `${sourceId}-${slug}`,
    ],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
     SELECT id, 0, $1, 'compiled_truth'
       FROM pages
      WHERE source_id = $2 AND slug = $3`,
    [`${token} chunk body for ${sourceId}`, sourceId, slug],
  );
}

beforeAll(async () => {
  savedOpenAiEnvValue = process.env[openAiEnvName];
  delete process.env[openAiEnvName];

  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();

  await runSources(engine, ['add', 'federated-src', '--federated']);
  await runSources(engine, ['add', 'isolated-src', '--no-federated']);

  await insertSearchablePage('default', 'visibility/default-page', 'visibilitytoken');
  await insertSearchablePage('federated-src', 'visibility/federated-page', 'visibilitytoken');
  await insertSearchablePage('isolated-src', 'visibility/isolated-page', 'visibilitytoken');
}, 60_000);

afterAll(async () => {
  if (savedOpenAiEnvValue === undefined) {
    delete process.env[openAiEnvName];
  } else {
    process.env[openAiEnvName] = savedOpenAiEnvValue;
  }
  await engine.disconnect();
}, 60_000);

describe('multi-source search visibility', () => {
  test('default keyword search excludes isolated sources and includes federated sources', async () => {
    const results = await engine.searchKeyword('visibilitytoken', { limit: 10 });
    const sourceIds = results.map(r => r.source_id).sort();

    expect(sourceIds).toContain('default');
    expect(sourceIds).toContain('federated-src');
    expect(sourceIds).not.toContain('isolated-src');
  });

  test('explicit sourceId restricts keyword search to that source', async () => {
    const results = await engine.searchKeyword('visibilitytoken', { limit: 10, sourceId: 'isolated-src' });
    expect(results.map(r => r.source_id)).toEqual(['isolated-src']);
  });

  test('__all__ sourceId includes isolated sources for explicit audit/debug use', async () => {
    const results = await engine.searchKeyword('visibilitytoken', { limit: 10, sourceId: '__all__' });
    const sourceIds = results.map(r => r.source_id).sort();

    expect(sourceIds).toContain('default');
    expect(sourceIds).toContain('federated-src');
    expect(sourceIds).toContain('isolated-src');
  });

  test('hybrid query path preserves default source visibility', async () => {
    const results = await hybridSearch(engine, 'visibilitytoken', { limit: 10, expansion: false });
    const sourceIds = results.map(r => r.source_id).sort();

    expect(sourceIds).toContain('default');
    expect(sourceIds).toContain('federated-src');
    expect(sourceIds).not.toContain('isolated-src');
  });

  test('hybrid query path can explicitly include isolated sources', async () => {
    const results = await hybridSearch(engine, 'visibilitytoken', {
      limit: 10,
      expansion: false,
      sourceId: '__all__',
      dedupOpts: { maxTypeRatio: 1 },
    });
    const sourceIds = results.map(r => r.source_id).sort();

    expect(sourceIds).toContain('default');
    expect(sourceIds).toContain('federated-src');
    expect(sourceIds).toContain('isolated-src');
  });
});
