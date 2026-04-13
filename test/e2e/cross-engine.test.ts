/**
 * E2E Cross-engine Migration Tests
 *
 * Tests embedding and metadata round-trips between Postgres and PGLite.
 * Requires DATABASE_URL env var or .env.testing file.
 *
 * Run separately from mechanical tests:
 *   DATABASE_URL=... bun test test/e2e/cross-engine.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { Chunk } from '../../src/core/types.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

const testPage = {
  type: 'concept' as const,
  title: 'Migration Test',
  compiled_truth: '# Migration Test\nEmbedding round-trip test.',
  frontmatter: {},
};

const makeEmbedding = () => {
  const emb = new Float32Array(1536);
  emb[0] = 0.1; emb[1] = 0.2; emb[2] = 0.3; emb[3] = -0.5;
  emb[100] = 0.99; emb[1535] = -0.01;
  return emb;
};

function toChunkInput(c: Chunk) {
  return {
    chunk_index: c.chunk_index,
    chunk_text: c.chunk_text,
    chunk_source: c.chunk_source,
    embedding: c.embedding || undefined,
    model: c.model,
    token_count: c.token_count || undefined,
  };
}

describeE2E('E2E: Cross-engine migration', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  test('Postgres→PGLite embedding round-trip', async () => {
    const pg = getEngine();
    const embedding = makeEmbedding();

    await pg.putPage('test/migrate-to-pglite', testPage);
    await pg.upsertChunks('test/migrate-to-pglite', [
      { chunk_index: 0, chunk_text: 'Chunk zero', chunk_source: 'compiled_truth', embedding },
      { chunk_index: 1, chunk_text: 'Chunk one', chunk_source: 'compiled_truth', embedding: undefined },
    ]);

    const sourceChunks = await pg.getChunksWithEmbeddings('test/migrate-to-pglite');
    expect(sourceChunks.length).toBe(2);
    expect(sourceChunks[0].embedding).toBeInstanceOf(Float32Array);
    expect(sourceChunks[1].embedding).toBeNull();

    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    try {
      await pglite.putPage('test/migrate-to-pglite', testPage);
      await pglite.upsertChunks('test/migrate-to-pglite', sourceChunks.map(toChunkInput));

      const targetChunks = await pglite.getChunksWithEmbeddings('test/migrate-to-pglite');
      expect(targetChunks.length).toBe(2);

      const emb = targetChunks[0].embedding;
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb!.length).toBe(1536);
      expect(emb![0]).toBeCloseTo(0.1);
      expect(emb![1]).toBeCloseTo(0.2);
      expect(emb![3]).toBeCloseTo(-0.5);
      expect(emb![100]).toBeCloseTo(0.99);
      expect(emb![1535]).toBeCloseTo(-0.01);

      expect(targetChunks[1].embedding).toBeNull();
    } finally {
      await pglite.disconnect();
    }
  });

  test('PGLite→Postgres embedding round-trip', async () => {
    const embedding = makeEmbedding();

    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();

    let sourceChunks: Chunk[];
    try {
      await pglite.putPage('test/migrate-to-pg', testPage);
      await pglite.upsertChunks('test/migrate-to-pg', [
        { chunk_index: 0, chunk_text: 'Chunk from pglite', chunk_source: 'compiled_truth', embedding },
      ]);

      sourceChunks = await pglite.getChunksWithEmbeddings('test/migrate-to-pg');
      expect(sourceChunks.length).toBe(1);
      expect(sourceChunks[0].embedding).toBeInstanceOf(Float32Array);
    } finally {
      await pglite.disconnect();
    }

    const pg = getEngine();
    await pg.putPage('test/migrate-to-pg', testPage);
    await pg.upsertChunks('test/migrate-to-pg', sourceChunks!.map(toChunkInput));

    const targetChunks = await pg.getChunksWithEmbeddings('test/migrate-to-pg');
    expect(targetChunks.length).toBe(1);

    const emb = targetChunks[0].embedding;
    expect(emb).toBeInstanceOf(Float32Array);
    expect(emb!.length).toBe(1536);
    expect(emb![0]).toBeCloseTo(0.1);
    expect(emb![1]).toBeCloseTo(0.2);
    expect(emb![3]).toBeCloseTo(-0.5);
    expect(emb![100]).toBeCloseTo(0.99);
    expect(emb![1535]).toBeCloseTo(-0.01);
  });

  test('tags and timeline survive cross-engine migration', async () => {
    const pg = getEngine();

    await pg.putPage('test/migrate-meta', testPage);
    await pg.addTag('test/migrate-meta', 'tag-alpha');
    await pg.addTag('test/migrate-meta', 'tag-beta');
    await pg.addTimelineEntry('test/migrate-meta', {
      date: '2026-01-15',
      source: 'e2e-test',
      summary: 'Timeline survives migration',
    });

    const tags = await pg.getTags('test/migrate-meta');
    const timeline = await pg.getTimeline('test/migrate-meta');

    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    try {
      await pglite.putPage('test/migrate-meta', testPage);
      for (const tag of tags) await pglite.addTag('test/migrate-meta', tag);
      for (const entry of timeline) {
        await pglite.addTimelineEntry('test/migrate-meta', {
          date: entry.date,
          source: entry.source,
          summary: entry.summary,
          detail: entry.detail,
        });
      }

      const targetTags = await pglite.getTags('test/migrate-meta');
      expect(targetTags.sort()).toEqual(['tag-alpha', 'tag-beta']);

      const targetTimeline = await pglite.getTimeline('test/migrate-meta');
      expect(targetTimeline.length).toBe(1);
      expect(targetTimeline[0].summary).toBe('Timeline survives migration');
    } finally {
      await pglite.disconnect();
    }
  });
});
