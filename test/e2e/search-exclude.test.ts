/**
 * Hard-Exclude E2E
 *
 * Verifies the exclude_slug_prefixes / include_slug_prefixes plumbing.
 * test/, attachments/, .raw/ are hard-excluded by default.
 * archive/ is NOT excluded (issue #1777) — it is demoted (0.5x) so it stays
 * findable by default but ranks below curated content. include_slug_prefixes
 * opts back into the genuinely-excluded prefixes.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { ChunkInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.putPage('test/fixtures/widget', {
    type: 'note',
    title: 'Widget test fixture',
    compiled_truth: 'widget test fixture for the test suite',
    timeline: '',
  });
  await engine.upsertChunks('test/fixtures/widget', [
    {
      chunk_index: 0,
      chunk_text: 'widget test fixture for the test suite',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(11),
      token_count: 8,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('archive/old-stuff/widget-2020', {
    type: 'note',
    title: 'Widget 2020',
    compiled_truth: 'widget archived from 2020',
    timeline: '',
  });
  await engine.upsertChunks('archive/old-stuff/widget-2020', [
    {
      chunk_index: 0,
      chunk_text: 'widget archived from 2020 — stale info about widget',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(12),
      token_count: 8,
    },
  ] satisfies ChunkInput[]);

  await engine.putPage('concepts/widget-pattern', {
    type: 'concept',
    title: 'Widget Pattern',
    compiled_truth: 'the widget pattern is a useful design pattern',
    timeline: '',
  });
  await engine.upsertChunks('concepts/widget-pattern', [
    {
      chunk_index: 0,
      chunk_text: 'the widget pattern is a useful widget design pattern',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(13),
      token_count: 9,
    },
  ] satisfies ChunkInput[]);

  // A genuinely-excluded prefix that stays hidden by default (locks "only
  // archive moved" — test/, attachments/, .raw/ are unchanged).
  await engine.putPage('.raw/widget-dump', {
    type: 'note',
    title: 'Widget raw dump',
    compiled_truth: 'widget raw sidecar dump',
    timeline: '',
  });
  await engine.upsertChunks('.raw/widget-dump', [
    {
      chunk_index: 0,
      chunk_text: 'widget raw sidecar dump noise',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(14),
      token_count: 5,
    },
  ] satisfies ChunkInput[]);

  // A term that appears in NO other page, only in an archive page. Proves
  // archive is reachable even when it is the ONLY match (issue #1777).
  await engine.putPage('archive/2019/quokkanaut-memo', {
    type: 'note',
    title: 'Quokkanaut memo',
    compiled_truth: 'the quokkanaut project shipped in 2019',
    timeline: '',
  });
  await engine.upsertChunks('archive/2019/quokkanaut-memo', [
    {
      chunk_index: 0,
      chunk_text: 'the quokkanaut project shipped in 2019',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(15),
      token_count: 6,
    },
  ] satisfies ChunkInput[]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('searchKeyword default hard-excludes', () => {
  test('test/ pages are hidden by default', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('test/fixtures/widget');
  });

  test('.raw/ pages stay hidden by default (only archive moved)', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('.raw/widget-dump');
  });

  test('archive/ pages ARE returned by default (issue #1777)', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('archive/old-stuff/widget-2020');
  });

  test('archive/ is demoted below curated content (keyword ordering)', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    const archiveIdx = slugs.indexOf('archive/old-stuff/widget-2020');
    const conceptsIdx = slugs.indexOf('concepts/widget-pattern');
    expect(archiveIdx).toBeGreaterThanOrEqual(0); // present
    expect(conceptsIdx).toBeGreaterThanOrEqual(0);
    // concepts/ (boost 1.3) ranks ABOVE archive/ (boost 0.5).
    expect(conceptsIdx).toBeLessThan(archiveIdx);
  });

  test('archive is reachable even when it is the ONLY match (unique phrase)', async () => {
    const results = await engine.searchKeyword('quokkanaut');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('archive/2019/quokkanaut-memo');
  });

  test('curated content is unaffected', async () => {
    const results = await engine.searchKeyword('widget');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('concepts/widget-pattern');
  });
});

describe('searchKeyword include_slug_prefixes opt-back-in', () => {
  test('include_slug_prefixes: ["test/"] surfaces test pages', async () => {
    const results = await engine.searchKeyword('widget', {
      include_slug_prefixes: ['test/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('test/fixtures/widget');
    // .raw/ is still excluded.
    expect(slugs).not.toContain('.raw/widget-dump');
  });

  test('include_slug_prefixes opts back into multiple excluded prefixes', async () => {
    const results = await engine.searchKeyword('widget', {
      include_slug_prefixes: ['test/', '.raw/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('test/fixtures/widget');
    expect(slugs).toContain('.raw/widget-dump');
  });
});

describe('searchVector hard-excludes', () => {
  test('test/ pages are excluded by default in vector search', async () => {
    const results = await engine.searchVector(basisEmbedding(11));
    // basisEmbedding(11) is the closest direction to test/fixtures/widget,
    // so without exclude it would be at top. With default exclude, it's gone.
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain('test/fixtures/widget');
  });

  test('archive/ pages ARE returned by default in vector search (#1777)', async () => {
    // basisEmbedding(12) points at archive/old-stuff/widget-2020.
    const results = await engine.searchVector(basisEmbedding(12));
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('archive/old-stuff/widget-2020');
  });

  test('include_slug_prefixes lets it back in', async () => {
    const results = await engine.searchVector(basisEmbedding(11), {
      include_slug_prefixes: ['test/'],
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('test/fixtures/widget');
  });
});

describe('hybridSearch (the real user/MCP surface)', () => {
  test('archive/ is returned by default through hybridSearch', async () => {
    // No embedding provider in this hermetic run, so hybridSearch's vector path
    // is skipped and it exercises keyword + dedup + post-fusion. archive/ must
    // still come back by default (it is no longer hard-excluded).
    const results = await hybridSearch(engine, 'widget', { limit: 20 });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('archive/old-stuff/widget-2020');
    // test/ and .raw/ stay hidden through the full pipeline.
    expect(slugs).not.toContain('test/fixtures/widget');
    expect(slugs).not.toContain('.raw/widget-dump');
  });
});

describe('caller-supplied exclude_slug_prefixes (additive)', () => {
  test('caller can add a custom exclude prefix on top of defaults', async () => {
    const results = await engine.searchKeyword('widget', {
      exclude_slug_prefixes: ['concepts/'],
    });
    const slugs = results.map(r => r.slug);
    // concepts/ now also excluded on top of the defaults (test/, .raw/).
    expect(slugs).not.toContain('concepts/widget-pattern');
    expect(slugs).not.toContain('test/fixtures/widget');
    expect(slugs).not.toContain('.raw/widget-dump');
    // archive/ is NOT a default exclude and was not caller-excluded, so it
    // remains visible (issue #1777).
    expect(slugs).toContain('archive/old-stuff/widget-2020');
  });
});
