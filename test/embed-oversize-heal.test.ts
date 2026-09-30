import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
/**
 * SUP-3874 — heal already-stored chunks that exceed the embedding input cap.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import {
  healOversizedChunks,
  healedChunksToStaleRows,
  healOversizedPageChunks,
} from '../src/core/embed-oversize-heal.ts';
import type { Chunk } from '../src/core/types.ts';
import { estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';
import { EMBED_INPUT_SAFETY } from '../src/core/embedding-input-limit.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

beforeEach(() => {
  resetGateway();
});

afterAll(() => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

const MXBAI_CAP = Math.floor(512 * EMBED_INPUT_SAFETY); // 307

function fatParagraph(n: number): string {
  const para =
    'The SuperAICoach SEO implementation plan covers technical setup, content calendars, schema markup, and local Philadelphia keyword clusters that must remain searchable after re-embedding. ';
  return Array.from({ length: n }, () => para).join('\n\n');
}

function chunkRow(overrides: Partial<Chunk>): Chunk {
  return {
    id: 1,
    page_id: 42,
    chunk_index: 0,
    chunk_text: 'body',
    chunk_source: 'compiled_truth',
    embedding: null,
    model: 'openai:text-embedding-3-large',
    token_count: 2,
    embedded_at: null,
    ...overrides,
  };
}

describe('healedChunksToStaleRows', () => {
  test('passes chunk_source through unchanged — fenced_code is NEVER coerced (D20-T4)', () => {
    const rows = healedChunksToStaleRows(
      [
        chunkRow({ chunk_index: 0, chunk_source: 'compiled_truth' }),
        chunkRow({ id: 2, chunk_index: 1, chunk_source: 'fenced_code' }),
        chunkRow({ id: 3, chunk_index: 2, chunk_source: 'timeline' }),
      ],
      'notes/some-page',
      'src-a',
    );
    expect(rows.map((r) => r.chunk_source)).toEqual(['compiled_truth', 'fenced_code', 'timeline']);
    for (const r of rows) {
      expect(r.slug).toBe('notes/some-page');
      expect(r.source_id).toBe('src-a');
    }
  });

  test('keeps only rows still needing embeddings (unembedded or NULL vector)', () => {
    const rows = healedChunksToStaleRows(
      [
        chunkRow({ chunk_index: 0, embedded_at: null }),
        chunkRow({ id: 2, chunk_index: 1, embedded_at: new Date(), embedding_is_null: false }),
        chunkRow({ id: 3, chunk_index: 2, embedded_at: new Date(), embedding_is_null: true }),
      ],
      'p',
      'default',
    );
    expect(rows.map((r) => r.chunk_index)).toEqual([0, 2]);
  });

  test('maps model/token_count to null when absent and returns [] for fully-embedded pages', () => {
    const rows = healedChunksToStaleRows(
      [chunkRow({ model: undefined as unknown as string, token_count: null })],
      'p',
      'default',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBeNull();
    expect(rows[0].token_count).toBeNull();
    expect(
      healedChunksToStaleRows(
        [chunkRow({ embedded_at: new Date(), embedding_is_null: false })],
        'p',
        'default',
      ),
    ).toEqual([]);
  });
});

describe('healOversizedChunks', () => {
  test('no-op when every chunk already fits', () => {
    const chunks = [
      { chunk_index: 0, chunk_text: 'short one', chunk_source: 'compiled_truth' as const, token_count: 2 },
      { chunk_index: 1, chunk_text: 'short two', chunk_source: 'compiled_truth' as const, token_count: 2 },
    ];
    const result = healOversizedChunks(chunks, MXBAI_CAP);
    expect(result.changed).toBe(false);
    expect(result.splitCount).toBe(0);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((c) => c.chunk_text)).toEqual(['short one', 'short two']);
  });

  test('splits only the oversized row and keeps siblings', () => {
    const oversized = fatParagraph(40);
    expect(estimateEmbedTokens(oversized)).toBeGreaterThan(MXBAI_CAP);

    const chunks = [
      { chunk_index: 0, chunk_text: 'lead-in', chunk_source: 'compiled_truth' as const, token_count: 2 },
      { chunk_index: 1, chunk_text: oversized, chunk_source: 'compiled_truth' as const, token_count: 5000 },
      { chunk_index: 2, chunk_text: 'closing', chunk_source: 'timeline' as const, token_count: 2 },
    ];
    const result = healOversizedChunks(chunks, MXBAI_CAP);
    expect(result.changed).toBe(true);
    expect(result.splitCount).toBe(1);
    expect(result.chunks.length).toBeGreaterThan(3);
    expect(result.chunks[0].chunk_text).toBe('lead-in');
    expect(result.chunks[result.chunks.length - 1].chunk_text).toBe('closing');
    expect(result.chunks[result.chunks.length - 1].chunk_source).toBe('timeline');
    for (const c of result.chunks) {
      expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(MXBAI_CAP);
      expect(c.chunk_index).toBe(result.chunks.indexOf(c));
    }
    // Split, not truncated: joined body of middle pieces still covers the original.
    const middle = result.chunks.slice(1, -1).map((c) => c.chunk_text).join('');
    expect(middle.length).toBeGreaterThanOrEqual(Math.floor(oversized.length * 0.9));
  });

  test('reindexes contiguously after a split', () => {
    const oversized = fatParagraph(40);
    const result = healOversizedChunks(
      [{ chunk_index: 7, chunk_text: oversized, chunk_source: 'compiled_truth' as const, token_count: null }],
      MXBAI_CAP,
    );
    expect(result.changed).toBe(true);
    expect(result.chunks.map((c) => c.chunk_index)).toEqual(
      result.chunks.map((_, i) => i),
    );
  });

  test('preserves modality and code metadata on every split piece', () => {
    const oversized = fatParagraph(40);
    const result = healOversizedChunks([{
      chunk_index: 0,
      chunk_text: oversized,
      chunk_source: 'fenced_code' as const,
      token_count: 5000,
      modality: 'image' as const,
      language: 'typescript',
      symbol_name: 'buildIndex',
      symbol_type: 'function',
      start_line: 10,
      end_line: 90,
      parent_symbol_path: ['SearchEngine'],
      doc_comment: 'Build the searchable index.',
      symbol_name_qualified: 'SearchEngine.buildIndex',
    }], MXBAI_CAP);

    expect(result.changed).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.modality).toBe('image');
      expect(chunk.language).toBe('typescript');
      expect(chunk.symbol_name).toBe('buildIndex');
      expect(chunk.symbol_type).toBe('function');
      expect(chunk.start_line).toBe(10);
      expect(chunk.end_line).toBe(90);
      expect(chunk.parent_symbol_path).toEqual(['SearchEngine']);
      expect(chunk.doc_comment).toBe('Build the searchable index.');
      expect(chunk.symbol_name_qualified).toBe('SearchEngine.buildIndex');
    }
  });
});

describe('healOversizedPageChunks with guarded database projections', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  async function seed(slug: string, body: string) {
    await engine.putPage(slug, { type: 'note', title: 'Example', compiled_truth: body });
    const prepared = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, prepared,
      [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { seal: true });
    return prepared.snapshot;
  }

  test('small chunks retain their stored identity and canonical revision', async () => {
    const snapshot = await seed('oversize-small', 'A short example.');
    const before = await engine.getChunks('oversize-small');
    const result = await healOversizedPageChunks(engine, 'oversize-small', { maxTokens: MXBAI_CAP });
    expect(result.changed).toBe(false);
    expect(result.chunks.map(c => c.id)).toEqual(before.map(c => c.id));
    expect((await engine.readPageSnapshot('oversize-small'))!.revision).toBe(snapshot.revision);
  });

  test('oversized chunks split atomically and remain readable under the same canonical revision', async () => {
    const snapshot = await seed('oversize-large', fatParagraph(40));
    const splits: number[] = [];
    const result = await healOversizedPageChunks(engine, 'oversize-large', { maxTokens: MXBAI_CAP, onSplit: n => splits.push(n) });
    expect(result.changed).toBe(true);
    expect(splits).toEqual([1]);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const c of result.chunks) expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(MXBAI_CAP);
    expect(await engine.getChunks('oversize-large', { requireSafeChunks: true })).toHaveLength(result.chunks.length);
    expect((await engine.readPageSnapshot('oversize-large'))!.revision).toBe(snapshot.revision);
  });
  // Stale-revision and same-revision/different-chunk races are exercised on
  // both real engines in page-projection-concurrency.test.ts.
});
