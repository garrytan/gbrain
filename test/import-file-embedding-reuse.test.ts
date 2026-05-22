import { describe, test, expect } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Minimal mock engine that tracks calls and supports getChunks / transaction.
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };

  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') return overrides.getPage || (() => Promise.resolve(null));
      if (prop === 'getChunks') return overrides.getChunks || (() => Promise.resolve([]));
      // transaction: just call fn with same engine (no real DB transaction)
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

// Helper: do a fresh import to discover what chunk texts the real chunker produces
// for a given content string. Returns the chunk texts (noEmbed=true so no API calls).
async function discoverChunkTexts(content: string, slug: string): Promise<string[]> {
  const engine = mockEngine({ getPage: () => Promise.resolve(null) });
  await importFromContent(engine, slug, content, { noEmbed: true });
  const chunkCall = (engine as any)._calls.find((c: any) => c.method === 'upsertChunks');
  return (chunkCall?.args[1] ?? []).map((c: any) => c.chunk_text as string);
}

describe('importFromContent — body-keyed embedding reuse', () => {
  test('reuses embeddings when chunk text matches, regardless of chunk_index position', async () => {
    // Strategy: first discover what chunk texts the chunker actually produces for
    // our content. Then simulate a re-import where those exact texts are already
    // in the DB (with embeddings), but the page hash is stale so re-import runs.
    // With noEmbed=true, any embedding on the upserted chunks MUST come from
    // the body-keyed reuse map — not from embedBatch.
    const longBody = 'This is a detailed analysis of an important topic. '.repeat(60);
    const content = `---
type: concept
title: Reuse Test Page
---

${longBody}
`;

    const slug = 'concepts/reuse-test';

    // Step 1: discover chunk texts (fresh import, no existing page)
    const chunkTexts = await discoverChunkTexts(content, slug);
    expect(chunkTexts.length).toBeGreaterThanOrEqual(1);

    // Step 2: build fake existing chunks with embeddings, with indices REVERSED
    // to simulate a position shift (e.g. caused by chunker overlap rerouting).
    // The key assertion: body-keyed reuse finds the embedding by text, ignoring index.
    const fakeEmbeddings = chunkTexts.map((_, i) => new Float32Array([i + 1, i + 0.5, i + 0.1]));
    const existingChunksReversed = chunkTexts.map((text, i) => ({
      // Deliberate position shift: existing chunk at reversed index
      chunk_index: chunkTexts.length - 1 - i,
      chunk_text: text,
      embedding: fakeEmbeddings[i],
      token_count: Math.ceil(text.length / 4),
    }));

    // Step 3: re-import with stale hash → code must re-chunk and call upsertChunks.
    // getChunks returns the reversed-index existing chunks with embeddings.
    const engine = mockEngine({
      getPage: () => Promise.resolve({ id: 42, content_hash: 'stale-does-not-match' }),
      getChunks: () => Promise.resolve(existingChunksReversed),
    });

    const result = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(result.status).toBe('imported');

    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    expect(chunkCall).toBeTruthy();

    const upsertedChunks: any[] = chunkCall.args[1];
    expect(upsertedChunks.length).toBe(chunkTexts.length);

    // Every upserted chunk must have an embedding from the reuse map
    for (const uc of upsertedChunks) {
      expect(uc.embedding).toBeDefined();
      // Find which fakeEmbedding corresponds to this chunk text
      const textIndex = chunkTexts.indexOf(uc.chunk_text);
      expect(textIndex).toBeGreaterThanOrEqual(0); // chunk text was in original set
      expect(uc.embedding).toBe(fakeEmbeddings[textIndex]); // same Float32Array reference
    }
  });

  test('leaves chunks without existing text match without embedding when noEmbed=true', async () => {
    // Chunk A text is in the existing map (gets embedding reused).
    // Chunk B text is brand-new (no existing match, noEmbed=true → no embedding).
    // We force this by using content that produces a single chunk, but only
    // supplying the existing embedding for a text that WON'T match any chunk.

    const content = `---
type: concept
title: Partial Match Test
---

This is entirely new content that has no previous embedding in the brain.
`;

    const slug = 'concepts/partial-match';

    // Existing chunks have a DIFFERENT text — so no match
    const unrelatedEmbedding = new Float32Array([9.9, 8.8, 7.7]);
    const existingChunks = [
      {
        chunk_index: 0,
        chunk_text: 'Completely different text that does not appear in the new content at all.',
        embedding: unrelatedEmbedding,
        token_count: 10,
      },
    ];

    const engine = mockEngine({
      getPage: () => Promise.resolve({ id: 43, content_hash: 'stale-partial' }),
      getChunks: () => Promise.resolve(existingChunks),
    });

    const result = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(result.status).toBe('imported');

    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    expect(chunkCall).toBeTruthy();

    const upsertedChunks: any[] = chunkCall.args[1];
    // All chunks have no matching text in the existing map, and noEmbed=true
    // means embedBatch is not called either — so no embedding expected.
    for (const uc of upsertedChunks) {
      expect(uc.embedding).toBeUndefined();
    }
  });

  test('skips getChunks call when there is no existing page', async () => {
    // When existing is null, getChunks must never be called — there is nothing
    // to reuse, and calling getChunks would be wasteful.
    const engine = mockEngine({
      getPage: () => Promise.resolve(null),
      getChunks: () => { throw new Error('getChunks must not be called when there is no existing page'); },
    });

    const content = `---
type: concept
title: Brand New Page
---

Fresh content with nothing to reuse.
`;

    const result = await importFromContent(engine, 'concepts/brand-new', content, { noEmbed: true });
    expect(result.status).toBe('imported');

    // Confirm getChunks was never tracked in calls
    const calls = (engine as any)._calls;
    const getChunksCalls = calls.filter((c: any) => c.method === 'getChunks');
    expect(getChunksCalls.length).toBe(0);
  });
});
