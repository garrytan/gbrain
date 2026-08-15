/**
 * W0 fix-wave (Tier-1 #3, CONFIRMED) — re-embed upserts must carry
 * `modality`, or image chunks flip to modality='text' and the image search
 * arm (filter cc.modality='image') silently returns nothing.
 *
 * Pins two layers:
 *  1. carryChunkMetadata (the now-single shared field list) carries modality
 *     + all 8 code-metadata fields.
 *  2. The write-side contract that makes the carry load-bearing: upsertChunks
 *     OVERWRITES modality from EXCLUDED, so a merge built via
 *     carryChunkMetadata round-trips an image chunk intact, while a merge
 *     that omits the field (the pre-fix CLI behavior) demonstrably resets it.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { carryChunkMetadata } from '../src/core/embed-stale.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

test('carryChunkMetadata carries modality and all code-metadata fields', () => {
  const loaded = {
    modality: 'image' as const,
    language: 'ts',
    symbol_name: 'fn',
    symbol_type: 'function',
    start_line: 1,
    end_line: 10,
    parent_symbol_path: ['Mod'],
    doc_comment: 'doc',
    symbol_name_qualified: 'Mod.fn',
  };
  const base: ChunkInput = { chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' };
  const out = carryChunkMetadata(loaded, base);
  expect(out.modality).toBe('image');
  expect(out.language).toBe('ts');
  expect(out.symbol_name_qualified).toBe('Mod.fn');
  // Absent fields stay undefined, never null-through (DB rows can carry null
  // at runtime; the ?? undefined in the carry normalizes them).
  const sparse = carryChunkMetadata({}, base);
  expect(sparse.modality).toBeUndefined();
});

test('re-embed merge via carryChunkMetadata keeps an image chunk image', async () => {
  await engine.putPage('img-page', { type: 'note', title: 'img', compiled_truth: 'ocr text here', frontmatter: {} });
  await engine.upsertChunks('img-page', [
    { chunk_index: 0, chunk_text: 'ocr text here', chunk_source: 'compiled_truth', modality: 'image' },
  ]);

  // Simulate the embed --stale merge: load chunks, rebuild ChunkInputs, upsert.
  const loaded = await engine.getChunks('img-page');
  expect(loaded[0]!.modality).toBe('image');
  const merged = loaded.map(c => carryChunkMetadata(c, {
    chunk_index: c.chunk_index,
    chunk_text: c.chunk_text,
    chunk_source: c.chunk_source,
    token_count: c.token_count || 1,
  }));
  await engine.upsertChunks('img-page', merged);

  const after = await engine.getChunks('img-page');
  expect(after[0]!.modality).toBe('image');
});

test('write-side contract: omitting modality (pre-fix behavior) resets it to text', async () => {
  await engine.putPage('img-page-2', { type: 'note', title: 'img2', compiled_truth: 'more ocr', frontmatter: {} });
  await engine.upsertChunks('img-page-2', [
    { chunk_index: 0, chunk_text: 'more ocr', chunk_source: 'compiled_truth', modality: 'image' },
  ]);
  // The pre-fix CLI merge: field list without modality.
  await engine.upsertChunks('img-page-2', [
    { chunk_index: 0, chunk_text: 'more ocr', chunk_source: 'compiled_truth' },
  ]);
  const after = await engine.getChunks('img-page-2');
  // This assertion documents WHY the carry is load-bearing: the upsert
  // overwrites, so the omission class corrupts. If this ever flips to
  // COALESCE semantics, the carry (and this test) can be revisited.
  expect(after[0]!.modality).toBe('text');
});
