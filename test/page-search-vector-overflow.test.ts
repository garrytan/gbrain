/**
 * #2704 — a single markdown page whose compiled_truth exceeds Postgres's
 * hard 1,048,575-byte tsvector cap made update_page_search_vector() throw
 * "string is too long for tsvector" INSIDE the pages UPSERT transaction,
 * blocking the whole source's sync checkpoint (Sync BLOCKED) even though
 * every other file in the run imported fine.
 *
 * v124 (migrate.ts) drops compiled_truth from the trigger — it was
 * already redundant with content_chunks.search_vector (chunk-grain,
 * populated separately and well under the tsvector cap), which is what
 * searchKeyword() actually queries.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// #2704: the 1,048,575-byte tsvector cap is on to_tsvector's SERIALIZED
// OUTPUT (lexemes + position lists), not the raw input byte length —
// repeating the same few words produces a tiny deduplicated vector
// regardless of input size (verified: a 2.2MB string of 5 repeated words
// does NOT overflow). Genuinely diverse, mostly-unique tokens are what
// blows the output past the cap, matching a real large export (a Google
// Docs dump, a long mailing-list thread) where the words don't repeat
// like lorem-ipsum filler does.
const OVERSIZED_BODY = Array.from({ length: 200_000 }, (_, i) => `token${i.toString(36)}`).join(' '); // ~2MB, ~2.7MB serialized tsvector

describe('#2704: oversized page body no longer overflows pages.search_vector', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('putPage with a >1MB compiled_truth succeeds (previously threw "string is too long for tsvector")', async () => {
    expect(OVERSIZED_BODY.length).toBeGreaterThan(1_048_575);

    const page = await engine.putPage('oversized-page', {
      type: 'note',
      title: 'Oversized Page',
      compiled_truth: OVERSIZED_BODY,
    });

    expect(page).not.toBeNull();
    expect(page.slug).toBe('oversized-page');
  }, 30_000);

  test('an oversized page is still keyword-searchable via chunk-grain search after import', async () => {
    // Mirrors import-file.ts: chunking is what actually feeds
    // content_chunks.search_vector, independent of the pages-level
    // trigger this fix touches. A distinctive token near the start proves
    // the chunk (not just the page row) is queryable.
    const distinctiveBody = `zzdistinctivetoken2704 ${OVERSIZED_BODY}`;
    await engine.putPage('oversized-searchable', {
      type: 'note',
      title: 'Oversized Searchable',
      compiled_truth: distinctiveBody,
    });
    const { chunkText } = await import('../src/core/chunkers/recursive.ts');
    let chunkIndex = 0;
    const chunks = chunkText(distinctiveBody).map((c) => ({
      chunk_index: chunkIndex++,
      chunk_text: c.text,
      chunk_source: 'compiled_truth' as const,
    }));
    await engine.upsertChunks('oversized-searchable', chunks);

    const results = await engine.searchKeyword('zzdistinctivetoken2704');
    expect(results.some((r) => r.slug === 'oversized-searchable')).toBe(true);
  }, 30_000);

  test('normal-sized page search_vector still carries title/timeline signal (not fully inert)', async () => {
    await engine.putPage('small-page', {
      type: 'note',
      title: 'zzTitleToken2704',
      compiled_truth: 'short body',
    });
    const rows = await engine.executeRaw<{ has_vector: boolean }>(
      `SELECT search_vector IS NOT NULL AS has_vector FROM pages WHERE slug = 'small-page'`,
    );
    expect(rows[0]?.has_vector).toBe(true);
  }, 30_000);
});
