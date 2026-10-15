/**
 * #6721: hybridSearch issues fusion's three candidate reads together.
 *
 * 1. Protects: `fuseArms` (search/hybrid/rank.ts) starts the chunk embeddings
 *    for the cosine re-score and the generated-page rows for provenance
 *    demotion while the unverified-extraction marks are still unanswered.
 * 2. Fails when: `fuseArms` goes back to awaiting the reads one after another
 *    (the embeddings read starting only after the marks answered and RRF ran,
 *    the generated read only after the re-score).
 * 3. Existing coverage: test/search-fusion-prefetch.test.ts pins
 *    `prefetchFusionReads` itself and the demotion parity on prefetched rows.
 * 4. Seam: a fake engine whose marks read answers only once the other two
 *    reads have started (or after a deadline, so a serial fuseArms finishes
 *    and fails the assertion instead of hanging); the gateway's embed transport
 *    returns a fixed vector so the full hybrid path runs with no network.
 */
import { afterEach, expect, test } from 'bun:test';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });

const hit = (page_id: number, chunk_id: number) => ({
  slug: `notes/p${page_id}`, page_id, chunk_id, chunk_index: 0, source_id: 'default', score: 1, title: `P${page_id}`,
  type: 'note', chunk_text: 'orchard telemetry notes', chunk_source: 'compiled_truth', stale: false,
}) as SearchResult;

test('the re-score embeddings and generated-page rows are read before the unverified marks answer', async () => {
  configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'sk-fake' } });
  __setEmbedTransportForTests((async () => ({ embeddings: [Array.from({ length: 1024 }, () => 0.1)] })) as any);
  const startedBeforeMarks = new Set<string>();
  let marksAnswered = false;
  let othersStarted = () => {};
  const bothStarted = new Promise<void>((resolve) => { othersStarted = resolve; });
  const note = (read: string) => {
    if (!marksAnswered) startedBeforeMarks.add(read);
    if (startedBeforeMarks.size === 2) othersStarted();
  };
  const engine = {
    kind: 'pglite',
    getConfig: async () => null,
    executeRaw: async (sql: string) => { if (sql.includes('dream_generated')) note('generated'); return []; },
    resolveAliases: async () => new Map(),
    getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(),
    getUnverifiedExtractionPageIds: async () => {
      await Promise.race([bothStarted, new Promise((resolve) => setTimeout(resolve, 300))]);
      marksAnswered = true;
      return new Map();
    },
    getEmbeddingsByChunkIds: async () => { note('embeddings'); return new Map(); },
    relationalFanout: async () => [],
    searchVector: async () => [hit(1, 10), hit(2, 20)],
    searchKeyword: async () => [hit(1, 10)],
    searchTitles: async () => [],
  } as unknown as BrainEngine;
  const results = await hybridSearch(engine, 'orchard telemetry notes', { limit: 5 });
  expect(results.map((r) => r.page_id).sort()).toEqual([1, 2]);
  expect([...startedBeforeMarks].sort()).toEqual(['embeddings', 'generated']);
});
