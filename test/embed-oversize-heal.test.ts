/**
 * SUP-3874 — heal already-stored chunks that exceed the embedding input cap.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
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

describe('healOversizedPageChunks (load → split → upsert → reload orchestrator)', () => {
  test('no-op path: every chunk fits → returns the loaded chunks, never calls upsertChunks', async () => {
    const existing = [
      chunkRow({ chunk_index: 0, chunk_text: 'fits fine' }),
      chunkRow({ id: 2, chunk_index: 1, chunk_text: 'also fits' }),
    ];
    const methodCalls: string[] = [];
    const engine = {
      getChunks: async () => {
        methodCalls.push('getChunks');
        return existing;
      },
      upsertChunks: async () => {
        methodCalls.push('upsertChunks');
      },
    };

    const onSplitCalls: number[] = [];
    const res = await healOversizedPageChunks(engine as never, 'notes/fits', {
      maxTokens: MXBAI_CAP,
      onSplit: (n) => onSplitCalls.push(n),
    });

    expect(res.changed).toBe(false);
    expect(res.splitCount).toBe(0);
    // The SAME loaded array comes back — no reload, no write, no onSplit.
    expect(res.chunks).toBe(existing);
    expect(methodCalls).toEqual(['getChunks']);
    expect(onSplitCalls).toEqual([]);
  });

  test('changed path: fires onSplit(n), upserts split pieces scoped to the source, returns the RELOADED chunks', async () => {
    const oversized = fatParagraph(40);
    const initial = [chunkRow({ chunk_index: 0, chunk_text: oversized, token_count: 5000 })];
    const reloaded = [
      chunkRow({ chunk_index: 0, chunk_text: 'reloaded piece one' }),
      chunkRow({ id: 2, chunk_index: 1, chunk_text: 'reloaded piece two' }),
    ];
    let getCalls = 0;
    const getOptsSeen: unknown[] = [];
    let upserted: Array<{ chunk_text: string }> | undefined;
    let upsertOpts: unknown;
    const engine = {
      getChunks: async (_slug: string, opts?: unknown) => {
        getCalls++;
        getOptsSeen.push(opts);
        // Read 1 = snapshot, read 2 = the freshness-guard recheck (must match
        // the snapshot or the heal skips), read 3 = the post-upsert reload.
        return getCalls <= 2 ? initial : reloaded;
      },
      upsertChunks: async (_slug: string, chunks: Array<{ chunk_text: string }>, opts?: unknown) => {
        upserted = chunks;
        upsertOpts = opts;
      },
    };

    const onSplitCalls: number[] = [];
    const res = await healOversizedPageChunks(engine as never, 'notes/fat', {
      sourceId: 'src-a',
      maxTokens: MXBAI_CAP,
      onSplit: (n) => onSplitCalls.push(n),
    });

    expect(onSplitCalls).toEqual([1]);
    expect(res.changed).toBe(true);
    expect(res.splitCount).toBe(1);
    // The result is the RE-LOADED chunk list (post-upsert DB truth), not the
    // in-memory split — callers feed it to healedChunksToStaleRows.
    expect(res.chunks).toBe(reloaded);
    // The upsert received the split pieces, each within the cap.
    expect(upserted).toBeDefined();
    expect(upserted!.length).toBeGreaterThan(1);
    for (const c of upserted!) {
      expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(MXBAI_CAP);
    }
    // All three reads (snapshot, freshness recheck, reload) and the write
    // stay scoped to the caller's source.
    expect(getOptsSeen).toEqual([{ sourceId: 'src-a' }, { sourceId: 'src-a' }, { sourceId: 'src-a' }]);
    expect(upsertOpts).toEqual({ sourceId: 'src-a' });
  });

  test('freshness guard: a concurrent rewrite between snapshot and write skips the heal (no clobber)', async () => {
    const oversized = fatParagraph(40);
    const initial = [chunkRow({ chunk_index: 0, chunk_text: oversized, token_count: 5000 })];
    // Simulate a sync import rewriting the page mid-heal: the recheck sees a
    // different chunk set. Upserting the stale splits would silently desync
    // chunk_text from the page content — the guard must skip instead.
    const rewritten = [chunkRow({ chunk_index: 0, chunk_text: 'fresh synced content' })];
    let getCalls = 0;
    let upsertCalled = false;
    const engine = {
      getChunks: async () => (++getCalls === 1 ? initial : rewritten),
      upsertChunks: async () => {
        upsertCalled = true;
      },
    };

    const onSplitCalls: number[] = [];
    const res = await healOversizedPageChunks(engine as never, 'notes/racing', {
      maxTokens: MXBAI_CAP,
      onSplit: (n) => onSplitCalls.push(n),
    });

    expect(upsertCalled).toBe(false);
    expect(onSplitCalls).toEqual([]);
    expect(res.changed).toBe(false);
    // The caller gets the FRESH rows, so the drain proceeds on current truth.
    expect(res.chunks).toBe(rewritten);
  });
});
